import { type INestApplication } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { addDaysToBusinessDate, businessDateInZone, countedOn, parseAmount } from '@bp/domain';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertDatabaseNameIsTest,
  assertEnvConnectionsTargetTestDatabase,
  assertTestDatabaseUrls,
} from '../../../tools/test-db-guard.mjs';
import { AppModule } from './app.module';
import { PrismaService } from './database/prisma.service';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { LOG_STREAM } from './logging/logging.module';
import { datedAllocation } from './payments/settlement';

const runId = randomUUID().slice(0, 8);
const TIMEZONE = 'Asia/Nicosia';
type Session = { agent: ReturnType<typeof request.agent>; xsrf: string };
let app: INestApplication | undefined;
let storageRoot = '';
let mockRoot = '';

describe('finance reports (real Postgres)', () => {
  let company = '';
  let foreignCompany = '';
  let admin: Session;
  let viewer: Session;
  let clientA = '';
  let clientB = '';
  let standard = '';
  let reduced = '';
  let invoiceA = '';
  let invoiceB = '';
  let creditId = '';
  let voidedPaymentId = '';
  let refundId = '';
  let paymentA = '';
  const today = businessDateInZone(new Date(), TIMEZONE);
  const asOf = addDaysToBusinessDate(today, -2);
  const issuedOn = addDaysToBusinessDate(asOf, -1);

  beforeAll(async () => {
    const refusal = assertTestDatabaseUrls();
    if (refusal) throw new Error(refusal);
    await assertEnvConnectionsTargetTestDatabase();
    seedDatabase();
    storageRoot = mkdtempSync(join(tmpdir(), 'bp-r2g1-store-'));
    mockRoot = mkdtempSync(join(tmpdir(), 'bp-r2g1-print-'));
    process.env.STORAGE_ROOT = storageRoot;
    process.env.MOCK_PRINT_ROOT = mockRoot;
    process.env.APP_ENV = 'test';
    process.env.AUTH_DEV_LOGIN_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECURE = 'false';
    process.env.CSRF_SECRET = 'integration-test-csrf-secret';
    process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED = 'false';
    delete process.env.THROTTLE_ENABLED_IN_TEST;
    app = await bootApp();
    const prisma = app.get(PrismaService).client;
    const databases = await prisma.$queryRaw<{ current_database: string; current_user: string }[]>`
      SELECT current_database() AS current_database, current_user AS current_user
    `;
    assertDatabaseNameIsTest(databases[0]?.current_database, 'DATABASE_URL');
    expect(databases[0]?.current_user).toBe('bp_app');
    foreignCompany = (
      await prisma.company.findFirstOrThrow({
        where: { legalName: 'Demo Company B Ltd (fictional)' },
      })
    ).id;
    const owner = await login('owner@example.test');
    company = stringField(
      entity(
        await send(owner, 'post', '/api/platform/companies', {
          legalName: `Reports ${runId} Ltd (fictional)`,
          tradingName: `Reports ${runId}`,
          isFictional: true,
        }),
        'company',
      ),
      'id',
    );
    const adminEmail = `reports.${runId}@example.test`;
    const viewerEmail = `reports.viewer.${runId}@example.test`;
    await createUserWithRole(adminEmail, 'CA');
    await createUserWithRole(viewerEmail, 'FS');
    admin = await login(adminEmail);
    viewer = await login(viewerEmail);
    const taxes = await inCompany(company, (tx) => tx.taxCode.findMany());
    standard = taxes.find((tax) => tax.code === 'STD19')?.id ?? '';
    reduced = taxes.find((tax) => tax.code === 'RED9')?.id ?? '';
    expect(standard).not.toBe('');
    expect(reduced).not.toBe('');
    const series: string[] = [];
    for (const type of ['invoice', 'credit_note'] as const) {
      series.push(
        stringField(
          entity(
            await post('invoice-series', {
              code: `${type}-${runId}`,
              documentType: type,
              prefix: `${type === 'invoice' ? 'I' : 'C'}${runId}-`,
            }),
            'series',
          ),
          'id',
        ),
      );
    }
    const current = await inCompany(company, (tx) =>
      tx.company.findUniqueOrThrow({ where: { id: company } }),
    );
    expect(
      (
        await send(admin, 'patch', url('company'), {
          expectedVersion: current.version,
          vatNumber: 'CY00000000X',
          address: {
            line1: '1 Fictional Street',
            city: 'Nicosia',
            postcode: '1010',
            countryCode: 'CY',
          },
          defaultInvoiceSeriesId: series[0],
          defaultCreditNoteSeriesId: series[1],
        })
      ).status,
    ).toBe(200);
    const switched = await admin.agent
      .put(url('automation/switches/invoice.issue_real'))
      .set('X-XSRF-TOKEN', admin.xsrf)
      .send({ enabled: true, reason: 'Fictional report integration tests' });
    expect(switched.status, text(switched)).toBe(200);
    clientA = await createClient('A', 0);
    clientB = await createClient('B', 30);

    await onDate(issuedOn, async () => {
      const a = await issueInvoice(clientA, [
        line('100.00', standard, 1),
        line('100.00', reduced, 2),
      ]);
      invoiceA = stringField(a, 'id'); // 200.00 net + 28.00 VAT = 228.00.
      const b = await issueInvoice(clientB, [line('200.00', standard, 1)]);
      invoiceB = stringField(b, 'id'); // 200.00 net + 38.00 VAT = 238.00.
    });
    await onDate(asOf, async () => {
      paymentA = await payment(clientA, '200.00', 'bank_transfer');
      const paymentB = await payment(clientB, '150.00', 'bank_transfer');
      voidedPaymentId = await payment(clientB, '100.00', 'card');
      for (const [paymentId, invoiceId, amount] of [
        [paymentA, invoiceA, '100.00'],
        [paymentB, invoiceB, '80.00'],
        [voidedPaymentId, invoiceB, '60.00'],
      ])
        entity(await post('allocations', { paymentId, invoiceId, amount }), 'allocation');
      refundId = stringField(
        entity(
          await post('refunds', {
            paymentId: paymentA,
            amount: '20.00',
            refundedOn: asOf,
            method: 'cash',
          }),
          'refund',
        ),
        'id',
      );
      const original = entity(await get(`invoices/${invoiceB}`), 'invoice');
      const credit = entity(
        await post(`invoices/${invoiceB}/credit-notes`, {
          reason: 'Fictional returned half',
          lines: [
            {
              invoiceLineId: stringField(record(arrayOf(original.lines)[0]), 'id'),
              quantity: '0.5',
            },
          ],
        }),
        'creditNote',
      );
      creditId = stringField(
        entity(
          await post(`credit-notes/${stringField(credit, 'id')}/issue`, {
            expectedVersion: credit.version,
          }),
          'creditNote',
        ),
        'id',
      ); // 119.00: automatically applies 98.00, leaving 21.00 credit.
    });
    entity(
      await post(`payments/${voidedPaymentId}/void`, {
        expectedVersion: 0,
        reason: 'Fictional later void',
      }),
      'payment',
    );
  }, 120_000);

  afterAll(async () => {
    vi.useRealTimers();
    await app?.close();
    for (const root of [storageRoot, mockRoot])
      if (root) rmSync(root, { recursive: true, force: true });
    delete process.env.STORAGE_ROOT;
    delete process.env.MOCK_PRINT_ROOT;
  });

  it('agrees across invoiced, collected, open balances and ageing on the worked history', async () => {
    const invoiced = currency(await get(`reports/invoiced?from=${issuedOn}&to=${asOf}`));
    expect(invoiced).toMatchObject({
      currency: 'EUR',
      invoiced: { count: 2, net: '400.00', tax: '66.00', gross: '466.00' },
      credited: { count: 1, net: '100.00', tax: '19.00', gross: '119.00' },
      totals: {
        net: '300.00',
        tax: '47.00',
        gross: '347.00',
        basis: 'by issue date; credit notes subtracted',
      },
    });
    expect(arrayOf(invoiced.taxCodes)).toHaveLength(2);
    const codes = arrayOf(invoiced.taxCodes).map(record);
    expect(codes.find((row) => row.taxCodeId === standard)).toMatchObject({
      taxCodeId: standard,
      code: 'STD19',
      totals: { net: '200.00', tax: '38.00', gross: '238.00' },
    });
    expect(codes.find((row) => row.taxCodeId === reduced)).toMatchObject({
      taxCodeId: reduced,
      code: 'RED9',
      totals: { net: '100.00', tax: '9.00', gross: '109.00' },
    });
    const ageing = currency(await get(`reports/ageing?asOf=${asOf}`));
    expect(ageing).toMatchObject({
      openTotal: { amount: '128.00' },
      creditTotal: { amount: '211.00' },
      buckets: { current: { amount: '0.00' }, days1To30: { amount: '128.00' } },
    });
    const clients = arrayOf(ageing.clients).map(record);
    expect(clients.find((row) => row.clientId === clientA)).toMatchObject({
      openTotal: { amount: '128.00' },
      creditTotal: { amount: '80.00' },
      invoices: [{ id: invoiceA, openBalance: { amount: '128.00' }, bucket: 'days1To30' }],
    }); // 228.00 - 100.00 open; 200.00 - 100.00 - 20.00 credit.
    const historicalB = clients.find((row) => row.clientId === clientB);
    expect(historicalB).toMatchObject({
      openTotal: { amount: '0.00' },
      creditTotal: { amount: '131.00' },
      invoices: [],
    });
    const credits = arrayOf(historicalB?.credits).map(record);
    expect(credits.find((row) => row.id === creditId)).toMatchObject({
      type: 'credit_note',
      remaining: { amount: '21.00' },
    });
    expect(credits.find((row) => row.id === voidedPaymentId)).toMatchObject({
      remaining: { amount: '40.00' },
    });
    // (150.00 - 80.00) + (100.00 - 60.00) + (119.00 - 98.00) = 131.00.
    const allocations = await inCompany(company, (tx) => tx.allocation.findMany());
    const counted = countedOn(allocations.map(datedAllocation), asOf);
    expect(counted).toBe('338.00'); // 100.00 + 80.00 + 60.00 + 98.00.
    // Invoice-only gross is reconciled against ALL allocations, including the credit note.
    // The report's net gross (347.00) has already subtracted the entire credit note.
    expect(
      parseAmount(stringField(record(invoiced.invoiced), 'gross'), 2)
        .minus(counted)
        .toFixed(2),
    ).toBe('128.00');
    expect(record(ageing.openTotal).amount).toBe('128.00');
    // Net invoiced gross also reconciles: subtract cash allocations, add unused credit notes.
    expect(parseAmount('347.00', 2).minus('240.00').plus('21.00').toFixed(2)).toBe('128.00');

    const collected = currency(await get(`reports/collected?from=${issuedOn}&to=${asOf}`));
    expect(collected).toMatchObject({
      payments: { amount: '350.00', count: 2 },
      refunds: { amount: '20.00', count: 1 },
      total: {
        amount: '330.00',
        basis: 'by payment and refund date; voided payments and refunds are excluded',
      },
      methods: [
        { method: 'bank_transfer', payments: { amount: '350.00' }, total: { amount: '350.00' } },
        { method: 'cash', refunds: { amount: '20.00' }, total: { amount: '-20.00' } },
      ],
    }); // The later-voided card receipt is excluded from collected, even for this past period.

    const current = currency(await get(`reports/ageing?asOf=${today}`));
    expect(current).toMatchObject({
      openTotal: { amount: '188.00' },
      creditTotal: { amount: '171.00' },
      buckets: { current: { amount: '60.00' }, days1To30: { amount: '128.00' } },
    }); // 60.00 restored to B's invoice; the voided payment's 40.00 credit disappears.
    const b = arrayOf(current.clients)
      .map(record)
      .find((row) => row.clientId === clientB);
    expect(b).toMatchObject({ openTotal: { amount: '60.00' }, creditTotal: { amount: '91.00' } });
    expect(
      arrayOf(b?.credits)
        .map(record)
        .some((row) => row.id === voidedPaymentId),
    ).toBe(false);
    expect(entity(await get(`invoices/${invoiceA}`), 'invoice').openBalance).toBe('128.00');
    expect(entity(await get(`invoices/${invoiceB}`), 'invoice').openBalance).toBe('60.00');
    const accountA = await get(`clients/${clientA}/account`);
    const accountB = await get(`clients/${clientB}/account`);
    expect(accountA.body).toMatchObject({ openTotal: '128.00', creditTotal: '80.00' });
    expect(accountB.body).toMatchObject({ openTotal: '60.00', creditTotal: '91.00' });
    expectBasis(
      ageing,
      `as of ${asOf}, by due date; allocations and refunds counted by their effective dates`,
    );
    expectBasis(invoiced, 'by issue date; credit notes subtracted');
    expectBasis(collected, 'by payment and refund date; voided payments and refunds are excluded');
  });

  it('filters issue, receipt and refund dates inclusively and excludes drafts and quotes', async () => {
    const issueDay = currency(await get(`reports/invoiced?from=${issuedOn}&to=${issuedOn}`));
    expect(issueDay).toMatchObject({
      invoiced: { count: 2, gross: '466.00' },
      credited: { count: 0 },
    });
    const creditDay = currency(await get(`reports/invoiced?from=${asOf}&to=${asOf}`));
    expect(creditDay).toMatchObject({
      invoiced: { count: 0 },
      credited: { count: 1 },
      totals: { gross: '-119.00' },
    });
    expect((await get(`reports/collected?from=${issuedOn}&to=${issuedOn}`)).body).toMatchObject({
      currencies: [],
    });
    for (const documentType of ['invoice', 'quote']) {
      entity(
        await post('invoices', {
          clientId: clientA,
          documentType,
          pricesIncludeTax: false,
          lines: [line('999.00', standard, 1)],
        }),
        'invoice',
      );
    }
    expect((await get(`reports/invoiced?from=${today}&to=${today}`)).body).toMatchObject({
      currencies: [],
    });
    expect(
      (await get(`reports/ageing?asOf=${addDaysToBusinessDate(issuedOn, -1)}`)).body,
    ).toMatchObject({ currencies: [] });
  });

  it('reads frozen tax labels after live tax codes are renamed', async () => {
    const original = currency(await get(`reports/invoiced?from=${issuedOn}&to=${asOf}`));
    const tax = await inCompany(company, (tx) =>
      tx.taxCode.findUniqueOrThrow({ where: { id: standard } }),
    );
    const changed = await send(admin, 'patch', url(`tax-codes/${standard}`), {
      expectedVersion: tax.version,
      code: `NEW-${runId}`,
      name: 'Fictional renamed tax',
    });
    expect(changed.status, text(changed)).toBe(200);
    expect(currency(await get(`reports/invoiced?from=${issuedOn}&to=${asOf}`))).toEqual(original);
  });

  it.each([
    'reports/invoiced',
    'reports/invoiced?from=2026-02-30&to=2026-03-01',
    'reports/invoiced?from=2026-1-01&to=2026-01-02',
    'reports/invoiced?from=2026-01-01T00:00:00Z&to=2026-01-02',
    'reports/invoiced?from=2026-03-02&to=2026-03-01',
    'reports/invoiced?from=2026-01-01&to=2027-01-02',
    'reports/invoiced?from=2026-01-01&from=2026-01-02&to=2026-01-03',
    'reports/collected?from=bad&to=2026-01-01',
    'reports/collected?from=2026-01-01&to=2027-01-02',
    'reports/collected?from=2026-01-02&to=2026-01-01',
    'reports/ageing',
    'reports/ageing?asOf=2026-02-29',
    `reports/ageing?asOf=${addDaysToBusinessDate(today, 1)}`,
  ])('returns 422 invalid_date for %s', async (path) => {
    const response = await get(path);
    expect(response.status, text(response)).toBe(422);
    expect(record(record(response.body).error).code).toBe('invalid_date');
  });

  it('accepts 366 inclusive days, including leap day, and rejects 367', async () => {
    for (const path of ['invoiced', 'collected']) {
      for (const [from, to] of [
        ['2024-01-01', '2024-12-31'],
        ['2025-01-01', '2026-01-01'],
      ] as const) {
        expect((await get(`reports/${path}?from=${from}&to=${to}`)).status).toBe(200);
      }
      const tooLong = await get(`reports/${path}?from=2024-01-01&to=2025-01-01`);
      expect(tooLong.status, text(tooLong)).toBe(422);
    }
  });

  it('uses the company timezone to decide today for ageing', async () => {
    await onDate(`${today}T22:30:00Z`, async () => {
      const session = await login(`reports.${runId}@example.test`);
      const nextDay = addDaysToBusinessDate(today, 1);
      expect(businessDateInZone(new Date(), TIMEZONE)).toBe(nextDay);
      expect((await send(session, 'get', url(`reports/ageing?asOf=${nextDay}`))).status).toBe(200);
      expect(
        (
          await send(
            session,
            'get',
            url(`reports/ageing?asOf=${addDaysToBusinessDate(nextDay, 1)}`),
          )
        ).status,
      ).toBe(422);
    });
  });

  it('uses repeatable read for each report and writes no business rows or success audit', async () => {
    const prisma = started().get(PrismaService).client;
    const transact = prisma.$transaction.bind(prisma);
    const levels: unknown[] = [];
    const spy = vi.spyOn(prisma, '$transaction').mockImplementation((fn, options) => {
      if (options?.isolationLevel) levels.push(options.isolationLevel);
      return transact(fn, options);
    });
    const before = await inCompany(company, (tx) => tx.auditEvent.count());
    try {
      for (const path of reportPaths()) expect((await get(path)).status).toBe(200);
      expect(levels).toEqual(['RepeatableRead', 'RepeatableRead', 'RepeatableRead']);
      expect(await inCompany(company, (tx) => tx.auditEvent.count())).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });

  it('denies a member without report.finance.view and returns 404 for a foreign company, with denial audit', async () => {
    for (const path of reportPaths()) {
      for (const [session, companyId, status] of [
        [viewer, company, 403],
        [admin, foreignCompany, 404],
      ] as const) {
        const correlationId = randomUUID();
        const response = await send(session, 'get', url(path, companyId), undefined, correlationId);
        expect(response.status, text(response)).toBe(status);
        const events = await inCompany(companyId, (tx) =>
          tx.auditEvent.findMany({ where: { correlationId } }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            action: 'authorization.denied',
            outcome: 'denied',
            companyId,
            correlationId,
          }),
        );
      }
    }
  });

  it('excludes a voided refund from collected now, while historical credit still counts the refund', async () => {
    entity(
      await post(`refunds/${refundId}/void`, {
        expectedVersion: 0,
        reason: 'Fictional correction',
      }),
      'refund',
    );
    expect(currency(await get(`reports/collected?from=${issuedOn}&to=${asOf}`))).toMatchObject({
      payments: { amount: '350.00' },
      refunds: { amount: '0.00', count: 0 },
      total: { amount: '350.00' },
    });
    expect(currency(await get(`reports/ageing?asOf=${asOf}`))).toMatchObject({
      creditTotal: { amount: '211.00' },
    });
    expect(currency(await get(`reports/ageing?asOf=${today}`))).toMatchObject({
      creditTotal: { amount: '191.00' },
    });
  });

  it('keeps ageing in one snapshot when an allocation commits between invoice and credit reads', async () => {
    const path = `reports/ageing?asOf=${today}`;
    const before = currency(await get(path));
    const actor = await inCompany(company, (tx) =>
      tx.payment.findUniqueOrThrow({ where: { id: paymentA } }),
    );
    const allocationReady = deferred();
    const commitAllocation = deferred();
    const writer = inCompany(company, async (tx) => {
      await tx.allocation.create({
        data: {
          companyId: company,
          paymentId: paymentA,
          invoiceId: invoiceA,
          amount: '10.00',
          effectiveOn: new Date(`${today}T00:00:00Z`),
          createdById: actor.createdById,
        },
      });
      allocationReady.resolve();
      await commitAllocation.promise;
    });
    const prisma = started().get(PrismaService).client;
    const gated = prisma.$extends({
      query: {
        invoice: {
          async findMany({ args, query }) {
            const rows = await query(args);
            if (args.where?.companyId === company && args.where.documentType === 'invoice')
              commitAllocation.resolve();
            return rows;
          },
        },
        payment: {
          async findMany({ args, query }) {
            if (args.where?.companyId === company) await writer;
            return query(args);
          },
        },
      },
    });
    const transact = gated.$transaction.bind(gated) as typeof prisma.$transaction;
    const transactions = vi
      .spyOn(prisma, '$transaction')
      .mockImplementation((fn, options) => transact(fn, options));
    try {
      await Promise.race([allocationReady.promise, writer]);
      expect(currency(await get(path))).toEqual(before);
    } finally {
      commitAllocation.resolve();
      transactions.mockRestore();
      await writer;
    }
    expect(currency(await get(path))).toMatchObject({
      openTotal: { amount: '178.00' },
      creditTotal: { amount: '181.00' },
    });
  });

  function url(path: string, companyId = company) {
    return `/api/c/${companyId}/${path}`;
  }
  function post(path: string, body: unknown) {
    return send(admin, 'post', url(path), body).set('Idempotency-Key', randomUUID());
  }
  function get(path: string) {
    return send(admin, 'get', url(path));
  }
  function reportPaths() {
    return [
      `reports/invoiced?from=${issuedOn}&to=${asOf}`,
      `reports/collected?from=${issuedOn}&to=${asOf}`,
      `reports/ageing?asOf=${asOf}`,
    ];
  }
  function line(unitPrice: string, taxCodeId: string, position: number) {
    return {
      position,
      description: 'Fictional report item',
      quantity: '1',
      unit: 'item',
      unitPrice,
      taxCodeId,
    };
  }
  async function createClient(name: string, paymentTermsDays: number) {
    return stringField(
      entity(
        await post('clients', {
          kind: 'organisation',
          displayName: `Report client ${name} ${runId} (fictional)`,
          paymentTermsDays,
          addresses: [
            {
              kind: 'billing',
              line1: '2 Fictional Road',
              city: 'Nicosia',
              countryCode: 'CY',
              isDefault: true,
            },
          ],
        }),
        'client',
      ),
      'id',
    );
  }
  async function issueInvoice(clientId: string, lines: ReturnType<typeof line>[]) {
    const draft = entity(
      await post('invoices', { clientId, pricesIncludeTax: false, lines }),
      'invoice',
    );
    return entity(
      await post(`invoices/${stringField(draft, 'id')}/issue`, { expectedVersion: draft.version }),
      'invoice',
    );
  }
  async function payment(clientId: string, amount: string, method: string) {
    return stringField(
      entity(await post('payments', { clientId, amount, method, receivedOn: asOf }), 'payment'),
      'id',
    );
  }
  async function createUserWithRole(email: string, roleKey: string) {
    const prisma = started().get(PrismaService).client;
    const user = await prisma.userAccount.create({
      data: {
        email,
        displayName: `Reports ${runId}`,
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
    const granter = await prisma.userAccount.findFirstOrThrow({
      where: { email: 'owner@example.test' },
    });
    await inCompany(company, async (tx) => {
      const role = await tx.role.findFirstOrThrow({ where: { companyId: company, key: roleKey } });
      const membership = await tx.membership.create({
        data: { companyId: company, userId: user.id, status: 'active' },
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
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function onDate<T>(date: string, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(date.includes('T') ? date : `${date}T12:00:00Z`));
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}
function started(): INestApplication {
  if (!app) throw new Error('app is not started');
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
  const result = spawnSync('pnpm', ['--filter', '@bp/db', 'seed'], {
    cwd: resolve(process.cwd(), '../..'),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`seed exited ${String(result.status ?? result.signal)}`);
}
async function login(email: string): Promise<Session> {
  const agent = request.agent(started().getHttpServer() as App);
  const response = await agent.post('/api/auth/dev/login').send({ email });
  expect(response.status, text(response)).toBe(200);
  const headers: unknown = response.headers['set-cookie'];
  const cookies: string[] =
    typeof headers === 'string' ? [headers] : Array.isArray(headers) ? headers.map(String) : [];
  const cookie = cookies.find((value) => value.startsWith('XSRF-TOKEN='));
  if (!cookie) throw new Error('XSRF cookie missing');
  return {
    agent,
    xsrf: decodeURIComponent(cookie.split(';')[0]?.slice('XSRF-TOKEN='.length) ?? ''),
  };
}
function send(
  session: Session,
  method: 'get' | 'post' | 'patch',
  url: string,
  body?: unknown,
  correlationId = randomUUID(),
) {
  const call = session.agent[method](url)
    .set('X-XSRF-TOKEN', session.xsrf)
    .set('X-Correlation-Id', correlationId);
  if (body !== undefined) call.send(body as object);
  return call;
}
function inCompany<T>(companyId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return new TenantDb(started().get(PrismaService).client).run(
    { companyId, actor: 'reports-test', correlationId: randomUUID() },
    fn,
  );
}
function entity(response: request.Response, field: string): Record<string, unknown> {
  expect(response.status, text(response)).toBe(200);
  return record(record(response.body)[field]);
}
function currency(response: request.Response): Record<string, unknown> {
  expect(response.status, text(response)).toBe(200);
  const groups = arrayOf(record(response.body).currencies);
  expect(groups).toHaveLength(1);
  return record(groups[0]);
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('expected an object');
  return value as Record<string, unknown>;
}
function arrayOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected an array');
  return value;
}
function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field) throw new Error(`${key} is missing`);
  return field;
}
function text(response: request.Response): string {
  return JSON.stringify(response.body);
}
function expectBasis(value: unknown, basis: string): void {
  if (Array.isArray(value)) {
    for (const item of value) expectBasis(item, basis);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const row = record(value);
  if ('amount' in row || 'gross' in row || 'count' in row) expect(row.basis).toBe(basis);
  for (const child of Object.values(row)) expectBasis(child, basis);
}
