import { type INestApplication } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
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
import { cancelQueuedJobs } from './test/cancel-queued-jobs';
import { PrismaService } from './database/prisma.service';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { LOG_STREAM } from './logging/logging.module';

const COMPANY_A = 'Demo Company A Ltd (fictional)';
const runId = randomUUID().slice(0, 8);
/** The ISO 13616 registry's example IBANs for Cyprus and Greece. Not real accounts. */
const IBAN_CY = 'CY17 0020 0128 0000 0012 0052 7600';
const IBAN_GR = 'GR1601101250000000012300695';

type Agent = ReturnType<typeof request.agent>;
type Session = { agent: Agent; xsrf: string };

let app: INestApplication | undefined;

describe('finance settings', () => {
  let companyA = '';
  let admin: Session;
  let finance: Session;
  let clientId = '';

  beforeAll(async () => {
    const refusal = assertTestDatabaseUrls();
    if (refusal) {
      throw new Error(refusal);
    }
    await assertEnvConnectionsTargetTestDatabase();
    seedDatabase();
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
    companyA = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_A } }))
      .id;
    admin = await login(started(), 'admin.a@example.test');
    finance = await login(started(), 'finance.a@example.test');
    const client = await send(admin, 'post', `/api/c/${companyA}/clients`, cid('client'), {
      kind: 'organisation',
      displayName: `Finance settings client ${runId}`,
      addresses: [
        {
          kind: 'billing',
          line1: '1 Test Road',
          city: 'Nicosia',
          countryCode: 'CY',
          isDefault: true,
        },
      ],
    });
    expect(client.status, text(client)).toBe(200);
    clientId = stringField(record(record(client.body).client), 'id');
  }, 120_000);

  afterAll(async () => {
    await cancelQueuedJobs(app, [companyA]);
    await app?.close();
  });

  it('keeps the constraints the application relies on', async () => {
    const prisma = started().get(PrismaService);
    const constraints = await prisma.client.$queryRaw<{ name: string }[]>`
      SELECT conname AS name FROM pg_constraint
      WHERE conname IN (
        'company_bank_account_shown_active_check',
        'tax_code_rate_percent_check',
        'invoice_series_next_number_check',
        'invoice_series_padding_check'
      )
      ORDER BY conname
    `;
    expect(constraints.map((row) => row.name)).toEqual([
      'company_bank_account_shown_active_check',
      'invoice_series_next_number_check',
      'invoice_series_padding_check',
      'tax_code_rate_percent_check',
    ]);
    const indexes = await prisma.client.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE indexname = 'company_bank_account_one_shown_key'
    `;
    expect(indexes).toHaveLength(1);
    const triggers = await prisma.client.$queryRaw<{ name: string }[]>`
      SELECT tgname AS name FROM pg_trigger
      WHERE tgname IN ('company_default_series_guard', 'invoice_series_default_guard')
      ORDER BY tgname
    `;
    expect(triggers.map((row) => row.name)).toEqual([
      'company_default_series_guard',
      'invoice_series_default_guard',
    ]);
  });

  it('refuses, in the database, a default series of another company or another document type', async () => {
    const companyB = await started()
      .get(PrismaService)
      .client.company.findFirstOrThrow({ where: { legalName: 'Demo Company B Ltd (fictional)' } });
    const seriesB = await inCompany(companyB.id, (tx) =>
      tx.invoiceSeries.findFirstOrThrow({
        where: { companyId: companyB.id, code: 'INV' },
        select: { id: true },
      }),
    );
    const creditA = await inCompany(companyA, (tx) =>
      tx.invoiceSeries.findFirstOrThrow({
        where: { companyId: companyA, code: 'CN' },
        select: { id: true },
      }),
    );
    for (const seriesId of [seriesB.id, creditA.id]) {
      await expect(
        inCompany(companyA, (tx) =>
          tx.company.update({
            where: { id: companyA },
            data: { defaultInvoiceSeriesId: seriesId },
          }),
        ),
      ).rejects.toThrow();
    }
    await expect(
      inCompany(companyA, (tx) =>
        tx.invoiceSeries.update({ where: { id: creditA.id }, data: { documentType: 'invoice' } }),
      ),
    ).rejects.toThrow();
  });

  it('creates and edits tax codes, and locks rate, kind and notes once a line uses one', async () => {
    const code = `T${runId}`.slice(0, 32);
    const createdId = cid('tax-create');
    const created = await send(finance, 'post', `/api/c/${companyA}/tax-codes`, createdId, {
      code,
      name: 'Test reduced',
      ratePercent: '9',
      kind: 'reduced',
      noteEn: 'Reduced rate (test)',
      deadlineRule: 'next_month_15',
    });
    expect(created.status, text(created)).toBe(200);
    const tax = record(record(created.body).taxCode);
    expect(tax).toEqual(
      expect.objectContaining({
        code,
        ratePercent: '9.0000',
        kind: 'reduced',
        deadlineRule: 'next_month_15',
        inUse: false,
        isExample: false,
        version: 0,
      }),
    );
    expect((await auditEvents(companyA, createdId)).map((event) => event.action)).toEqual([
      'tax_code.created',
    ]);
    const taxId = stringField(tax, 'id');

    const duplicate = await send(finance, 'post', `/api/c/${companyA}/tax-codes`, cid('tax-dup'), {
      code,
      name: 'Duplicate',
      ratePercent: '19',
      kind: 'standard',
    });
    expect(duplicate.status).toBe(409);
    expect(errorCode(duplicate.body)).toBe('code_taken');

    const mismatch = await send(
      finance,
      'post',
      `/api/c/${companyA}/tax-codes`,
      cid('tax-mismatch'),
      {
        code: `${code}X`.slice(0, 32),
        name: 'Exempt with a rate',
        ratePercent: '5',
        kind: 'exempt',
      },
    );
    expect(mismatch.status).toBe(400);

    const renamed = await send(
      finance,
      'patch',
      `/api/c/${companyA}/tax-codes/${taxId}`,
      cid('tax-rename'),
      {
        expectedVersion: 0,
        name: 'Test reduced (renamed)',
        ratePercent: '5',
      },
    );
    expect(renamed.status, text(renamed)).toBe(200);
    expect(record(record(renamed.body).taxCode)).toEqual(
      expect.objectContaining({ ratePercent: '5.0000', version: 1 }),
    );
    const stale = await send(
      finance,
      'patch',
      `/api/c/${companyA}/tax-codes/${taxId}`,
      cid('tax-stale'),
      {
        expectedVersion: 0,
        name: 'Stale',
      },
    );
    expect(stale.status).toBe(409);

    const draft = await createDraft(admin, companyA, clientId, taxId, cid('tax-draft'));
    expect(draft.status, text(draft)).toBe(200);

    const locked = await send(
      finance,
      'patch',
      `/api/c/${companyA}/tax-codes/${taxId}`,
      cid('tax-locked'),
      {
        expectedVersion: 1,
        ratePercent: '3',
      },
    );
    expect(locked.status).toBe(409);
    expect(errorCode(locked.body)).toBe('tax_code_in_use');
    const noteLocked = await send(
      finance,
      'patch',
      `/api/c/${companyA}/tax-codes/${taxId}`,
      cid('tax-note'),
      {
        expectedVersion: 1,
        noteEl: 'Μειωμένος συντελεστής',
      },
    );
    expect(noteLocked.status).toBe(409);

    const allowed = await send(
      finance,
      'patch',
      `/api/c/${companyA}/tax-codes/${taxId}`,
      cid('tax-allowed'),
      {
        expectedVersion: 1,
        name: 'Test reduced (in use)',
        deadlineRule: 'days_30',
        active: false,
      },
    );
    expect(allowed.status, text(allowed)).toBe(200);
    expect(record(record(allowed.body).taxCode)).toEqual(
      expect.objectContaining({ inUse: true, active: false, deadlineRule: 'days_30', version: 2 }),
    );
    const listed = await send(admin, 'get', `/api/c/${companyA}/tax-codes`, cid('tax-list'));
    const row = arrayOf(record(listed.body).taxCodes)
      .map(record)
      .find((item) => item.id === taxId);
    expect(row?.inUse).toBe(true);
  });

  it('makes a draft read the rate an edit committed while the draft waited for the code', async () => {
    const created = await send(finance, 'post', `/api/c/${companyA}/tax-codes`, cid('race-tax'), {
      code: `R${runId}`.slice(0, 32),
      name: 'Race code',
      ratePercent: '19',
      kind: 'standard',
    });
    expect(created.status, text(created)).toBe(200);
    const taxId = stringField(record(record(created.body).taxCode), 'id');
    const prisma = started().get(PrismaService);
    let draft: Promise<request.Response> | undefined;
    await prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.company_id', ${companyA}, true)`;
        await tx.$queryRaw`SELECT id FROM tax_code WHERE id = ${taxId}::uuid FOR UPDATE`;
        draft = createDraft(admin, companyA, clientId, taxId, cid('race-draft')).then(
          (response) => response,
        );
        await waitForLockWaiter(prisma, taxId);
        await tx.$executeRaw`UPDATE tax_code SET rate_percent = 9 WHERE id = ${taxId}::uuid`;
      },
      { timeout: 15_000 },
    );
    const response = await draft;
    expect(response?.status, response ? text(response) : 'no response').toBe(200);
    const line = arrayOf(record(record(response?.body).invoice).lines).map(record)[0];
    expect(line?.taxRatePercent).toBe('9.0000');
  });

  it('creates and edits series, and locks numbering once a number is issued', async () => {
    const code = `S${runId}`.slice(0, 32);
    const created = await send(
      admin,
      'post',
      `/api/c/${companyA}/invoice-series`,
      cid('series-create'),
      {
        code,
        documentType: 'invoice',
        prefix: `T${runId}-`,
        nextNumber: 5,
        padding: 5,
      },
    );
    expect(created.status, text(created)).toBe(200);
    const series = record(record(created.body).series);
    expect(series).toEqual(
      expect.objectContaining({ nextNumber: 5, padding: 5, hasIssued: false, version: 0 }),
    );
    const seriesId = stringField(series, 'id');

    const denied = await send(
      finance,
      'post',
      `/api/c/${companyA}/invoice-series`,
      cid('series-denied'),
      {
        code: `${code}F`.slice(0, 32),
        documentType: 'invoice',
        prefix: 'F-',
      },
    );
    expect(denied.status).toBe(403);
    const duplicate = await send(
      admin,
      'post',
      `/api/c/${companyA}/invoice-series`,
      cid('series-dup'),
      {
        code,
        documentType: 'quote',
        prefix: 'Q-',
      },
    );
    expect(duplicate.status).toBe(409);
    expect(errorCode(duplicate.body)).toBe('code_taken');

    const lowered = await send(
      admin,
      'patch',
      `/api/c/${companyA}/invoice-series/${seriesId}`,
      cid('series-low'),
      {
        expectedVersion: 0,
        nextNumber: 4,
      },
    );
    expect(lowered.status).toBe(422);
    expect(errorCode(lowered.body)).toBe('next_number_lowered');
    const raised = await send(
      admin,
      'patch',
      `/api/c/${companyA}/invoice-series/${seriesId}`,
      cid('series-raise'),
      {
        expectedVersion: 0,
        nextNumber: 10,
      },
    );
    expect(raised.status, text(raised)).toBe(200);
    expect(record(record(raised.body).series).version).toBe(1);

    // R2-C allocates numbers. Until then, mark a fresh draft as numbered from this series.
    const draft = await createDraft(
      admin,
      companyA,
      clientId,
      await standardTax(companyA),
      cid('series-draft'),
    );
    const draftId = stringField(record(record(draft.body).invoice), 'id');
    await inCompany(companyA, (tx) =>
      tx.invoice.update({
        where: { id: draftId },
        data: { seriesId, number: `T${runId}-00010`, numberSeq: 10 },
      }),
    );
    const prefixLocked = await send(
      admin,
      'patch',
      `/api/c/${companyA}/invoice-series/${seriesId}`,
      cid('series-locked'),
      { expectedVersion: 1, prefix: 'CHANGED-' },
    );
    expect(prefixLocked.status).toBe(409);
    expect(errorCode(prefixLocked.body)).toBe('series_in_use');
    const raisedAfter = await send(
      admin,
      'patch',
      `/api/c/${companyA}/invoice-series/${seriesId}`,
      cid('series-raise-after'),
      { expectedVersion: 1, nextNumber: 20 },
    );
    expect(raisedAfter.status).toBe(409);
    const renamed = await send(
      admin,
      'patch',
      `/api/c/${companyA}/invoice-series/${seriesId}`,
      cid('series-code'),
      {
        expectedVersion: 1,
        code: `${code}2`.slice(0, 32),
      },
    );
    expect(renamed.status, text(renamed)).toBe(200);
    expect(record(record(renamed.body).series)).toEqual(
      expect.objectContaining({ hasIssued: true, version: 2 }),
    );
  });

  it('sets default series by document type and refuses to deactivate a default', async () => {
    const invoiceSeries = await createSeries(admin, companyA, 'invoice', 'def-inv');
    const creditSeries = await createSeries(admin, companyA, 'credit_note', 'def-cn');
    const before = await companyVersion(companyA);
    const wrongType = await send(admin, 'patch', `/api/c/${companyA}/company`, cid('def-wrong'), {
      expectedVersion: before,
      defaultInvoiceSeriesId: creditSeries,
    });
    expect(wrongType.status).toBe(422);
    expect(errorCode(wrongType.body)).toBe('series_type_mismatch');
    const saved = await send(admin, 'patch', `/api/c/${companyA}/company`, cid('def-set'), {
      expectedVersion: before,
      defaultInvoiceSeriesId: invoiceSeries.toUpperCase(),
      defaultCreditNoteSeriesId: creditSeries,
      invoiceTermsEn: 'Payment within 30 days (test).',
      invoiceTermsEl: 'Πληρωμή εντός 30 ημερών (δοκιμή).',
    });
    expect(saved.status, text(saved)).toBe(200);
    expect(record(record(saved.body).company)).toEqual(
      expect.objectContaining({
        defaultInvoiceSeriesId: invoiceSeries,
        defaultCreditNoteSeriesId: creditSeries,
        invoiceTermsEl: 'Πληρωμή εντός 30 ημερών (δοκιμή).',
      }),
    );
    const seriesVersion = await seriesRowVersion(companyA, invoiceSeries);
    const deactivate = await send(
      admin,
      'patch',
      `/api/c/${companyA}/invoice-series/${invoiceSeries}`,
      cid('def-deactivate'),
      { expectedVersion: seriesVersion, active: false },
    );
    expect(deactivate.status).toBe(409);
    expect(errorCode(deactivate.body)).toBe('series_is_default');

    const cleared = await send(admin, 'patch', `/api/c/${companyA}/company`, cid('def-clear'), {
      expectedVersion: before + 1,
      defaultInvoiceSeriesId: null,
      defaultCreditNoteSeriesId: null,
    });
    expect(cleared.status, text(cleared)).toBe(200);
    const inactive = await send(
      admin,
      'patch',
      `/api/c/${companyA}/invoice-series/${invoiceSeries}`,
      cid('def-inactive'),
      { expectedVersion: seriesVersion, active: false },
    );
    expect(inactive.status, text(inactive)).toBe(200);
    const inactiveDefault = await send(
      admin,
      'patch',
      `/api/c/${companyA}/company`,
      cid('def-inactive-set'),
      {
        expectedVersion: before + 2,
        defaultInvoiceSeriesId: invoiceSeries,
      },
    );
    expect(inactiveDefault.status).toBe(422);
    expect(errorCode(inactiveDefault.body)).toBe('series_inactive');
  });

  it('validates IBANs and shows at most one bank account on invoices', async () => {
    const invalid = await send(admin, 'post', `/api/c/${companyA}/bank-accounts`, cid('bank-bad'), {
      bankName: 'Fictional Bank',
      accountHolder: 'Demo Company A Ltd (fictional)',
      iban: 'CY18 0020 0128 0000 0012 0052 7600',
    });
    expect(invalid.status).toBe(400);
    const badBic = await send(admin, 'post', `/api/c/${companyA}/bank-accounts`, cid('bank-bic'), {
      bankName: 'Fictional Bank',
      accountHolder: 'Demo Company A Ltd (fictional)',
      iban: IBAN_CY,
      bic: 'NOT A BIC',
    });
    expect(badBic.status).toBe(400);
    const denied = await send(
      finance,
      'post',
      `/api/c/${companyA}/bank-accounts`,
      cid('bank-denied'),
      {
        bankName: 'Fictional Bank',
        accountHolder: 'Demo Company A Ltd (fictional)',
        iban: IBAN_CY,
      },
    );
    expect(denied.status).toBe(403);

    const firstId = cid('bank-first');
    const first = await send(admin, 'post', `/api/c/${companyA}/bank-accounts`, firstId, {
      bankName: `First fictional bank ${runId}`,
      accountHolder: 'Demo Company A Ltd (fictional)',
      iban: IBAN_CY.toLowerCase(),
      bic: 'abcdcy2n',
      shownOnInvoices: true,
    });
    expect(first.status, text(first)).toBe(200);
    const firstBody = record(record(first.body).bankAccount);
    expect(firstBody).toEqual(
      expect.objectContaining({
        iban: 'CY17002001280000001200527600',
        bic: 'ABCDCY2N',
        shownOnInvoices: true,
      }),
    );
    const firstAccount = stringField(firstBody, 'id');
    const second = await send(
      admin,
      'post',
      `/api/c/${companyA}/bank-accounts`,
      cid('bank-second'),
      {
        bankName: `Second fictional bank ${runId}`,
        accountHolder: 'Demo Company A Ltd (fictional)',
        iban: IBAN_GR,
      },
    );
    expect(second.status, text(second)).toBe(200);
    const secondAccount = stringField(record(record(second.body).bankAccount), 'id');

    const showSecondId = cid('bank-show');
    const shown = await send(
      admin,
      'patch',
      `/api/c/${companyA}/bank-accounts/${secondAccount}`,
      showSecondId,
      {
        expectedVersion: 0,
        shownOnInvoices: true,
      },
    );
    expect(shown.status, text(shown)).toBe(200);
    const accounts = await bankAccounts(companyA);
    expect(
      accounts.filter((account) => account.shownOnInvoices).map((account) => account.id),
    ).toEqual([secondAccount]);
    expect(accounts.find((account) => account.id === firstAccount)?.version).toBe(1);
    expect((await auditEvents(companyA, showSecondId)).map((event) => event.action).sort()).toEqual(
      ['bank_account.updated', 'bank_account.updated'],
    );

    const staleFirst = await send(
      admin,
      'patch',
      `/api/c/${companyA}/bank-accounts/${firstAccount}`,
      cid('bank-stale'),
      {
        expectedVersion: 0,
        bankName: 'Stale edit',
      },
    );
    expect(staleFirst.status).toBe(409);

    const deactivated = await send(
      admin,
      'patch',
      `/api/c/${companyA}/bank-accounts/${secondAccount}`,
      cid('bank-deactivate'),
      { expectedVersion: 1, active: false },
    );
    expect(deactivated.status, text(deactivated)).toBe(200);
    expect(record(record(deactivated.body).bankAccount)).toEqual(
      expect.objectContaining({ active: false, shownOnInvoices: false }),
    );
    const showInactive = await send(
      admin,
      'patch',
      `/api/c/${companyA}/bank-accounts/${secondAccount}`,
      cid('bank-show-inactive'),
      { expectedVersion: 2, shownOnInvoices: true },
    );
    expect(showInactive.status).toBe(422);
    expect(errorCode(showInactive.body)).toBe('account_inactive');
  });

  it('shows exactly one account when two are shown at the same time', async () => {
    const ids: string[] = [];
    for (const [index, iban] of [IBAN_CY, IBAN_GR].entries()) {
      const created = await send(
        admin,
        'post',
        `/api/c/${companyA}/bank-accounts`,
        cid(`bank-race-${String(index)}`),
        {
          bankName: `Race fictional bank ${String(index)} ${runId}`,
          accountHolder: 'Demo Company A Ltd (fictional)',
          iban,
        },
      );
      expect(created.status, text(created)).toBe(200);
      ids.push(stringField(record(record(created.body).bankAccount), 'id'));
    }
    const results = await Promise.all(
      ids.map((id, index) =>
        send(
          admin,
          'patch',
          `/api/c/${companyA}/bank-accounts/${id}`,
          cid(`bank-race-show-${String(index)}`),
          {
            expectedVersion: 0,
            shownOnInvoices: true,
          },
        ),
      ),
    );
    expect(results.map((response) => response.status)).toEqual([200, 200]);
    expect(
      (await bankAccounts(companyA)).filter((account) => account.shownOnInvoices),
    ).toHaveLength(1);
  });

  it('records whether a client accepts electronic invoices', async () => {
    const before = record(
      record(
        (await send(admin, 'get', `/api/c/${companyA}/clients/${clientId}`, cid('c-get'))).body,
      ).client,
    );
    expect(before.acceptsEInvoices).toBe(false);
    const correlationId = cid('client-einvoice');
    const saved = await send(
      admin,
      'patch',
      `/api/c/${companyA}/clients/${clientId}`,
      correlationId,
      {
        expectedVersion: numberField(before, 'version'),
        acceptsEInvoices: true,
      },
    );
    expect(saved.status, text(saved)).toBe(200);
    expect(record(record(saved.body).client)).toEqual(
      expect.objectContaining({
        acceptsEInvoices: true,
        version: numberField(before, 'version') + 1,
      }),
    );
    const events = await auditEvents(companyA, correlationId);
    expect(events[0]?.details).toEqual(expect.objectContaining({ acceptsEInvoices: true }));
  });

  it('keeps a draft in its document type and the company currency, and leaves credit-note drafts alone', async () => {
    const tax = await standardTax(companyA);
    const draft = await createDraft(admin, companyA, clientId, tax, cid('guard-draft'));
    const invoice = record(record(draft.body).invoice);
    const draftId = stringField(invoice, 'id');
    const sameType = await send(
      admin,
      'patch',
      `/api/c/${companyA}/invoices/${draftId}`,
      cid('guard-same'),
      {
        expectedVersion: 0,
        documentType: 'invoice',
        reference: 'Same type',
      },
    );
    expect(sameType.status, text(sameType)).toBe(200);
    const typeChange = await send(
      admin,
      'patch',
      `/api/c/${companyA}/invoices/${draftId}`,
      cid('guard-type'),
      {
        expectedVersion: 1,
        documentType: 'quote',
      },
    );
    expect(typeChange.status).toBe(409);
    expect(errorCode(typeChange.body)).toBe('document_type_locked');

    // The credit-note refusal on this route is tested with a real credit note in
    // invoice-issue.integration.test.ts.

    const usd = await send(admin, 'post', `/api/c/${companyA}/clients`, cid('usd-client'), {
      kind: 'organisation',
      displayName: `USD client ${runId}`,
      defaultCurrency: 'USD',
    });
    expect(usd.status, text(usd)).toBe(200);
    const usdClient = stringField(record(record(usd.body).client), 'id');
    const usdDraft = await createDraft(admin, companyA, usdClient, tax, cid('usd-draft'));
    expect(usdDraft.status).toBe(422);
    expect(errorCode(usdDraft.body)).toBe('currency_not_supported');
  });
});

