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
import type { MockPrintProvider } from '@bp/integrations';
import { AppModule } from './app.module';
import { JobRunner } from './automation/jobs/job-runner';
import { PrismaService } from './database/prisma.service';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { InvoiceService } from './invoices/invoice.service';
import { LOG_STREAM } from './logging/logging.module';
import { MOCK_PRINT_PROVIDER } from './printing/print.tokens';

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
let mockRoot = '';

/**
 * Issued documents are never deleted and they lock the company currency, so every run
 * issues in a company of its own, created here, and leaves the seeded companies alone.
 */
describe('issuing invoices', () => {
  let company = '';
  let admin: Session;
  let owner: Session;
  let clientId = '';
  let standardTax = '';
  let seriesId = '';
  let prefix = '';
  let creditSeriesId = '';
  let creditPrefix = '';

  beforeAll(async () => {
    const refusal = assertTestDatabaseUrls();
    if (refusal) {
      throw new Error(refusal);
    }
    await assertEnvConnectionsTargetTestDatabase();
    seedDatabase();
    storageRoot = mkdtempSync(join(tmpdir(), 'bp-r2c2-store-'));
    process.env.STORAGE_ROOT = storageRoot;
    mockRoot = mkdtempSync(join(tmpdir(), 'bp-r2c3-print-'));
    process.env.MOCK_PRINT_ROOT = mockRoot;
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

    owner = await login(started(), 'owner@example.test');
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
    await grantRole(company, issuer, 'CA', 'owner@example.test');
    admin = await login(started(), issuer);

    standardTax = (
      await inCompany(company, (tx) =>
        tx.taxCode.findFirstOrThrow({ where: { companyId: company, code: 'STD19' } }),
      )
    ).id;
    prefix = `T${runId}-`;
    seriesId = await createSeries(prefix, 'inv');
    creditPrefix = `C${runId}-`;
    creditSeriesId = await createSeries(creditPrefix, 'cn', 'credit_note');
    const details = await send(admin, 'patch', `/api/c/${company}/company`, cid('details'), {
      expectedVersion: await companyVersion(company),
      vatNumber: SELLER_VAT,
      address: { line1: '1 Demo Street', city: 'Nicosia', postcode: '1010', countryCode: 'CY' },
      invoiceTermsEn: 'Payment within 30 days (fictional terms).',
      defaultInvoiceSeriesId: seriesId,
      defaultCreditNoteSeriesId: creditSeriesId,
    });
    expect(details.status, text(details)).toBe(200);
    clientId = await createClient(`Issue client ${runId}`, null, 'CY');
    await setIssuing(true, 'set-up');
  }, 120_000);

  afterAll(async () => {
    try {
      // Print status refreshes come due later. Cancel (not delete: print_job points at its
      // submit job) whatever this run left queued, so the files that follow see nothing due
      // (orders.integration.test.ts counts the jobs one drain runs; BACKLOG H-02).
      if (app && company) {
        await inCompany(company, (tx) =>
          tx.job.updateMany({
            where: { companyId: company, status: 'queued' },
            data: { status: 'cancelled' },
          }),
        );
      }
    } finally {
      await app?.close();
      for (const root of [storageRoot, mockRoot]) {
        if (root) {
          rmSync(root, { recursive: true, force: true });
        }
      }
      delete process.env.STORAGE_ROOT;
      delete process.env.MOCK_PRINT_ROOT;
    }
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

  it('prints an issued invoice from its sealed PDF: two copies for paper, once, then only as a reprint', async () => {
    await invoicePrinter();

    // A client who has not accepted e-invoices gets paper: two copies by default.
    const paperClient = await createClient(`Paper client ${runId}`, null, 'CY');
    const draft = await createDraft({ clientId: paperClient });
    const unissued = await printInvoice(draft.id, 'print-draft');
    expect(unissued.status).toBe(409);
    expect(errorCode(unissued.body)).toBe('not_issued');
    const issued = await issue(draft.id, draft.version, cid('print-issue'));
    expect(issued.status, text(issued)).toBe(200);
    const number = stringField(record(record(issued.body).invoice), 'number');
    const row = await invoiceRow(draft.id);

    const provider = started().get<MockPrintProvider>(MOCK_PRINT_PROVIDER);
    const before = provider.submitCount;
    const queued = await printInvoice(draft.id, 'print-first');
    expect(queued.status, text(queued)).toBe(200);
    const job = record(record(queued.body).printJob);
    expect(job).toMatchObject({
      documentType: 'invoice',
      sourceType: 'invoice',
      sourceId: draft.id,
      copies: 2,
      fileId: row.pdfFileId,
      isReprint: false,
    });
    const again = await printInvoice(draft.id, 'print-again');
    expect(again.status).toBe(409);
    expect(errorCode(again.body)).toBe('already_printed');

    await started().get(JobRunner).drainOnce();
    expect(provider.submitCount).toBe(before + 1);
    const jobId = stringField(job, 'id');
    const printed = await readFile(join(mockRoot, company.toLowerCase(), `${jobId}.pdf`));
    const stored = (await fetchPdf(draft.id, cid('print-pdf'))).body as Buffer;
    expect(printed.equals(stored)).toBe(true);
    const state = record(
      JSON.parse(
        (await readFile(join(mockRoot, company.toLowerCase(), `${jobId}.json`))).toString('utf8'),
      ),
    );
    expect(state).toMatchObject({ copies: 2, title: `invoice ${number}` });

    const reprint = await printInvoice(draft.id, 'print-reprint', {
      copies: 1,
      reprint: { ofPrintJobId: jobId, reason: 'Client asked for another copy' },
    });
    expect(reprint.status, text(reprint)).toBe(200);
    expect(record(record(reprint.body).printJob)).toMatchObject({ isReprint: true, copies: 1 });
    // The detail lists the document's print jobs, newest first, for history and reprints.
    const detail = await send(
      admin,
      'get',
      `/api/c/${company}/invoices/${draft.id}`,
      cid('print-detail'),
    );
    expect(
      arrayOf(record(record(detail.body).invoice).printJobs).map((entry) => [
        record(entry).isReprint,
        record(entry).copies,
      ]),
    ).toEqual([
      [true, 1],
      [false, 2],
    ]);
    expect(record(record(detail.body).invoice).firstPrintJobId).toBe(jobId);
    expect(
      arrayOf(record(record(detail.body).invoice).printJobs).every(
        (entry) => record(entry).simulationLabel === 'Simulated — no physical printing',
      ),
    ).toBe(true);

    // Sending a reprint again with its request key returns the same job; nothing is queued twice.
    const requestKey = randomUUID();
    const body = {
      copies: 1,
      reprint: { ofPrintJobId: jobId, reason: 'Answer lost, sent again' },
      requestKey,
    };
    const once = await printInvoice(draft.id, 'print-key-1', body);
    expect(once.status, text(once)).toBe(200);
    const keyed = stringField(record(record(once.body).printJob), 'id');
    const resent = await printInvoice(draft.id, 'print-key-2', body);
    expect(resent.status, text(resent)).toBe(200);
    expect(stringField(record(record(resent.body).printJob), 'id')).toBe(keyed);
    // Concurrent sends of one new key create one job.
    const raceKey = randomUUID();
    const racing = await Promise.all(
      [1, 2, 3].map((index) =>
        printInvoice(draft.id, `print-key-race-${String(index)}`, { ...body, requestKey: raceKey }),
      ),
    );
    expect(racing.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(
      new Set(racing.map((response) => stringField(record(record(response.body).printJob), 'id')))
        .size,
    ).toBe(1);
    // Concurrent first prints of another invoice with one key also make one job.
    const second = await createDraft({ clientId: paperClient });
    const secondIssued = await issue(second.id, second.version, cid('print-key-first-issue'));
    expect(secondIssued.status, text(secondIssued)).toBe(200);
    const firstKey = randomUUID();
    const firsts = await Promise.all(
      [1, 2, 3].map((index) =>
        printInvoice(second.id, `print-key-first-${String(index)}`, { requestKey: firstKey }),
      ),
    );
    expect(firsts.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(
      new Set(firsts.map((response) => stringField(record(record(response.body).printJob), 'id')))
        .size,
    ).toBe(1);
    // A key sent with anything different (another kind of request, or other copies) is refused.
    for (const [name, changed] of [
      ['print-key-misused', { requestKey }],
      ['print-key-copies', { ...body, copies: 2 }],
    ] as const) {
      const misused = await printInvoice(draft.id, name, changed);
      expect(misused.status).toBe(409);
      expect(errorCode(misused.body)).toBe('request_key_reused');
    }
    const keyedJobs = await inCompany(company, (tx) =>
      tx.printJob.findMany({
        where: { companyId: company, requestKey: { in: [requestKey, raceKey] } },
        select: { id: true, idempotencyKey: true },
      }),
    );
    expect(keyedJobs).toHaveLength(2);
    // The provider still gets one idempotency key per job, never the caller's key.
    expect(keyedJobs.every((row) => row.idempotencyKey === `pj_${row.id}`)).toBe(true);
  });

  it('refuses to print an invoice for someone who cannot view invoices', async () => {
    const draft = await createDraft();
    const issued = await issue(draft.id, draft.version, cid('print-denied-issue'));
    expect(issued.status, text(issued)).toBe(200);
    const printer = `printer.${runId}@example.test`;
    await createDevUser(printer);
    await inCompany(company, async (tx) => {
      await tx.role.create({
        data: {
          companyId: company,
          key: `PRINT${runId}`,
          name: 'Print only (test)',
          permissions: { create: [{ permission: 'print.submit' }] },
        },
      });
    });
    await grantRole(company, printer, `PRINT${runId}`, 'owner@example.test');
    const session = await login(started(), printer);
    const correlationId = cid('print-denied');
    const denied = await send(session, 'post', `/api/c/${company}/print-requests`, correlationId, {
      documentType: 'invoice',
      sourceType: 'invoice',
      sourceId: draft.id,
    });
    expect(denied.status).toBe(403);
    const audit = await auditEvents(correlationId);
    expect(audit.map((event) => [event.action, event.outcome])).toEqual([
      ['authorization.denied', 'denied'],
    ]);
  });

  it('fails a queued invoice print, without sending it, when the requester can no longer view invoices', async () => {
    await invoicePrinter();
    // Settle anything earlier tests queued, so only this job is due.
    await started().get(JobRunner).drainOnce();
    const draft = await createDraft();
    const issued = await issue(draft.id, draft.version, cid('recheck-issue'));
    expect(issued.status, text(issued)).toBe(200);
    const viewer = `viewer.${runId}@example.test`;
    await createDevUser(viewer);
    const roleId = await inCompany(company, async (tx) => {
      const role = await tx.role.create({
        data: {
          companyId: company,
          key: `VIEWPRINT${runId}`,
          name: 'View and print (test)',
          permissions: {
            create: [{ permission: 'print.submit' }, { permission: 'invoice.view' }],
          },
        },
      });
      return role.id;
    });
    await grantRole(company, viewer, `VIEWPRINT${runId}`, 'owner@example.test');
    const session = await login(started(), viewer);
    const queued = await send(session, 'post', `/api/c/${company}/print-requests`, cid('recheck'), {
      documentType: 'invoice',
      sourceType: 'invoice',
      sourceId: draft.id,
    });
    expect(queued.status, text(queued)).toBe(200);
    const jobId = stringField(record(record(queued.body).printJob), 'id');
    await inCompany(company, (tx) =>
      tx.rolePermission.delete({
        where: { roleId_permission: { roleId, permission: 'invoice.view' } },
      }),
    );
    const provider = started().get<MockPrintProvider>(MOCK_PRINT_PROVIDER);
    const before = provider.submitCount;
    await started().get(JobRunner).drainOnce();
    expect(provider.submittedIds).not.toContain(jobId);
    expect(provider.submitCount).toBe(before);
    const job = await send(
      admin,
      'get',
      `/api/c/${company}/print-jobs/${jobId}`,
      cid('recheck-get'),
    );
    expect(record(record(job.body).printJob)).toMatchObject({
      status: 'failed',
      lastError: 'requester_no_longer_authorised',
    });
  });

  it('prints an invoice the platform owner queued, without a membership', async () => {
    await invoicePrinter();
    await started().get(JobRunner).drainOnce();
    const draft = await createDraft();
    const issued = await issue(draft.id, draft.version, cid('owner-print-issue'));
    expect(issued.status, text(issued)).toBe(200);
    const queued = await send(
      owner,
      'post',
      `/api/c/${company}/print-requests`,
      cid('owner-print'),
      {
        documentType: 'invoice',
        sourceType: 'invoice',
        sourceId: draft.id,
      },
    );
    expect(queued.status, text(queued)).toBe(200);
    const jobId = stringField(record(record(queued.body).printJob), 'id');
    const provider = started().get<MockPrintProvider>(MOCK_PRINT_PROVIDER);
    await started().get(JobRunner).drainOnce();
    expect(provider.submittedIds).toContain(jobId);
    const job = await send(
      admin,
      'get',
      `/api/c/${company}/print-jobs/${jobId}`,
      cid('owner-print-get'),
    );
    expect(record(record(job.body).printJob).lastError).toBeNull();
  });

  let printerReady: Promise<void> | undefined;

  /** A mock printer mapped for invoices at one location of this company, with printing on. Once. */
  function invoicePrinter(): Promise<void> {
    printerReady ??= (async () => {
      await inCompany(company, async (tx) => {
        const location = await tx.location.create({
          data: { companyId: company, name: `Issue test office ${runId}`, address: {} },
        });
        const printer = await tx.printer.create({
          data: {
            companyId: company,
            locationId: location.id,
            provider: 'mock',
            externalPrinterId: 'mock-laserjet-online',
            name: 'Mock LaserJet (simulated)',
            paperSizes: ['A4'],
            status: 'online',
          },
        });
        await tx.printerMapping.create({
          data: {
            companyId: company,
            locationId: location.id,
            documentType: 'invoice',
            printerId: printer.id,
            paperSize: 'A4',
            // Paper delivery still defaults to exactly two copies.
            copies: 3,
          },
        });
      });
      const printing = await admin.agent
        .put(`/api/c/${company}/automation/switches/printing`)
        .set('X-XSRF-TOKEN', admin.xsrf)
        .set('X-Correlation-Id', cid('switch-printing'))
        .send({ enabled: true, reason: 'issue test printing' });
      expect(printing.status, text(printing)).toBe(200);
    })();
    return printerReady;
  }

  function printInvoice(id: string, name: string, extra: Record<string, unknown> = {}) {
    return send(admin, 'post', `/api/c/${company}/print-requests`, cid(name), {
      documentType: 'invoice',
      sourceType: 'invoice',
      sourceId: id,
      ...extra,
    });
  }

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

  it('creates credit-note drafts against an issued invoice, within its quantities', async () => {
    const original = await issuedInvoice([
      { description: 'Gift box (demo)', quantity: '2', unitPrice: '10.00' },
      { description: 'Card (demo)', quantity: '1', unitPrice: '2.50' },
    ]);
    const [box, card] = original.lineIds;
    const credits = `/api/c/${company}/invoices/${original.id}/credit-notes`;

    const partial = await send(admin, 'post', credits, cid('credit-partial'), {
      reason: 'One box arrived damaged',
      lines: [{ invoiceLineId: box, quantity: '1' }],
    });
    expect(partial.status, text(partial)).toBe(200);
    const note = record(record(partial.body).creditNote);
    expect(note).toMatchObject({
      documentType: 'credit_note',
      status: 'draft',
      creditReason: 'One box arrived damaged',
      netTotal: '10.00',
      taxTotal: '1.90',
      total: '11.90',
    });
    expect(record(note.creditedInvoice)).toMatchObject({
      id: original.id,
      number: original.number,
    });
    expect(arrayOf(note.lines).map((line) => record(line).creditedLineId)).toEqual([box]);

    const tooMany = await send(admin, 'post', credits, cid('credit-over'), {
      reason: 'Too many',
      lines: [{ invoiceLineId: box, quantity: '3' }],
    });
    expect(tooMany.status).toBe(409);
    expect(errorCode(tooMany.body)).toBe('over_credit');
    const together = await send(admin, 'post', credits, cid('credit-together'), {
      reason: 'Two lines on one line',
      lines: [
        { invoiceLineId: box, quantity: '1.5' },
        { invoiceLineId: box, quantity: '0.6' },
      ],
    });
    expect(together.status).toBe(409);
    expect(errorCode(together.body)).toBe('over_credit');

    const other = await issuedInvoice([
      { description: 'Other (demo)', quantity: '1', unitPrice: '1.00' },
    ]);
    const stranger = await send(admin, 'post', credits, cid('credit-stranger'), {
      reason: 'Wrong line',
      lines: [{ invoiceLineId: other.lineIds[0], quantity: '1' }],
    });
    expect(stranger.status).toBe(422);
    expect(errorCode(stranger.body)).toBe('invalid_credit_line');

    const full = await send(admin, 'post', credits, cid('credit-full'), {
      reason: 'Order cancelled',
      full: true,
    });
    expect(full.status, text(full)).toBe(200);
    // Drafts do not count against the quantities; issued credit notes will (R2-D3).
    expect(
      arrayOf(record(record(full.body).creditNote).lines).map((line) => [
        record(line).creditedLineId,
        record(line).quantity,
      ]),
    ).toEqual([
      [box, '2.0000'],
      [card, '1.0000'],
    ]);

    const noteId = stringField(note, 'id');
    const edited = await send(
      admin,
      'patch',
      `/api/c/${company}/credit-notes/${noteId}`,
      cid('credit-edit'),
      {
        expectedVersion: numberField(note, 'version'),
        reason: 'Both boxes arrived damaged',
        lines: [{ id: stringField(record(arrayOf(note.lines)[0]), 'id'), quantity: '2' }],
      },
    );
    expect(edited.status, text(edited)).toBe(200);
    expect(record(record(edited.body).creditNote)).toMatchObject({
      creditReason: 'Both boxes arrived damaged',
      netTotal: '20.00',
      taxTotal: '3.80',
      version: numberField(note, 'version') + 1,
    });
    const overCorrelation = cid('credit-edit-over');
    const overEdit = await send(
      admin,
      'patch',
      `/api/c/${company}/credit-notes/${noteId}`,
      overCorrelation,
      {
        expectedVersion: numberField(note, 'version') + 1,
        lines: [{ id: stringField(record(arrayOf(note.lines)[0]), 'id'), quantity: '3' }],
      },
    );
    expect(overEdit.status).toBe(409);
    expect(errorCode(overEdit.body)).toBe('over_credit');
    expect(
      (await auditEvents(overCorrelation)).map((event) => [
        event.action,
        event.outcome,
        event.objectId,
      ]),
    ).toEqual([['credit_note.updated', 'failure', noteId]]);
    const foreignLine = await send(
      admin,
      'patch',
      `/api/c/${company}/credit-notes/${noteId}`,
      cid('credit-edit-foreign'),
      {
        expectedVersion: numberField(note, 'version') + 1,
        lines: [{ id: box, quantity: '1' }],
      },
    );
    expect(foreignLine.status).toBe(422);
    expect(errorCode(foreignLine.body)).toBe('invalid_credit_line');
    const generic = await send(
      admin,
      'patch',
      `/api/c/${company}/invoices/${noteId}`,
      cid('credit-generic'),
      {
        expectedVersion: numberField(note, 'version') + 1,
        reference: 'Edited elsewhere',
      },
    );
    expect(generic.status).toBe(409);
    expect(errorCode(generic.body)).toBe('credit_note_draft');

    const detail = await send(
      admin,
      'get',
      `/api/c/${company}/invoices/${original.id}`,
      cid('credit-original'),
    );
    const invoice = record(record(detail.body).invoice);
    expect(arrayOf(invoice.creditNotes).map((entry) => record(entry).status)).toEqual([
      'draft',
      'draft',
    ]);
    expect(arrayOf(invoice.lines).map((line) => record(line).creditedQuantity)).toEqual([
      '0.0000',
      '0.0000',
    ]);

    const draft = await createDraft();
    const unissued = await send(
      admin,
      'post',
      `/api/c/${company}/invoices/${draft.id}/credit-notes`,
      cid('credit-draft'),
      {
        reason: 'Not issued',
        full: true,
      },
    );
    expect(unissued.status).toBe(409);
    expect(errorCode(unissued.body)).toBe('not_issued');
    const quote = await createDraft({ documentType: 'quote' });
    const quoted = await send(
      admin,
      'post',
      `/api/c/${company}/invoices/${quote.id}/credit-notes`,
      cid('credit-quote'),
      {
        reason: 'A quote',
        full: true,
      },
    );
    expect(quoted.status).toBe(409);
    expect(errorCode(quoted.body)).toBe('not_creditable');
  });

  it('issues a credit note in its own series, with the particulars of the invoice it credits', async () => {
    const original = await issuedInvoice([
      { description: 'Gift box (demo)', quantity: '2', unitPrice: '10.00' },
      { description: 'Card (demo)', quantity: '1', unitPrice: '2.50' },
    ]);
    const [box] = original.lineIds;
    // Drafted first; it counts against nothing until it is issued.
    const whole = await draftCredit(
      original.id,
      { reason: 'Order cancelled', full: true },
      'cn-whole',
    );
    const partial = await draftCredit(
      original.id,
      { reason: 'One box arrived damaged', lines: [{ invoiceLineId: box, quantity: '1' }] },
      'cn-partial',
    );

    const stale = await issueCredit(partial.id, partial.version + 1, cid('cn-stale'));
    expect(stale.status).toBe(409);
    expect(errorCode(stale.body)).toBe('conflict');
    const asInvoice = await issue(partial.id, partial.version, cid('cn-as-invoice'));
    expect(asInvoice.status).toBe(409);
    expect(errorCode(asInvoice.body)).toBe('credit_note_draft');
    const notCredit = await issueCredit(original.id, 0, cid('cn-not-credit'));
    expect(notCredit.status).toBe(404);

    const before = await seriesRow(creditSeriesId);
    const correlationId = cid('cn-issue');
    const issued = await issueCredit(partial.id, partial.version, correlationId);
    expect(issued.status, text(issued)).toBe(200);
    const today = businessDateInZone(new Date(), TIMEZONE);
    const number = `${creditPrefix}${String(before.nextNumber).padStart(4, '0')}`;
    expect(record(record(issued.body).creditNote)).toMatchObject({
      documentType: 'credit_note',
      status: 'issued',
      number,
      issueDate: today,
      supplyDate: today,
      dueDate: today,
      creditReason: 'One box arrived damaged',
      netTotal: '10.00',
      taxTotal: '1.90',
      total: '11.90',
      version: partial.version + 1,
    });
    expect(arrayOf(record(issued.body).warnings)).toEqual([]);
    expect((await seriesRow(creditSeriesId)).nextNumber).toBe(before.nextNumber + 1);
    expect(
      (await auditEvents(correlationId)).map((event) => [
        event.action,
        event.outcome,
        event.objectId,
      ]),
    ).toEqual([
      ['allocation.created', 'success', record(arrayOf(record(record(issued.body).creditNote).allocations)[0]).id],
      ['credit_note.issued', 'success', partial.id],
    ]);

    // The buyer and the tax treatment are the invoice's, as frozen when it was issued.
    const row = await invoiceRow(partial.id);
    const source = await invoiceRow(original.id);
    expect(row.buyerSnapshot).toEqual(source.buyerSnapshot);
    expect(row.lines.map((line) => line.taxSnapshot)).toEqual([source.lines[0]?.taxSnapshot]);
    expect(row.taxSummary.map((summary) => summary.taxSnapshot)).toEqual(
      source.taxSummary.map((summary) => summary.taxSnapshot),
    );
    expect(row.bankSnapshot).toBeNull();
    expect(row.termsSnapshot).toBeNull();
    const file = await inCompany(company, (tx) =>
      tx.storedFile.findUniqueOrThrow({ where: { id: row.pdfFileId ?? '' } }),
    );
    expect(file).toMatchObject({ kind: 'invoice_pdf', sealed: true, sourceId: partial.id });

    const pdf = await fetchPdf(partial.id, cid('cn-pdf'));
    expect(pdf.status).toBe(200);
    const pdfText = flatten(await extractPdfText(pdf.body as Buffer));
    expect(pdfText).toContain(flatten(`Credit note ${number}`));
    expect(pdfText).toContain(
      flatten(`Credits invoice: ${original.number} (${formatDay(source.issueDate)})`),
    );
    expect(pdfText).toContain(flatten('Reason: One box arrived damaged'));
    expect(pdfText).toContain(flatten(`Date of supply: ${today}`));
    expect(pdfText).not.toContain(flatten('Due date'));
    expect(pdfText).not.toContain('IBAN');

    const detail = await send(
      admin,
      'get',
      `/api/c/${company}/invoices/${original.id}`,
      cid('cn-original'),
    );
    const invoice = record(record(detail.body).invoice);
    expect(arrayOf(invoice.lines).map((line) => record(line).creditedQuantity)).toEqual([
      '1.0000',
      '0.0000',
    ]);

    // The whole-invoice draft now credits a box twice over.
    const overCorrelation = cid('cn-over');
    const over = await issueCredit(whole.id, whole.version, overCorrelation);
    expect(over.status).toBe(409);
    expect(errorCode(over.body)).toBe('over_credit');
    expect(
      (await auditEvents(overCorrelation)).map((event) => [
        event.action,
        event.outcome,
        event.objectId,
      ]),
    ).toEqual([['credit_note.issued', 'failure', whole.id]]);
    expect((await invoiceRow(whole.id)).status).toBe('draft');
    expect((await seriesRow(creditSeriesId)).nextNumber).toBe(before.nextNumber + 1);

    // Trimmed to what is left, it issues, and the two credits add up to the invoice.
    const trimmed = await send(
      admin,
      'patch',
      `/api/c/${company}/credit-notes/${whole.id}`,
      cid('cn-trim'),
      { expectedVersion: whole.version, lines: [{ id: whole.lineIds[0], quantity: '1' }] },
    );
    expect(trimmed.status, text(trimmed)).toBe(200);
    const rest = await issueCredit(whole.id, whole.version + 1, cid('cn-rest'));
    expect(rest.status, text(rest)).toBe(200);
    expect(record(record(rest.body).creditNote)).toMatchObject({
      number: `${creditPrefix}${String(before.nextNumber + 1).padStart(4, '0')}`,
      netTotal: '12.50',
      taxTotal: '2.38',
      total: '14.88',
    });
    // 11.90 + 14.88 is the invoice's 26.78, and 1.90 + 2.38 its VAT of 4.28.
    expect([
      source.netTotal.toFixed(2),
      source.taxTotal.toFixed(2),
      source.total.toFixed(2),
    ]).toEqual(['22.50', '4.28', '26.78']);

    const nothing = await send(
      admin,
      'post',
      `/api/c/${company}/invoices/${original.id}/credit-notes`,
      cid('cn-nothing'),
      { reason: 'Again', full: true },
    );
    expect(nothing.status).toBe(409);
    expect(errorCode(nothing.body)).toBe('nothing_to_credit');
    const again = await issueCredit(partial.id, partial.version + 1, cid('cn-again'));
    expect(again.status).toBe(409);
    expect(errorCode(again.body)).toBe('not_draft');
  });

  it('lets one of two concurrent credit notes issue when together they credit too much', async () => {
    const original = await issuedInvoice([
      { description: 'Hamper (demo)', quantity: '1', unitPrice: '30.00' },
    ]);
    const first = await draftCredit(original.id, { reason: 'Returned', full: true }, 'cn-race-a');
    const second = await draftCredit(original.id, { reason: 'Returned', full: true }, 'cn-race-b');
    const before = await seriesRow(creditSeriesId);
    const service = started().get(InvoiceService);
    let late: Promise<request.Response> | undefined;
    // The first holds both locks while the second queues on the invoice rows, so the second
    // reads the quantities only after the first has committed.
    service.hooks = {
      afterNumberAllocated: async () => {
        if (late) {
          return;
        }
        late = issueCredit(second.id, second.version, cid('cn-race-issue-b')).then(
          (response) => response,
        );
        await waitForLockWaiter('FOR UPDATE');
      },
    };
    try {
      const won = await issueCredit(first.id, first.version, cid('cn-race-issue-a'));
      expect(won.status, text(won)).toBe(200);
      const lost = await late;
      expect(lost?.status).toBe(409);
      expect(errorCode(lost?.body)).toBe('over_credit');
    } finally {
      service.hooks = null;
    }
    expect((await invoiceRow(second.id)).status).toBe('draft');
    expect((await seriesRow(creditSeriesId)).nextNumber).toBe(before.nextNumber + 1);
  });

  it('converts a quote to a draft invoice once', async () => {
    const quote = await createDraft({ documentType: 'quote', unitPrice: '12.34' });
    const converted = await send(
      admin,
      'post',
      `/api/c/${company}/quotes/${quote.id}/convert`,
      cid('quote-convert'),
      {},
    );
    expect(converted.status, text(converted)).toBe(200);
    const invoice = record(record(converted.body).invoice);
    expect(invoice).toMatchObject({
      documentType: 'invoice',
      status: 'draft',
      sourceQuoteId: quote.id,
      netTotal: '12.34',
    });
    const source = await send(
      admin,
      'get',
      `/api/c/${company}/invoices/${quote.id}`,
      cid('quote-source'),
    );
    expect(record(record(source.body).invoice).convertedInvoiceId).toBe(invoice.id);
    // Even with a tax code of its lines switched off since, a converted quote says so.
    const code = await inCompany(company, (tx) =>
      tx.taxCode.findUniqueOrThrow({ where: { id: standardTax } }),
    );
    const off = await send(
      admin,
      'patch',
      `/api/c/${company}/tax-codes/${standardTax}`,
      cid('quote-code-off'),
      {
        expectedVersion: code.version,
        active: false,
      },
    );
    expect(off.status, text(off)).toBe(200);
    const again = await send(
      admin,
      'post',
      `/api/c/${company}/quotes/${quote.id}/convert`,
      cid('quote-again'),
      {},
    );
    expect(again.status).toBe(409);
    expect(errorCode(again.body)).toBe('already_converted');
    const on = await send(
      admin,
      'patch',
      `/api/c/${company}/tax-codes/${standardTax}`,
      cid('quote-code-on'),
      {
        expectedVersion: code.version + 1,
        active: true,
      },
    );
    expect(on.status, text(on)).toBe(200);

    const racing = await createDraft({ documentType: 'quote' });
    const responses = await Promise.all(
      [1, 2, 3].map((index) =>
        send(
          admin,
          'post',
          `/api/c/${company}/quotes/${racing.id}/convert`,
          cid(`quote-race-${String(index)}`),
          {},
        ),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409]);
    // A refusal from the draft rules is audited as a refused conversion of the quote.
    const usdQuote = await createDraft({ documentType: 'quote' });
    await inCompany(company, (tx) =>
      tx.invoice.update({ where: { id: usdQuote.id }, data: { currency: 'USD' } }),
    );
    const usdClient = await createClient(`USD client ${runId}`, null, 'CY');
    await inCompany(company, async (tx) => {
      await tx.client.update({ where: { id: usdClient }, data: { defaultCurrency: 'USD' } });
      await tx.invoice.update({ where: { id: usdQuote.id }, data: { clientId: usdClient } });
    });
    const currencyCorrelation = cid('quote-currency');
    const currency = await send(
      admin,
      'post',
      `/api/c/${company}/quotes/${usdQuote.id}/convert`,
      currencyCorrelation,
      {},
    );
    expect(currency.status).toBe(422);
    expect(errorCode(currency.body)).toBe('currency_not_supported');
    expect(
      (await auditEvents(currencyCorrelation)).map((event) => [
        event.action,
        event.outcome,
        event.objectId,
      ]),
    ).toEqual([['quote.converted', 'failure', usdQuote.id]]);
    const inactiveQuote = await createDraft({ documentType: 'quote' });
    const live = await inCompany(company, (tx) =>
      tx.taxCode.findUniqueOrThrow({ where: { id: standardTax } }),
    );
    const switchedOff = await send(
      admin,
      'patch',
      `/api/c/${company}/tax-codes/${standardTax}`,
      cid('quote-inactive-off'),
      {
        expectedVersion: live.version,
        active: false,
      },
    );
    expect(switchedOff.status, text(switchedOff)).toBe(200);
    try {
      const inactiveCorrelation = cid('quote-inactive');
      const inactive = await send(
        admin,
        'post',
        `/api/c/${company}/quotes/${inactiveQuote.id}/convert`,
        inactiveCorrelation,
        {},
      );
      expect(inactive.status).toBe(422);
      expect(errorCode(inactive.body)).toBe('tax_code_inactive');
      expect(
        (await auditEvents(inactiveCorrelation)).map((event) => [
          event.action,
          event.outcome,
          event.objectId,
        ]),
      ).toEqual([['quote.converted', 'failure', inactiveQuote.id]]);
    } finally {
      await send(
        admin,
        'patch',
        `/api/c/${company}/tax-codes/${standardTax}`,
        cid('quote-inactive-on'),
        {
          expectedVersion: live.version + 1,
          active: true,
        },
      );
    }
    const notQuote = await createDraft();
    const refused = await send(
      admin,
      'post',
      `/api/c/${company}/quotes/${notQuote.id}/convert`,
      cid('quote-invoice'),
      {},
    );
    expect(refused.status).toBe(409);
    expect(errorCode(refused.body)).toBe('not_a_quote');
  });

  /** Creates and issues an invoice with these lines (standard rate, prices excluding VAT). */
  async function issuedInvoice(
    lines: { description: string; quantity: string; unitPrice: string }[],
  ): Promise<{ id: string; number: string; lineIds: string[] }> {
    const created = await send(admin, 'post', `/api/c/${company}/invoices`, cid('multi-draft'), {
      clientId,
      pricesIncludeTax: false,
      lines: lines.map((line, index) => ({
        position: index + 1,
        description: line.description,
        quantity: line.quantity,
        unit: 'pc',
        unitPrice: line.unitPrice,
        taxCodeId: standardTax,
      })),
    });
    expect(created.status, text(created)).toBe(200);
    const draft = record(record(created.body).invoice);
    const issued = await issue(
      stringField(draft, 'id'),
      numberField(draft, 'version'),
      cid('multi-issue'),
    );
    expect(issued.status, text(issued)).toBe(200);
    const invoice = record(record(issued.body).invoice);
    return {
      id: stringField(invoice, 'id'),
      number: stringField(invoice, 'number'),
      lineIds: arrayOf(invoice.lines).map((line) => stringField(record(line), 'id')),
    };
  }

  async function createDraft(
    options: {
      pricesIncludeTax?: boolean;
      unitPrice?: string;
      supplyDate?: string;
      taxCodeId?: string;
      description?: string;
      clientId?: string;
      documentType?: 'quote';
    } = {},
  ): Promise<{ id: string; version: number }> {
    const response = await send(admin, 'post', `/api/c/${company}/invoices`, cid('draft'), {
      clientId: options.clientId ?? clientId,
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

  function issueCredit(id: string, version: number, correlationId: string) {
    return send(admin, 'post', `/api/c/${company}/credit-notes/${id}/issue`, correlationId, {
      expectedVersion: version,
    });
  }

  async function draftCredit(
    invoiceId: string,
    body: Record<string, unknown>,
    name: string,
  ): Promise<{ id: string; version: number; lineIds: string[] }> {
    const response = await send(
      admin,
      'post',
      `/api/c/${company}/invoices/${invoiceId}/credit-notes`,
      cid(name),
      body,
    );
    expect(response.status, text(response)).toBe(200);
    const note = record(record(response.body).creditNote);
    return {
      id: stringField(note, 'id'),
      version: numberField(note, 'version'),
      lineIds: arrayOf(note.lines).map((line) => stringField(record(line), 'id')),
    };
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

  async function createSeries(
    seriesPrefix: string,
    name: string,
    documentType: 'invoice' | 'credit_note' = 'invoice',
  ): Promise<string> {
    const response = await send(
      admin,
      'post',
      `/api/c/${company}/invoice-series`,
      cid(`series-${name}`),
      {
        code: `${name}-${runId}`.slice(0, 32),
        documentType,
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

/** Gives the user an active membership with this role, company-wide, in a company of this run. */
async function grantRole(
  companyId: string,
  email: string,
  roleKey: string,
  grantedBy: string,
): Promise<void> {
  const prisma = started().get(PrismaService);
  const user = await prisma.client.userAccount.findFirstOrThrow({ where: { email } });
  const granter = await prisma.client.userAccount.findFirstOrThrow({ where: { email: grantedBy } });
  await inCompany(companyId, async (tx) => {
    const role = await tx.role.findFirstOrThrow({ where: { companyId, key: roleKey } });
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

function formatDay(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : '';
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
