import { type INestApplication } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { addDaysToBusinessDate, businessDateInZone } from '@bp/domain';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertDatabaseNameIsTest,
  assertEnvConnectionsTargetTestDatabase,
  assertTestDatabaseUrls,
} from '../../../tools/test-db-guard.mjs';
import { AppModule } from './app.module';
import { PrismaService } from './database/prisma.service';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { InvoiceService } from './invoices/invoice.service';
import { LOG_STREAM } from './logging/logging.module';

const runId = randomUUID().slice(0, 8);
/** Fictional: all zeros, not a registered number. */
const SELLER_VAT = 'CY00000000X';
/** The ISO 13616 registry's example IBAN for Cyprus. Not a real account. */
const IBAN_CY = 'CY17 0020 0128 0000 0012 0052 7600';
const TIMEZONE = 'Asia/Nicosia';

type Agent = ReturnType<typeof request.agent>;
type Session = { agent: Agent; xsrf: string };

let app: INestApplication | undefined;
let storageRoot = '';

/**
 * Issued documents are never deleted and they lock the company currency, so every run
 * issues in a company of its own, created here, and leaves the seeded companies alone.
 */
describe('issuing invoices', () => {
  let company = '';
  let admin: Session;
  let clientId = '';
  let standardTax = '';
  let seriesId = '';
  let prefix = '';

  beforeAll(async () => {
    const refusal = assertTestDatabaseUrls();
    if (refusal) {
      throw new Error(refusal);
    }
    await assertEnvConnectionsTargetTestDatabase();
    seedDatabase();
    storageRoot = mkdtempSync(join(tmpdir(), 'bp-r2c2-store-'));
    process.env.STORAGE_ROOT = storageRoot;
    process.env.APP_ENV = 'test';
    process.env.AUTH_DEV_LOGIN_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECURE = 'false';
    process.env.CSRF_SECRET = 'integration-test-csrf-secret';
    process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED = 'false';
    delete process.env.THROTTLE_ENABLED_IN_TEST;
    app = await bootApp();
    const prisma = app.get(PrismaService);
    const databases = await prisma.client.$queryRaw<{ current_database: string }[]>`
      SELECT current_database() AS current_database
    `;
    assertDatabaseNameIsTest(databases[0]?.current_database, 'DATABASE_URL');

    const owner = await login(started(), 'owner@example.test');
    const created = await send(owner, 'post', '/api/platform/companies', cid('company'), {
      legalName: `Issue test ${runId} Ltd (fictional)`,
      tradingName: `Issue test ${runId}`,
      isFictional: true,
    });
    expect(created.status, text(created)).toBe(200);
    company = stringField(record(record(created.body).company), 'id');
    // A user of this run only, so the seeded users' company lists stay as other tests expect.
    const issuer = `issuer.${runId}@example.test`;
    await createDevUser(issuer);
    await grantCompanyAdmin(company, issuer, 'owner@example.test');
    admin = await login(started(), issuer);

    standardTax = (
      await inCompany(company, (tx) =>
        tx.taxCode.findFirstOrThrow({ where: { companyId: company, code: 'STD19' } }),
      )
    ).id;
    prefix = `T${runId}-`;
    seriesId = await createSeries(prefix, 'inv');
    const details = await send(admin, 'patch', `/api/c/${company}/company`, cid('details'), {
      expectedVersion: await companyVersion(company),
      vatNumber: SELLER_VAT,
      address: { line1: '1 Demo Street', city: 'Nicosia', postcode: '1010', countryCode: 'CY' },
      invoiceTermsEn: 'Payment within 30 days (fictional terms).',
      defaultInvoiceSeriesId: seriesId,
    });
    expect(details.status, text(details)).toBe(200);
    clientId = await createClient(`Issue client ${runId}`, null, 'CY');
    await setIssuing(true, 'set-up');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    if (storageRoot) {
      rmSync(storageRoot, { recursive: true, force: true });
    }
    delete process.env.STORAGE_ROOT;
  });

  it('issues a draft with a number, dates, a frozen snapshot and a sealed PDF', async () => {
    const before = await seriesRow(seriesId);
    const draft = await createDraft({ pricesIncludeTax: true, unitPrice: '11.90' });
    const correlationId = cid('issue-first');
    const issued = await issue(draft.id, draft.version, correlationId);
    expect(issued.status, text(issued)).toBe(200);
    const invoice = record(record(issued.body).invoice);
    const today = businessDateInZone(new Date(), TIMEZONE);
    const number = `${prefix}${String(before.nextNumber).padStart(4, '0')}`;
    expect(invoice).toMatchObject({
      status: 'issued',
      number,
      issueDate: today,
      supplyDate: today,
      dueDate: addDaysToBusinessDate(today, 30),
      deliveryDeadline: addDaysToBusinessDate(today, 30),
      netTotal: '10.00',
      taxTotal: '1.90',
      total: '11.90',
      version: draft.version + 1,
    });
    expect(arrayOf(record(issued.body).warnings)).toEqual([]);
    // The issue date and the issue timestamp come from one instant.
    expect(businessDateInZone(new Date(stringField(invoice, 'issuedAt')), TIMEZONE)).toBe(
      stringField(invoice, 'issueDate'),
    );

    const row = await invoiceRow(draft.id);
    expect(row.renderVersion).toBe(1);
    expect(record(row.sellerSnapshot)).toMatchObject({
      legalName: `Issue test ${runId} Ltd (fictional)`,
      vatNumber: SELLER_VAT,
    });
    expect(record(row.buyerSnapshot)).toMatchObject({
      clientId,
      displayName: `Issue client ${runId}`,
    });
    expect(row.termsSnapshot).toBe('Payment within 30 days (fictional terms).');
    expect(row.lines.map((line) => record(line.taxSnapshot).code)).toEqual(['STD19']);
    expect(row.taxSummary.map((summary) => record(summary.taxSnapshot).deadlineRule)).toEqual([
      'days_30',
    ]);
    const file = await inCompany(company, (tx) =>
      tx.storedFile.findUniqueOrThrow({ where: { id: row.pdfFileId ?? '' } }),
    );
    expect(file).toMatchObject({
      kind: 'invoice_pdf',
      sealed: true,
      sourceType: 'invoice',
      sourceId: draft.id,
    });
    expect(await seriesRow(seriesId)).toEqual({
      nextNumber: before.nextNumber + 1,
      version: before.version + 1,
    });

    const pdf = await fetchPdf(draft.id, cid('issue-first-pdf'));
    expect(pdf.status).toBe(200);
    const bytes = pdf.body as Buffer;
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    expect(String(pdf.headers['content-disposition'])).toContain(`${number}.pdf`);
    const pdfText = flatten(await extractPdfText(bytes));
    expect(pdfText).toContain(flatten(`Invoice ${number}`));
    expect(pdfText).toContain(flatten(`Date of supply: ${today}`));
    expect(pdfText).toContain('Unitpriceexcl.VAT');
    // €11.90 including 19 % VAT prints €10.00 as the VAT-exclusive unit price.
    expect(pdfText).toContain('box10.00');
    expect(pdfText).not.toContain('11.9000');
    expect(pdfText).not.toContain(flatten('DRAFT – NOT A TAX INVOICE'));

    const audit = await auditEvents(correlationId);
    const issuedEvent = audit.find((event) => event.action === 'invoice.issued');
    expect(issuedEvent?.outcome).toBe('success');
    expect(record(issuedEvent?.details)).toMatchObject({ number, total: '11.90' });
  });

  it('refuses while a switch is off, audits a denial, and changes nothing', async () => {
    const draft = await createDraft();
    const before = await seriesRow(seriesId);
    await setIssuing(false, 'switch-off');
    try {
      const correlationId = cid('issue-off');
      const refused = await issue(draft.id, draft.version, correlationId);
      expect(refused.status).toBe(409);
      expect(errorCode(refused.body)).toBe('issuance_disabled');
      const audit = await auditEvents(correlationId);
      expect(audit.map((event) => [event.action, event.outcome])).toEqual([
        ['invoice.issue', 'denied'],
      ]);
    } finally {
      await setIssuing(true, 'switch-on');
    }
    expect((await invoiceRow(draft.id)).status).toBe('draft');
    expect(await seriesRow(seriesId)).toEqual(before);
  });

  it('names the missing particulars and refuses a draft in another currency', async () => {
    const reverse = await send(admin, 'post', `/api/c/${company}/tax-codes`, cid('rc-code'), {
      code: `RC${runId}`.slice(0, 32),
      name: 'Reverse charge (fictional)',
      ratePercent: '0',
      kind: 'reverse_charge',
      noteEn: 'Reverse charge',
    });
    expect(reverse.status, text(reverse)).toBe(200);
    const reverseId = stringField(record(record(reverse.body).taxCode), 'id');
    const draft = await createDraft({ taxCodeId: reverseId });
    const incomplete = await issue(draft.id, draft.version, cid('issue-incomplete'));
    expect(incomplete.status).toBe(422);
    expect(record(record(incomplete.body).error)).toMatchObject({
      code: 'invoice_incomplete',
      fields: ['buyer.vatNumber', 'lines.1.legalNote'],
    });

    const later = await createDraft({
      supplyDate: addDaysToBusinessDate(businessDateInZone(new Date(), TIMEZONE), 1),
    });
    const future = await issue(later.id, later.version, cid('issue-future'));
    expect(future.status).toBe(422);
    expect(record(record(future.body).error).fields).toEqual(['supplyDate.afterIssue']);

    const empty = await createDraft();
    await inCompany(company, async (tx) => {
      await tx.invoiceTaxSummary.deleteMany({ where: { invoiceId: empty.id } });
      await tx.invoiceLine.deleteMany({ where: { invoiceId: empty.id } });
    });
    const noLines = await issue(empty.id, empty.version, cid('issue-empty'));
    expect(noLines.status).toBe(422);
    expect(record(record(noLines.body).error).fields).toEqual(['lines']);

    const blank = await createDraft({ description: '   ' });
    const unnamed = await issue(blank.id, blank.version, cid('issue-blank'));
    expect(unnamed.status).toBe(422);
    expect(record(record(unnamed.body).error).fields).toEqual(['lines.1.description']);

    // A line whose rate no longer matches its code (impossible through the API) is refused.
    const changed = await createDraft();
    await inCompany(company, (tx) =>
      tx.invoiceLine.updateMany({
        where: { invoiceId: changed.id },
        data: { taxRatePercent: '9.0000' },
      }),
    );
    const rate = await issue(changed.id, changed.version, cid('issue-rate'));
    expect(rate.status).toBe(409);
    expect(errorCode(rate.body)).toBe('tax_code_changed');

    const usd = await createDraft();
    await inCompany(company, (tx) =>
      tx.invoice.update({ where: { id: usd.id }, data: { currency: 'USD' } }),
    );
    const refused = await issue(usd.id, usd.version, cid('issue-usd'));
    expect(refused.status).toBe(422);
    expect(errorCode(refused.body)).toBe('currency_not_supported');
    expect((await invoiceRow(usd.id)).status).toBe('draft');
  });

  it('warns about a late invoice and still issues it', async () => {
    const supplyDate = addDaysToBusinessDate(businessDateInZone(new Date(), TIMEZONE), -60);
    const draft = await createDraft({ supplyDate });
    const correlationId = cid('issue-late');
    const issued = await issue(draft.id, draft.version, correlationId);
    expect(issued.status, text(issued)).toBe(200);
    expect(arrayOf(record(issued.body).warnings)).toEqual(['delivery_deadline_passed']);
    expect(record(record(issued.body).invoice)).toMatchObject({
      supplyDate,
      deliveryDeadline: addDaysToBusinessDate(supplyDate, 30),
    });
    const audit = await auditEvents(correlationId);
    expect(record(audit.find((event) => event.action === 'invoice.issued')?.details).late).toBe(
      true,
    );
  });

  it('gives 20 concurrent issues in one series the numbers 1 to 20, each once', async () => {
    const racePrefix = `R${runId}-`;
    const raceSeries = await createSeries(racePrefix, 'race');
    await setDefaultSeries(raceSeries, 'race-default');
    try {
      const drafts = [];
      for (let index = 0; index < 20; index += 1) {
        drafts.push(await createDraft());
      }
      const responses = await Promise.all(
        drafts.map((draft, index) => issue(draft.id, draft.version, cid(`race-${String(index)}`))),
      );
      expect(responses.map((response) => response.status)).toEqual(Array(20).fill(200));
      const numbers = responses
        .map((response) => stringField(record(record(response.body).invoice), 'number'))
        .sort();
      expect(numbers).toEqual(
        Array.from(
          { length: 20 },
          (_, index) => `${racePrefix}${String(index + 1).padStart(4, '0')}`,
        ),
      );
      expect((await seriesRow(raceSeries)).nextNumber).toBe(21);
    } finally {
      await setDefaultSeries(seriesId, 'race-restore');
    }
  });

  it('lets exactly one of two concurrent issues of one draft win', async () => {
    const draft = await createDraft();
    const responses = await Promise.all([
      issue(draft.id, draft.version, cid('twice-a')),
      issue(draft.id, draft.version, cid('twice-b')),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const loser = responses.find((response) => response.status === 409);
    expect(['not_draft', 'conflict']).toContain(errorCode(loser?.body));
  });

  it('consumes no number when the issue fails after the number is allocated', async () => {
    const draft = await createDraft();
    const before = await seriesRow(seriesId);
    const service = started().get(InvoiceService);
    service.hooks = {
      afterNumberAllocated: () => Promise.reject(new Error('forced failure after allocation')),
    };
    try {
      const failed = await issue(draft.id, draft.version, cid('issue-forced'));
      expect(failed.status).toBe(500);
    } finally {
      service.hooks = null;
    }
    expect(await seriesRow(seriesId)).toEqual(before);
    const row = await invoiceRow(draft.id);
    expect(row.status).toBe('draft');
    expect(row.number).toBeNull();
  });

  it('gives a series edit that races an issue a 409', async () => {
    const draft = await createDraft();
    const { version } = await seriesRow(seriesId);
    const service = started().get(InvoiceService);
    let edit: Promise<request.Response> | undefined;
    service.hooks = {
      afterNumberAllocated: async () => {
        edit = send(
          admin,
          'patch',
          `/api/c/${company}/invoice-series/${seriesId}`,
          cid('race-edit'),
          {
            expectedVersion: version,
            code: `E${runId}`,
          },
        ).then((response) => response);
        await waitForLockWaiter('invoice_series');
      },
    };
    try {
      const issued = await issue(draft.id, draft.version, cid('race-edit-issue'));
      expect(issued.status, text(issued)).toBe(200);
    } finally {
      service.hooks = null;
    }
    const edited = await edit;
    expect(edited?.status).toBe(409);
  });

  it('keeps an issued document, its lines and its PDF row unchangeable for the application', async () => {
    const draft = await createDraft();
    const issued = await issue(draft.id, draft.version, cid('immutable'));
    expect(issued.status, text(issued)).toBe(200);
    const row = await invoiceRow(draft.id);
    await expect(
      inCompany(company, (tx) =>
        tx.invoice.update({ where: { id: draft.id }, data: { notes: 'tamper' } }),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      inCompany(company, (tx) =>
        tx.invoiceLine.update({
          where: { id: row.lines[0]?.id ?? '' },
          data: { description: 'tamper' },
        }),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      inCompany(company, (tx) =>
        tx.storedFile.update({
          where: { id: row.pdfFileId ?? '' },
          data: { sha256: '0'.repeat(64) },
        }),
      ),
    ).rejects.toThrow(/sealed stored file is immutable/);
    await expect(
      inCompany(company, (tx) => tx.storedFile.delete({ where: { id: row.pdfFileId ?? '' } })),
    ).rejects.toThrow(/sealed stored file is immutable/);
    const patched = await send(
      admin,
      'patch',
      `/api/c/${company}/invoices/${draft.id}`,
      cid('immutable-patch'),
      {
        expectedVersion: draft.version + 1,
        notes: 'edit after issue',
      },
    );
    expect(patched.status).toBe(409);
    expect(errorCode(patched.body)).toBe('not_draft');
    const again = await issue(draft.id, draft.version + 1, cid('immutable-again'));
    expect(again.status).toBe(409);
    expect(errorCode(again.body)).toBe('not_draft');
  });

  it('keeps the snapshot and the PDF bytes when the client, company, tax code and bank change', async () => {
    const bank = await send(admin, 'post', `/api/c/${company}/bank-accounts`, cid('bank'), {
      bankName: 'Fictional Bank',
      accountHolder: `Issue test ${runId} Ltd (fictional)`,
      iban: IBAN_CY,
      shownOnInvoices: true,
    });
    expect(bank.status, text(bank)).toBe(200);
    const bankAccount = record(record(bank.body).bankAccount);
    const draft = await createDraft();
    const issued = await issue(draft.id, draft.version, cid('frozen'));
    expect(issued.status, text(issued)).toBe(200);
    const before = await invoiceRow(draft.id);
    expect(record(before.bankSnapshot)).toMatchObject({ bankName: 'Fictional Bank' });
    const pdfBefore = (await fetchPdf(draft.id, cid('frozen-pdf-1'))).body as Buffer;

    const client = await send(
      admin,
      'get',
      `/api/c/${company}/clients/${clientId}`,
      cid('frozen-client'),
    );
    const clientVersion = numberField(record(record(client.body).client), 'version');
    expect(
      (
        await send(
          admin,
          'patch',
          `/api/c/${company}/clients/${clientId}`,
          cid('frozen-client-edit'),
          {
            expectedVersion: clientVersion,
            displayName: `Renamed client ${runId}`,
          },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await send(admin, 'patch', `/api/c/${company}/company`, cid('frozen-company-edit'), {
          expectedVersion: await companyVersion(company),
          legalName: `Renamed ${runId} Ltd (fictional)`,
          invoiceTermsEn: 'Changed terms (fictional).',
        })
      ).status,
    ).toBe(200);
    const tax = await inCompany(company, (tx) =>
      tx.taxCode.findUniqueOrThrow({ where: { id: standardTax } }),
    );
    expect(
      (
        await send(
          admin,
          'patch',
          `/api/c/${company}/tax-codes/${standardTax}`,
          cid('frozen-tax-edit'),
          {
            expectedVersion: tax.version,
            name: 'Renamed standard rate',
          },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await send(
          admin,
          'patch',
          `/api/c/${company}/bank-accounts/${stringField(bankAccount, 'id')}`,
          cid('frozen-bank-edit'),
          { expectedVersion: numberField(bankAccount, 'version'), bankName: 'Renamed Bank' },
        )
      ).status,
    ).toBe(200);

    const after = await invoiceRow(draft.id);
    expect(after.sellerSnapshot).toEqual(before.sellerSnapshot);
    expect(after.buyerSnapshot).toEqual(before.buyerSnapshot);
    expect(after.bankSnapshot).toEqual(before.bankSnapshot);
    expect(after.termsSnapshot).toBe(before.termsSnapshot);
    expect(after.lines.map((line) => line.taxSnapshot)).toEqual(
      before.lines.map((line) => line.taxSnapshot),
    );
    const pdfAfter = (await fetchPdf(draft.id, cid('frozen-pdf-2'))).body as Buffer;
    expect(pdfAfter.equals(pdfBefore)).toBe(true);
  });

  it('refuses to serve a tampered issued PDF and audits it', async () => {
    const draft = await createDraft();
    const issued = await issue(draft.id, draft.version, cid('tamper'));
    expect(issued.status, text(issued)).toBe(200);
    const row = await invoiceRow(draft.id);
    const file = await inCompany(company, (tx) =>
      tx.storedFile.findUniqueOrThrow({ where: { id: row.pdfFileId ?? '' } }),
    );
    const path = join(storageRoot, file.storageKey);
    const bytes = await readFile(path);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
    await writeFile(path, bytes);
    const correlationId = cid('tamper-pdf');
    const refused = await fetchPdf(draft.id, correlationId);
    expect(refused.status).toBe(409);
    const body = (refused.body as Buffer).toString('utf8');
    expect(body).not.toContain('%PDF');
    expect(errorCode(JSON.parse(body))).toBe('file_integrity_failed');
    const audit = await auditEvents(correlationId);
    expect(audit.map((event) => [event.action, event.outcome, event.objectId])).toEqual([
      ['file.integrity_failed', 'failure', file.id],
    ]);
  });

  it('refuses quotes, and locks the company currency once a document is issued', async () => {
    const quote = await createDraft({ documentType: 'quote' });
    const refused = await issue(quote.id, quote.version, cid('quote'));
    expect(refused.status).toBe(409);
    expect(errorCode(refused.body)).toBe('not_issuable');
    const currency = await send(admin, 'patch', `/api/c/${company}/company`, cid('currency'), {
      expectedVersion: await companyVersion(company),
      defaultCurrency: 'USD',
    });
    expect(currency.status).toBe(409);
    expect(errorCode(currency.body)).toBe('currency_locked');
  });

  it('records deliveries: paper keeps its copy, e-mail needs consent, dates are checked', async () => {
    const draft = await createDraft();
    const issued = await issue(draft.id, draft.version, cid('deliver'));
    expect(issued.status, text(issued)).toBe(200);
    const today = businessDateInZone(new Date(), TIMEZONE);
    const deliver = (body: Record<string, unknown>, name: string) =>
      send(admin, 'post', `/api/c/${company}/invoices/${draft.id}/deliveries`, cid(name), body);
    expect(await pendingIds()).toContain(draft.id);

    const refusals: [Record<string, unknown>, number, string][] = [
      [{ method: 'handed_over', deliveredOn: today }, 422, 'paper_copy_required'],
      [{ method: 'posted', deliveredOn: today, paperCopyKept: false }, 422, 'paper_copy_required'],
      [
        { method: 'other', deliveredOn: addDaysToBusinessDate(today, 1) },
        422,
        'delivered_in_future',
      ],
      [
        { method: 'other', deliveredOn: addDaysToBusinessDate(today, -1) },
        422,
        'delivered_before_issue',
      ],
      [{ method: 'emailed_outside_platform', deliveredOn: today }, 409, 'e_invoice_not_accepted'],
    ];
    for (const [index, [body, status, code]] of refusals.entries()) {
      const refused = await deliver(body, `deliver-refused-${String(index)}`);
      expect(refused.status, text(refused)).toBe(status);
      expect(errorCode(refused.body)).toBe(code);
    }
    expect(await pendingIds()).toContain(draft.id);

    const client = await send(
      admin,
      'get',
      `/api/c/${company}/clients/${clientId}`,
      cid('consent-get'),
    );
    const consent = await send(
      admin,
      'patch',
      `/api/c/${company}/clients/${clientId}`,
      cid('consent'),
      {
        expectedVersion: numberField(record(record(client.body).client), 'version'),
        acceptsEInvoices: true,
      },
    );
    expect(consent.status, text(consent)).toBe(200);
    const emailed = await deliver(
      { method: 'emailed_outside_platform', deliveredOn: today },
      'deliver-email',
    );
    expect(emailed.status, text(emailed)).toBe(200);
    expect(arrayOf(record(emailed.body).warnings)).toEqual([]);

    const note = 'Posted with tracking (demo)\n  second line, kept as typed ';
    const correlationId = cid('deliver-paper');
    const posted = await deliver(
      { method: 'posted', deliveredOn: today, paperCopyKept: true, note },
      'deliver-paper',
    );
    expect(posted.status, text(posted)).toBe(200);
    const invoice = record(record(posted.body).invoice);
    expect(invoice.lastDeliveredOn).toBe(today);
    expect(arrayOf(invoice.deliveries).map((entry) => record(entry).method)).toEqual([
      'emailed_outside_platform',
      'posted',
    ]);
    expect(record(record(posted.body).delivery)).toMatchObject({ paperCopyKept: true, note });
    expect(await pendingIds()).not.toContain(draft.id);
    const audit = await auditEvents(correlationId);
    expect(audit.map((event) => [event.action, event.outcome])).toEqual([
      ['invoice.delivery_recorded', 'success'],
    ]);

    const other = await createDraft();
    const notIssued = await send(
      admin,
      'post',
      `/api/c/${company}/invoices/${other.id}/deliveries`,
      cid('deliver-draft'),
      { method: 'other', deliveredOn: today },
    );
    expect(notIssued.status).toBe(409);
    expect(errorCode(notIssued.body)).toBe('not_issued');
  });

  it('warns when the delivery is after the deadline', async () => {
    const supplyDate = addDaysToBusinessDate(businessDateInZone(new Date(), TIMEZONE), -45);
    const draft = await createDraft({ supplyDate });
    const issued = await issue(draft.id, draft.version, cid('deliver-late-issue'));
    expect(issued.status, text(issued)).toBe(200);
    const late = await send(
      admin,
      'post',
      `/api/c/${company}/invoices/${draft.id}/deliveries`,
      cid('deliver-late'),
      { method: 'other', deliveredOn: businessDateInZone(new Date(), TIMEZONE) },
    );
    expect(late.status, text(late)).toBe(200);
    expect(arrayOf(record(late.body).warnings)).toEqual(['delivered_after_deadline']);
  });

  async function pendingIds(): Promise<string[]> {
    const response = await send(
      admin,
      'get',
      `/api/c/${company}/invoices?delivery=pending`,
      cid('pending'),
    );
    expect(response.status, text(response)).toBe(200);
    return arrayOf(record(response.body).invoices).map((entry) => stringField(record(entry), 'id'));
  }

  async function createDraft(
    options: {
      pricesIncludeTax?: boolean;
      unitPrice?: string;
      supplyDate?: string;
      taxCodeId?: string;
      description?: string;
      documentType?: 'quote';
    } = {},
  ): Promise<{ id: string; version: number }> {
    const response = await send(admin, 'post', `/api/c/${company}/invoices`, cid('draft'), {
      clientId,
      pricesIncludeTax: options.pricesIncludeTax ?? false,
      ...(options.documentType ? { documentType: options.documentType } : {}),
      ...(options.supplyDate ? { supplyDate: options.supplyDate } : {}),
      lines: [
        {
          position: 1,
          description: options.description ?? 'Mixed nuts gift box (demo)',
          quantity: '1',
          unit: 'box',
          unitPrice: options.unitPrice ?? '10.00',
          taxCodeId: options.taxCodeId ?? standardTax,
        },
      ],
    });
    expect(response.status, text(response)).toBe(200);
    const invoice = record(record(response.body).invoice);
    return { id: stringField(invoice, 'id'), version: numberField(invoice, 'version') };
  }

  function issue(id: string, version: number, correlationId: string) {
    return send(admin, 'post', `/api/c/${company}/invoices/${id}/issue`, correlationId, {
      expectedVersion: version,
    });
  }

  function fetchPdf(id: string, correlationId: string) {
    return admin.agent
      .get(`/api/c/${company}/invoices/${id}/pdf`)
      .set('X-XSRF-TOKEN', admin.xsrf)
      .set('X-Correlation-Id', correlationId)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        });
        res.on('end', () => {
          callback(null, Buffer.concat(chunks));
        });
      });
  }

  async function createSeries(seriesPrefix: string, name: string): Promise<string> {
    const response = await send(
      admin,
      'post',
      `/api/c/${company}/invoice-series`,
      cid(`series-${name}`),
      {
        code: `${name}-${runId}`.slice(0, 32),
        documentType: 'invoice',
        prefix: seriesPrefix,
      },
    );
    expect(response.status, text(response)).toBe(200);
    return stringField(record(record(response.body).series), 'id');
  }

  async function setDefaultSeries(id: string, name: string): Promise<void> {
    const response = await send(admin, 'patch', `/api/c/${company}/company`, cid(name), {
      expectedVersion: await companyVersion(company),
      defaultInvoiceSeriesId: id,
    });
    expect(response.status, text(response)).toBe(200);
  }

  async function createClient(name: string, vatNumber: string | null, countryCode: string) {
    const response = await send(admin, 'post', `/api/c/${company}/clients`, cid('client'), {
      kind: 'organisation',
      displayName: name,
      ...(vatNumber ? { vatNumber } : {}),
      addresses: [
        {
          kind: 'billing',
          line1: '2 Demo Warehouse',
          city: 'Limassol',
          countryCode,
          isDefault: true,
        },
      ],
    });
    expect(response.status, text(response)).toBe(200);
    return stringField(record(record(response.body).client), 'id');
  }

  async function setIssuing(enabled: boolean, name: string): Promise<void> {
    const response = await admin.agent
      .put(`/api/c/${company}/automation/switches/invoice.issue_real`)
      .set('X-XSRF-TOKEN', admin.xsrf)
      .set('X-Correlation-Id', cid(`switch-${name}`))
      .send({ enabled, reason: `issue test ${name}` });
    expect(response.status, text(response)).toBe(200);
  }

  function invoiceRow(id: string) {
    return inCompany(company, (tx) =>
      tx.invoice.findUniqueOrThrow({
        where: { id },
        include: {
          lines: { orderBy: { position: 'asc' } },
          taxSummary: true,
        },
      }),
    );
  }

  async function seriesRow(id: string): Promise<{ nextNumber: number; version: number }> {
    return inCompany(company, (tx) =>
      tx.invoiceSeries.findUniqueOrThrow({
        where: { id },
        select: { nextNumber: true, version: true },
      }),
    );
  }

  async function companyVersion(id: string): Promise<number> {
    const row = await inCompany(id, (tx) =>
      tx.company.findUniqueOrThrow({ where: { id }, select: { version: true } }),
    );
    return row.version;
  }

  function auditEvents(correlationId: string) {
    return inCompany(company, (tx) =>
      tx.auditEvent.findMany({ where: { correlationId }, orderBy: { occurredAt: 'asc' } }),
    );
  }
});

/** A user who can sign in with the development login. Fictional `.test` address. */
async function createDevUser(email: string): Promise<void> {
  await started()
    .get(PrismaService)
    .client.userAccount.create({
      data: {
        email,
        displayName: `Issuer ${runId}`,
        identities: {
          create: {
            provider: 'dev',
            issuer: 'https://dev-login.invalid',
            subject: email,
            emailAtLink: email,
          },
        },
      },
    });
}

/** Makes the user an active company admin (CA) of a company created in this run. */
async function grantCompanyAdmin(
  companyId: string,
  email: string,
  grantedBy: string,
): Promise<void> {
  const prisma = started().get(PrismaService);
  const user = await prisma.client.userAccount.findFirstOrThrow({ where: { email } });
  const granter = await prisma.client.userAccount.findFirstOrThrow({ where: { email: grantedBy } });
  await inCompany(companyId, async (tx) => {
    const role = await tx.role.findFirstOrThrow({ where: { companyId, key: 'CA' } });
    const membership = await tx.membership.create({
      data: { userId: user.id, companyId, status: 'active' },
    });
    await tx.membershipRole.create({
      data: {
        membershipId: membership.id,
        roleId: role.id,
        scopeType: 'company',
        grantedById: granter.id,
      },
    });
  });
}

/** Waits until another session is blocked on a row lock in this table. */
async function waitForLockWaiter(table: string): Promise<void> {
  const prisma = started().get(PrismaService);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await prisma.client.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE ${`%${table}%`}
    `;
    if ((waiting[0]?.count ?? 0) > 0) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`nothing waited on ${table}`);
}

async function extractPdfText(pdf: Buffer): Promise<string> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
    getDocument: (src: { data: Uint8Array; isEvalSupported?: boolean }) => {
      promise: Promise<{
        numPages: number;
        getPage: (page: number) => Promise<{
          getTextContent: () => Promise<{ items: { str?: string }[] }>;
        }>;
      }>;
    };
  };
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), isEvalSupported: false })
    .promise;
  const parts: string[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (typeof item.str === 'string') {
        parts.push(item.str);
      }
    }
  }
  return parts.join('');
}

function flatten(value: string): string {
  return value.replace(/\s+/g, '');
}

function started(): INestApplication {
  if (!app) {
    throw new Error('app is not started');
  }
  return app;
}

async function bootApp(): Promise<INestApplication> {
  const stream = new Writable({
    write(_chunk: Buffer | string, _encoding, callback) {
      callback();
    },
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LOG_STREAM)
    .useValue(stream)
    .compile();
  const application = moduleRef.createNestApplication(caseSensitiveAdapter(), {
    bodyParser: false,
    abortOnError: false,
  });
  application.useLogger(application.get(Logger));
  configureHttp(application);
  await application.init();
  return application;
}

function seedDatabase(): void {
  const root = resolve(process.cwd(), '../..');
  const result = spawnSync('pnpm', ['--filter', '@bp/db', 'seed'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`seed exited ${String(result.status ?? result.signal)}`);
  }
}

async function login(application: INestApplication, email: string): Promise<Session> {
  const agent = request.agent(application.getHttpServer() as App);
  const response = await agent.post('/api/auth/dev/login').send({ email });
  expect(response.status, text(response)).toBe(200);
  return { agent, xsrf: cookieValue(cookieHeader(response, 'XSRF-TOKEN'), 'XSRF-TOKEN') };
}

function send(
  session: Session,
  method: 'get' | 'post' | 'patch',
  url: string,
  correlationId: string,
  payload?: unknown,
) {
  const call = session.agent[method](url)
    .set('X-XSRF-TOKEN', session.xsrf)
    .set('X-Correlation-Id', correlationId);
  if (payload !== undefined) {
    call.send(payload as object);
  }
  return call;
}

function cid(name: string): string {
  return `iss-${name}-${runId}`.slice(0, 64);
}

function inCompany<T>(companyId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return new TenantDb(started().get(PrismaService).client).run(
    { companyId, actor: 'invoice-issue-test', correlationId: randomUUID() },
    fn,
  );
}

function text(response: request.Response): string {
  return Buffer.isBuffer(response.body)
    ? response.body.toString('utf8').slice(0, 500)
    : JSON.stringify(response.body);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('expected an object');
  }
  return value as Record<string, unknown>;
}

function arrayOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('expected an array');
  }
  return value;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`${key} is missing`);
  }
  return field;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== 'number') {
    throw new Error(`${key} is missing`);
  }
  return field;
}

function errorCode(body: unknown): string | undefined {
  const code = record(record(body).error).code;
  return typeof code === 'string' ? code : undefined;
}

function cookieHeader(response: request.Response, name: string): string {
  const header = response.headers['set-cookie'];
  const lines = header === undefined ? [] : typeof header === 'string' ? [header] : [...header];
  const found = lines.find((line) => line.startsWith(`${name}=`));
  if (!found) {
    throw new Error(`cookie ${name} was not set`);
  }
  return found;
}

function cookieValue(header: string, name: string): string {
  const value = header.slice(name.length + 1).split(';')[0];
  if (!value) {
    throw new Error(`cookie ${name} is empty`);
  }
  return value;
}