async function createDraft(
  session: Session,
  companyId: string,
  clientId: string,
  taxCodeId: string,
  correlationId: string,
): Promise<request.Response> {
  return send(session, 'post', `/api/c/${companyId}/invoices`, correlationId, {
    clientId,
    pricesIncludeTax: false,
    lines: [
      {
        position: 1,
        description: 'Mixed nuts 500 g',
        quantity: '1',
        unit: 'pc',
        unitPrice: '10.00',
        taxCodeId,
      },
    ],
  });
}

async function createSeries(
  session: Session,
  companyId: string,
  documentType: 'invoice' | 'credit_note' | 'quote',
  name: string,
): Promise<string> {
  const response = await send(
    session,
    'post',
    `/api/c/${companyId}/invoice-series`,
    cid(`series-${name}`),
    {
      code: `${name}-${runId}`.slice(0, 32),
      documentType,
      prefix: `${name.toUpperCase()}-`,
    },
  );
  expect(response.status, text(response)).toBe(200);
  return stringField(record(record(response.body).series), 'id');
}

async function standardTax(companyId: string): Promise<string> {
  const row = await inCompany(companyId, (tx) =>
    tx.taxCode.findFirstOrThrow({ where: { companyId, code: 'STD19' }, select: { id: true } }),
  );
  return row.id;
}

async function companyVersion(companyId: string): Promise<number> {
  const row = await inCompany(companyId, (tx) =>
    tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { version: true } }),
  );
  return row.version;
}

async function seriesRowVersion(companyId: string, seriesId: string): Promise<number> {
  const row = await inCompany(companyId, (tx) =>
    tx.invoiceSeries.findUniqueOrThrow({ where: { id: seriesId }, select: { version: true } }),
  );
  return row.version;
}

function bankAccounts(companyId: string) {
  return inCompany(companyId, (tx) =>
    tx.companyBankAccount.findMany({
      where: { companyId },
      select: { id: true, shownOnInvoices: true, version: true },
    }),
  );
}

/** Waits until another session is blocked on a lock for this tax-code row. */
async function waitForLockWaiter(prisma: PrismaService, taxCodeId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await prisma.client.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE '%tax_code%' AND query ILIKE '%FOR SHARE%'
    `;
    if ((waiting[0]?.count ?? 0) > 0) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`no draft waited for tax code ${taxCodeId}`);
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
  return `fin-${name}-${runId}`.slice(0, 64);
}

async function auditEvents(companyId: string, correlationId: string) {
  const prisma = started().get(PrismaService);
  return prisma.client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.company_id', ${companyId}, true)`;
    return tx.auditEvent.findMany({ where: { correlationId }, orderBy: { occurredAt: 'asc' } });
  });
}

function inCompany<T>(companyId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return new TenantDb(started().get(PrismaService).client).run(
    { companyId, actor: 'finance-settings-test', correlationId: randomUUID() },
    fn,
  );
}

function text(response: request.Response): string {
  return JSON.stringify(response.body);
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
