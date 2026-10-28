import { type INestApplication } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { addDaysToBusinessDate, businessDateInZone } from '@bp/domain';
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

const runId = randomUUID().slice(0, 8);
const TIMEZONE = 'Asia/Nicosia';
type Agent = ReturnType<typeof request.agent>;
type Session = { agent: Agent; xsrf: string };
let app: INestApplication | undefined;
let storageRoot = '';
let mockRoot = '';

describe('payments, allocations and refunds (real Postgres)', () => {
  let company = '';
  let foreignCompany = '';
  let admin: Session;
  let clientId = '';
  let otherClient = '';
  let foreignClient = '';
  const taxes = new Map<string, string>();

  beforeAll(async () => {
    const refusal = assertTestDatabaseUrls();
    if (refusal) throw new Error(refusal);
    await assertEnvConnectionsTargetTestDatabase();
    seedDatabase();
    storageRoot = mkdtempSync(join(tmpdir(), 'bp-r2e-store-'));
    mockRoot = mkdtempSync(join(tmpdir(), 'bp-r2e-print-'));
    process.env.STORAGE_ROOT = storageRoot;
    process.env.MOCK_PRINT_ROOT = mockRoot;
    process.env.APP_ENV = 'test';
    process.env.AUTH_DEV_LOGIN_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECURE = 'false';
    process.env.CSRF_SECRET = 'integration-test-csrf-secret';
    process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED = 'false';
    delete process.env.THROTTLE_ENABLED_IN_TEST;
    app = await bootApp();
    const databases = await app.get(PrismaService).client.$queryRaw<
      { current_database: string; current_user: string }[]
    >`
      SELECT current_database() AS current_database, current_user AS current_user
    `;
    assertDatabaseNameIsTest(databases[0]?.current_database, 'DATABASE_URL');
    expect(databases[0]?.current_user).toBe('bp_app');
    const owner = await login(started(), 'owner@example.test');
    const email = `payments.${runId}@example.test`;
    await createDevUser(email);
    const companies: string[] = [];
    for (const name of ['home', 'foreign']) {
      const created = await send(owner, 'post', '/api/platform/companies', cid(`company-${name}`), {
        legalName: `Payments ${name} ${runId} Ltd (fictional)`,
        tradingName: `Payments ${name} ${runId}`,
        isFictional: true,
      });
      const id = stringField(createdEntity(created, 'company'), 'id');
      companies.push(id);
      await grantRole(id, email, 'CA', 'owner@example.test');
    }
    [company, foreignCompany] = [companies[0] ?? '', companies[1] ?? ''];
    admin = await login(started(), email);
    for (const id of companies) {
      const tax = await inCompany(id, (tx) =>
        tx.taxCode.findFirstOrThrow({ where: { companyId: id, code: 'STD19' } }),
      );
      taxes.set(id, tax.id);
      const series: string[] = [];
      for (const type of ['invoice', 'credit_note'] as const) {
        const response = await send(
          admin,
          'post',
          `/api/c/${id}/invoice-series`,
          cid(`series-${type}`),
          {
            code: `${type === 'invoice' ? 'inv' : 'cn'}-${runId}`,
            documentType: type,
            prefix: `${type === 'invoice' ? 'P' : 'C'}${runId}-`,
          },
        );
        series.push(stringField(createdEntity(response, 'series'), 'id'));
      }
      const row = await inCompany(id, (tx) => tx.company.findUniqueOrThrow({ where: { id } }));
      const updated = await send(admin, 'patch', `/api/c/${id}/company`, cid('details'), {
        expectedVersion: row.version,
        vatNumber: 'CY00000000X',
        address: {
          line1: '1 Fictional Street',
          city: 'Nicosia',
          postcode: '1010',
          countryCode: 'CY',
        },
        defaultInvoiceSeriesId: series[0],
        defaultCreditNoteSeriesId: series[1],
      });
      expect(updated.status, text(updated)).toBe(200);
      const switched = await admin.agent
        .put(`/api/c/${id}/automation/switches/invoice.issue_real`)
        .set('X-XSRF-TOKEN', admin.xsrf)
        .set('X-Correlation-Id', cid('switch'))
        .send({ enabled: true, reason: 'Fictional payment integration tests' });
      expect(switched.status, text(switched)).toBe(200);
    }
    clientId = await createClient(company, 'Payment client');
    otherClient = await createClient(company, 'Another payment client');
    foreignClient = await createClient(foreignCompany, 'Foreign payment client');
  }, 120_000);

  afterAll(async () => {
    vi.useRealTimers();
    await app?.close();
    for (const root of [storageRoot, mockRoot])
      if (root) rmSync(root, { recursive: true, force: true });
    delete process.env.STORAGE_ROOT;
    delete process.env.MOCK_PRINT_ROOT;
  });

  it('records exact customer text, fully allocates a payment, reads remaining and audits both writes', async () => {
    const invoice = await issuedInvoice();
    const body = {
      ...paymentBody(),
      reference: '  Κατάθεση\nΑ  ',
      notes: '  Ευχαριστώ!\n\n  Κρατήστε το.  ',
    };
    const response = await post('payments', body, 'record-first', 'first');
    const payment = createdEntity(response, 'payment');
    expect(payment).toMatchObject({
      ...body,
      currency: 'EUR',
      status: 'recorded',
      remaining: '100.00',
      allocations: [],
      refunds: [],
    });
    const allocation = createdEntity(
      await post(
        'allocations',
        { paymentId: payment.id, invoiceId: invoice.id, amount: '100.00' },
        'allocate-first',
        'allocate-first',
      ),
      'allocation',
    );
    expect(allocation).toMatchObject({ amount: '100.00', effectiveOn: today(), reversedOn: null });
    const detail = createdEntity(await get(`payments/${stringField(payment, 'id')}`), 'payment');
    expect(detail.remaining).toBe('0.00');
    expect(arrayOf(detail.allocations)).toEqual([
      expect.objectContaining({ id: allocation.id, invoiceNumber: invoice.number }),
    ]);
    await expectAudit('first', 'payment.recorded', 'success', stringField(payment, 'id'));
    await expectAudit(
      'allocate-first',
      'allocation.created',
      'success',
      stringField(allocation, 'id'),
    );
    const listed = await get(`payments?clientId=${clientId}`);
    expect(listed.status, text(listed)).toBe(200);
    expect(arrayOf(record(listed.body).payments)).toContainEqual(
      expect.objectContaining({ id: payment.id, remaining: '0.00' }),
    );
  });

  it('serializes concurrent same-key retries, hashes parsed bodies canonically, and refuses key reuse', async () => {
    const body = paymentBody();
    const [first, second] = await Promise.all([
      post('payments', body, 'same-payment', 'idem-first'),
      post(
        'payments',
        {
          method: body.method,
          amount: body.amount,
          receivedOn: body.receivedOn,
          clientId: body.clientId,
        },
        'same-payment',
        'idem-retry',
      ),
    ]);
    const payment = createdEntity(first, 'payment');
    expect(second.status, text(second)).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(
      await inCompany(company, (tx) =>
        tx.payment.count({ where: { id: stringField(payment, 'id') } }),
      ),
    ).toBe(1);
    const events = await inCompany(company, (tx) =>
      tx.auditEvent.findMany({
        where: { action: 'payment.recorded', objectId: stringField(payment, 'id') },
      }),
    );
    expect(events).toHaveLength(1);
    const reused = await post(
      'payments',
      { ...body, amount: '99.00' },
      'same-payment',
      'idem-reuse',
    );
    expect(reused.status, text(reused)).toBe(409);
    expect(errorCode(reused.body)).toBe('idempotency_key_reused');
    await expectAudit('idem-reuse', 'payment.recorded', 'failure');
    const missing = await send(admin, 'post', url('payments'), cid('no-key'), body);
    expect(missing.status, text(missing)).toBe(400);
    expect(errorCode(missing.body)).toBe('idempotency_key_required');
    for (const key of ['x'.repeat(201), 'é']) {
      const bad = await post('payments', body, key, 'invalid-key', false);
      expect(bad.status, text(bad)).toBe(400);
      expect(errorCode(bad.body)).toBe('invalid_idempotency_key');
    }
  });

  it('replays a refund after its answer was lost, even after it was voided, with only one record and audit', async () => {
    const payment = await recordPayment();
    const body = refundBody(stringField(payment, 'id'), '30.00');
    const lost = await post('refunds', body, 'lost-refund', 'lost-refund');
    const refund = createdEntity(lost, 'refund');
    const voided = await post(`refunds/${stringField(refund, 'id')}/void`, {
      expectedVersion: 0,
      reason: 'Incorrect recording',
    });
    expect(voided.status, text(voided)).toBe(200);
    const retried = await post('refunds', body, 'lost-refund', 'retried-refund');
    expect(retried.status, text(retried)).toBe(200);
    expect(retried.body).toEqual(lost.body);
    expect(
      await inCompany(company, (tx) =>
        tx.refund.count({ where: { paymentId: stringField(payment, 'id') } }),
      ),
    ).toBe(1);
    expect(
      await inCompany(company, (tx) =>
        tx.auditEvent.count({
          where: { action: 'refund.recorded', objectId: stringField(refund, 'id') },
        }),
      ),
    ).toBe(1);
    expect(await auditEvents('retried-refund')).toEqual([]);
    await expectAudit('lost-refund', 'refund.recorded', 'success', stringField(refund, 'id'));
  });

  it('lets exactly one concurrent allocation spend an insufficient payment', async () => {
    const payment = await recordPayment();
    const a = await issuedInvoice();
    const b = await issuedInvoice();
    const responses = await Promise.all(
      [a, b].map((invoice) =>
        post('allocations', { paymentId: payment.id, invoiceId: invoice.id, amount: '80.00' }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(errorCode(responses.find((response) => response.status === 409)?.body)).toBe(
      'over_allocation',
    );
    expect(
      createdEntity(await get(`payments/${stringField(payment, 'id')}`), 'payment').remaining,
    ).toBe('20.00');
  });

  it('lets exactly one concurrent refund of 80.00 use a payment of 100.00', async () => {
    const payment = await recordPayment();
    const responses = await Promise.all([
      post('refunds', refundBody(stringField(payment, 'id'), '80.00')),
      post('refunds', refundBody(stringField(payment, 'id'), '80.00')),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(errorCode(responses.find((response) => response.status === 409)?.body)).toBe(
      'over_allocation',
    );
    expect(
      await inCompany(company, (tx) =>
        tx.refund.count({ where: { paymentId: stringField(payment, 'id') } }),
      ),
    ).toBe(1);
  });

  it('does not allocate credit already refunded, and serializes a refund against an allocation', async () => {
    const invoice = await issuedInvoice();
    const payment = await recordPayment();
    createdEntity(
      await post('refunds', refundBody(stringField(payment, 'id'), '100.00')),
      'refund',
    );
    const refused = await post('allocations', {
      paymentId: payment.id,
      invoiceId: invoice.id,
      amount: '0.01',
    });
    expect(refused.status, text(refused)).toBe(409);
    expect(errorCode(refused.body)).toBe('over_allocation');
    const racing = await recordPayment();
    const responses = await Promise.all([
      post('allocations', { paymentId: racing.id, invoiceId: invoice.id, amount: '100.00' }),
      post('refunds', refundBody(stringField(racing, 'id'), '100.00')),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(errorCode(responses.find((response) => response.status === 409)?.body)).toBe(
      'over_allocation',
    );
  });

  it('refuses mismatched clients, drafts and credit-note targets, with failure audits', async () => {
    const payment = await recordPayment();
    const wrongClient = await issuedInvoice(otherClient);
    const draft = await createDraft();
    const original = await issuedInvoice();
    const credit = await issuedCredit(stringField(original, 'id'), '0.4');
    for (const [index, target] of [wrongClient, draft, credit].entries()) {
      const name = `bad-target-${String(index)}`;
      const refused = await post(
        'allocations',
        { paymentId: payment.id, invoiceId: target.id, amount: '10.00' },
        randomUUID(),
        name,
      );
      expect(refused.status, text(refused)).toBe(409);
      expect(errorCode(refused.body)).toBe('not_allocatable');
      await expectAudit(name, 'allocation.created', 'failure');
    }
    for (const source of [draft, original]) {
      const refused = await post('refunds', {
        creditNoteId: source.id,
        amount: '1.00',
        refundedOn: today(),
        method: 'other',
      });
      expect(refused.status, text(refused)).toBe(409);
      expect(errorCode(refused.body)).toBe('not_allocatable');
    }
  });

  it('uses credit notes after a fully paid invoice to settle another invoice or record a refund', async () => {
    const invoice = await issuedInvoice();
    const payment = await recordPayment();
    createdEntity(
      await post('allocations', { paymentId: payment.id, invoiceId: invoice.id, amount: '100.00' }),
      'allocation',
    );
    const credit = await issuedCredit(stringField(invoice, 'id'), '0.4');
    expect(credit.total).toBe('40.00');
    const target = await issuedInvoice();
    const body = { creditNoteId: credit.id, invoiceId: target.id, amount: '40.00' };
    const allocated = await post('allocations', body, 'credit-allocation', 'credit-allocation');
    const allocation = createdEntity(allocated, 'allocation');
    expect(allocation).toMatchObject({
      creditNoteId: credit.id,
      paymentId: null,
      effectiveOn: today(),
    });
    expect((await post('allocations', body, 'credit-allocation')).body).toEqual(allocated.body);
    const otherCredit = await issuedCredit(stringField(invoice, 'id'), '0.4');
    const refunded = createdEntity(
      await post('refunds', {
        creditNoteId: otherCredit.id,
        amount: '40.00',
        refundedOn: today(),
        method: 'cash',
        reference: '  Πίστωση  ',
        notes: '\n  Επιστροφή.\n',
      }),
      'refund',
    );
    expect(refunded).toMatchObject({
      paymentId: null,
      creditNoteId: otherCredit.id,
      amount: '40.00',
      reference: '  Πίστωση  ',
      notes: '\n  Επιστροφή.\n',
    });
    // Each credit is independent of the original invoice's settled balance.
    expect(
      createdEntity(await get(`payments/${stringField(payment, 'id')}`), 'payment').remaining,
    ).toBe('0.00');
    await expectAudit(
      'credit-allocation',
      'allocation.created',
      'success',
      stringField(allocation, 'id'),
    );
  });

  it('serializes two payments competing for one invoice and two uses of one credit note', async () => {
    const invoice = await issuedInvoice();
    const payments = [await recordPayment(), await recordPayment()];
    const targets = await Promise.all(
      payments.map((payment) =>
        post('allocations', { paymentId: payment.id, invoiceId: invoice.id, amount: '80.00' }),
      ),
    );
    expect(targets.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(errorCode(targets.find((response) => response.status === 409)?.body)).toBe(
      'over_allocation',
    );
    const credit = await issuedCredit(stringField(invoice, 'id'), '1');
    const otherInvoice = await issuedInvoice();
    const uses = await Promise.all([
      post('allocations', { creditNoteId: credit.id, invoiceId: otherInvoice.id, amount: '80.00' }),
      post('refunds', {
        creditNoteId: credit.id,
        amount: '80.00',
        refundedOn: today(),
        method: 'cash',
      }),
    ]);
    expect(uses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(errorCode(uses.find((response) => response.status === 409)?.body)).toBe(
      'over_allocation',
    );
  });

  it('reallocates only from the reversal date and refuses a backdated refund that would overspend history', async () => {
    const historical = addDaysToBusinessDate(today(), -2);
    let payment: Record<string, unknown>;
    let first: Record<string, unknown>;
    let second: Record<string, unknown>;
    let allocation: Record<string, unknown>;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${historical}T12:00:00Z`));
    try {
      first = await issuedInvoice();
      second = await issuedInvoice();
      payment = await recordPayment();
      allocation = createdEntity(
        await post('allocations', { paymentId: payment.id, invoiceId: first.id, amount: '100.00' }),
        'allocation',
      );
      expect(allocation.effectiveOn).toBe(historical);
    } finally {
      vi.useRealTimers();
    }
    const reversed = createdEntity(
      await post(
        `allocations/${stringField(allocation, 'id')}/reverse`,
        { reason: '  Move credit\n  ' },
        randomUUID(),
        'reverse-historical',
      ),
      'allocation',
    );
    expect(reversed).toMatchObject({ reversedOn: today(), reversalReason: '  Move credit\n  ' });
    const backdated = await post('refunds', {
      ...refundBody(stringField(payment, 'id'), '100.00'),
      refundedOn: historical,
    });
    expect(backdated.status, text(backdated)).toBe(409);
    expect(errorCode(backdated.body)).toBe('over_allocation');
    const next = createdEntity(
      await post('allocations', { paymentId: payment.id, invoiceId: second.id, amount: '100.00' }),
      'allocation',
    );
    expect(next.effectiveOn).toBe(today());
    const repeated = await post(`allocations/${stringField(allocation, 'id')}/reverse`, {
      reason: 'Again',
    });
    expect(repeated.status, text(repeated)).toBe(409);
    expect(errorCode(repeated.body)).toBe('already_reversed');
    await expectAudit(
      'reverse-historical',
      'allocation.reversed',
      'success',
      stringField(allocation, 'id'),
    );
  });

  it('voids a payment with version checks and reverses all its active allocations today', async () => {
    const payment = await recordPayment();
    const allocations: string[] = [];
    for (const invoice of [await issuedInvoice(), await issuedInvoice()]) {
      allocations.push(
        stringField(
          createdEntity(
            await post('allocations', {
              paymentId: payment.id,
              invoiceId: invoice.id,
              amount: '50.00',
            }),
            'allocation',
          ),
          'id',
        ),
      );
    }
    const path = `payments/${stringField(payment, 'id')}/void`;
    const stale = await post(path, { expectedVersion: 1, reason: 'Mistake' });
    expect(stale.status, text(stale)).toBe(409);
    expect(record(record(stale.body).error).message).toBe('version_conflict');
    expect(
      createdEntity(await get(`payments/${stringField(payment, 'id')}`), 'payment').status,
    ).toBe('recorded');
    const result = createdEntity(
      await post(path, { expectedVersion: 0, reason: '  Mistake\n' }, randomUUID(), 'void-payment'),
      'payment',
    );
    expect(result).toMatchObject({
      status: 'voided',
      voidedOn: today(),
      voidReason: '  Mistake\n',
      version: 1,
    });
    for (const id of allocations) {
      expect(arrayOf(result.allocations)).toContainEqual(
        expect.objectContaining({ id, reversedOn: today(), reversalReason: '  Mistake\n' }),
      );
    }
    await expectAudit('void-payment', 'payment.voided', 'success', stringField(payment, 'id'));
    expect(record((await auditEvents('void-payment'))[0]?.details).reversedAllocationIds).toEqual(
      [...allocations].sort(),
    );
    const twice = await post(path, { expectedVersion: 1, reason: 'Again' });
    expect(twice.status, text(twice)).toBe(409);
    expect(errorCode(twice.body)).toBe('not_recorded');
    const invoice = await issuedInvoice();
    for (const response of [
      await post('allocations', { paymentId: payment.id, invoiceId: invoice.id, amount: '1.00' }),
      await post('refunds', refundBody(stringField(payment, 'id'), '1.00')),
    ]) {
      expect(response.status, text(response)).toBe(409);
      expect(errorCode(response.body)).toBe('not_allocatable');
    }
  });

  it('refuses a payment void until its recorded refund is voided', async () => {
    const payment = await recordPayment();
    const refund = createdEntity(
      await post('refunds', refundBody(stringField(payment, 'id'), '40.00')),
      'refund',
    );
    const paymentPath = `payments/${stringField(payment, 'id')}/void`;
    const refused = await post(
      paymentPath,
      { expectedVersion: 0, reason: 'Mistake' },
      randomUUID(),
      'void-refunded',
    );
    expect(refused.status, text(refused)).toBe(409);
    expect(errorCode(refused.body)).toBe('payment_refunded');
    await expectAudit('void-refunded', 'payment.voided', 'failure');
    const refundPath = `refunds/${stringField(refund, 'id')}/void`;
    const stale = await post(refundPath, { expectedVersion: 1, reason: 'Mistake' });
    expect(stale.status, text(stale)).toBe(409);
    expect(record(record(stale.body).error).message).toBe('version_conflict');
    const voided = createdEntity(
      await post(
        refundPath,
        { expectedVersion: 0, reason: 'Wrong refund' },
        randomUUID(),
        'void-refund',
      ),
      'refund',
    );
    expect(voided).toMatchObject({
      status: 'voided',
      voidedOn: today(),
      voidReason: 'Wrong refund',
      version: 1,
    });
    await expectAudit('void-refund', 'refund.voided', 'success', stringField(refund, 'id'));
    const repeated = await post(refundPath, { expectedVersion: 1, reason: 'Again' });
    expect(repeated.status, text(repeated)).toBe(409);
    expect(errorCode(repeated.body)).toBe('not_recorded');
    expect((await post(paymentPath, { expectedVersion: 0, reason: 'Mistake' })).status).toBe(200);
  });

  it('rejects negative, zero and JSON-number amounts on all three creation routes', async () => {
    const payment = await recordPayment();
    const invoice = await issuedInvoice();
    for (const amount of ['-100.00', '0.00', 100, 'NaN', '1.001', '100000000000000000.00']) {
      for (const [path, body] of [
        ['payments', { ...paymentBody(), amount }],
        ['allocations', { paymentId: payment.id, invoiceId: invoice.id, amount }],
        ['refunds', { ...refundBody(stringField(payment, 'id'), '1.00'), amount }],
      ] as const) {
        const response = await post(path, body);
        expect(response.status, `${path} ${String(amount)} ${text(response)}`).toBe(400);
      }
    }
  });

  it('validates real business dates and exactly one source, and rejects extra fields and blank reasons', async () => {
    const payment = await recordPayment({ receivedOn: today() });
    const invoice = await issuedInvoice();
    for (const value of [
      '2026-02-30',
      '2026-13-01',
      '2026-2-01',
      addDaysToBusinessDate(today(), 1),
    ]) {
      for (const [path, body] of [
        ['payments', { ...paymentBody(), receivedOn: value }],
        ['refunds', { ...refundBody(stringField(payment, 'id'), '1.00'), refundedOn: value }],
      ] as const) {
        const response = await post(path, body);
        expect(response.status, text(response)).toBe(422);
        expect(errorCode(response.body)).toBe('invalid_date');
      }
    }
    const beforeSource = await post('refunds', {
      ...refundBody(stringField(payment, 'id'), '1.00'),
      refundedOn: addDaysToBusinessDate(today(), -1),
    });
    expect(beforeSource.status, text(beforeSource)).toBe(422);
    expect(errorCode(beforeSource.body)).toBe('invalid_date');
    for (const sources of [{}, { paymentId: payment.id, creditNoteId: invoice.id }]) {
      for (const [path, body] of [
        ['allocations', { ...sources, invoiceId: invoice.id, amount: '1.00' }],
        ['refunds', { ...sources, amount: '1.00', refundedOn: today(), method: 'cash' }],
      ] as const)
        expect((await post(path, body)).status).toBe(400);
    }
    expect((await post('payments', { ...paymentBody(), currency: 'EUR' })).status).toBe(400);
    expect(
      (
        await post(`payments/${stringField(payment, 'id')}/void`, {
          expectedVersion: 0,
          reason: ' \n ',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          'allocations',
          { paymentId: payment.id, invoiceId: invoice.id, amount: '1.00' },
          undefined,
          'no-allocate-key',
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          'refunds',
          refundBody(stringField(payment, 'id'), '1.00'),
          undefined,
          'no-refund-key',
        )
      ).status,
    ).toBe(400);
  });

  it('completes issue, credit issue, settlement, void and settings writes concurrently without deadlocks', async () => {
    const invoice = await issuedInvoice();
    const draft = await createDraft();
    const creditDraft = createdEntity(
      await send(
        admin,
        'post',
        url(`invoices/${stringField(invoice, 'id')}/credit-notes`),
        cid('race-credit-draft'),
        {
          reason: 'Fictional race return',
          lines: [
            {
              invoiceLineId: stringField(record(arrayOf(invoice.lines)[0]), 'id'),
              quantity: '0.4',
            },
          ],
        },
      ),
      'creditNote',
    );
    const payment = await recordPayment();
    const toVoid = await recordPayment();
    createdEntity(
      await post('allocations', { paymentId: toVoid.id, invoiceId: invoice.id, amount: '10.00' }),
      'allocation',
    );
    const refundSource = await recordPayment();
    const refund = createdEntity(
      await post('refunds', refundBody(stringField(refundSource, 'id'), '10.00')),
      'refund',
    );
    const settings = await inCompany(company, (tx) =>
      tx.company.findUniqueOrThrow({ where: { id: company } }),
    );
    const tax = await inCompany(company, (tx) =>
      tx.taxCode.findUniqueOrThrow({ where: { id: taxes.get(company) } }),
    );
    const calls = [
      send(admin, 'post', url(`invoices/${stringField(draft, 'id')}/issue`), cid('race-issue'), {
        expectedVersion: draft.version,
      }),
      send(
        admin,
        'post',
        url(`credit-notes/${stringField(creditDraft, 'id')}/issue`),
        cid('race-credit-issue'),
        { expectedVersion: creditDraft.version },
      ),
      post('allocations', { paymentId: payment.id, invoiceId: invoice.id, amount: '20.00' }),
      post('refunds', refundBody(stringField(payment, 'id'), '10.00')),
      post(`payments/${stringField(toVoid, 'id')}/void`, {
        expectedVersion: 0,
        reason: 'Fictional correction',
      }),
      post(`refunds/${stringField(refund, 'id')}/void`, {
        expectedVersion: 0,
        reason: 'Fictional correction',
      }),
      send(admin, 'patch', url('company'), cid('race-company'), {
        expectedVersion: settings.version,
        invoiceTermsEn: 'Fictional race terms',
      }),
      send(admin, 'patch', url(`tax-codes/${tax.id}`), cid('race-tax'), {
        expectedVersion: tax.version,
        name: 'Standard 19% (fictional race)',
      }),
    ];
    const responses = await Promise.all(calls);
    for (const response of responses) expect(response.status, text(response)).toBe(200);
    expect(
      createdEntity(await get(`payments/${stringField(payment, 'id')}`), 'payment').remaining,
    ).toBe('70.00');
  });

  it('refuses payment recording for a company whose currency is not EUR', async () => {
    const owner = await login(started(), 'owner@example.test');
    const created = await send(owner, 'post', '/api/platform/companies', cid('usd-company'), {
      legalName: `USD payments ${runId} Ltd (fictional)`,
      tradingName: `USD payments ${runId}`,
      defaultCurrency: 'USD',
      isFictional: true,
    });
    const usdCompany = stringField(createdEntity(created, 'company'), 'id');
    await grantRole(usdCompany, `payments.${runId}@example.test`, 'CA', 'owner@example.test');
    const usdClient = await createClient(usdCompany, 'USD client');
    const response = await post(
      'payments',
      { ...paymentBody(), clientId: usdClient },
      randomUUID(),
      'usd-payment',
      true,
      usdCompany,
    );
    expect(response.status, text(response)).toBe(422);
    expect(errorCode(response.body)).toBe('currency_not_supported');
    expect(await inCompany(usdCompany, (tx) => tx.payment.count())).toBe(0);
    expect(
      await inCompany(usdCompany, (tx) =>
        tx.auditEvent.findMany({ where: { correlationId: cid('usd-payment') } }),
      ),
    ).toEqual([expect.objectContaining({ action: 'payment.recorded', outcome: 'failure' })]);
  });

  it('requires payment.record for every write and permits invoice.view to read', async () => {
    const payment = await recordPayment();
    const email = `payment.auditor.${runId}@example.test`;
    await createDevUser(email);
    await grantRole(company, email, 'AUD', 'owner@example.test');
    const viewer = await login(started(), email);
    for (const [index, path] of [
      'payments',
      'allocations',
      `allocations/${randomUUID()}/reverse`,
      `payments/${stringField(payment, 'id')}/void`,
      'refunds',
      `refunds/${randomUUID()}/void`,
    ].entries()) {
      const name = `denied-write-${String(index)}`;
      const response = await send(viewer, 'post', url(path), cid(name), {}).set(
        'Idempotency-Key',
        randomUUID(),
      );
      expect(response.status, `${path} ${text(response)}`).toBe(403);
      const events = await auditEvents(name);
      expect(events).toContainEqual(
        expect.objectContaining({ action: 'authorization.denied', outcome: 'denied' }),
      );
    }
    for (const path of ['payments', `payments/${stringField(payment, 'id')}`]) {
      const response = await send(viewer, 'get', url(path), cid('viewer-read'));
      expect(response.status, text(response)).toBe(200);
    }
  });

  it('returns 404 for every foreign id without changing either company', async () => {
    const foreignPayment = createdEntity(
      await post(
        'payments',
        { ...paymentBody(), clientId: foreignClient },
        randomUUID(),
        'foreign-payment',
        true,
        foreignCompany,
      ),
      'payment',
    );
    const foreignInvoice = await issuedInvoice(foreignClient, foreignCompany);
    const foreignCredit = await issuedCredit(
      stringField(foreignInvoice, 'id'),
      '0.4',
      foreignCompany,
    );
    const foreignAllocation = createdEntity(
      await post(
        'allocations',
        { paymentId: foreignPayment.id, invoiceId: foreignInvoice.id, amount: '10.00' },
        randomUUID(),
        'foreign-allocation',
        true,
        foreignCompany,
      ),
      'allocation',
    );
    const foreignRefund = createdEntity(
      await post(
        'refunds',
        refundBody(stringField(foreignPayment, 'id'), '10.00'),
        randomUUID(),
        'foreign-refund',
        true,
        foreignCompany,
      ),
      'refund',
    );
    const localInvoice = await issuedInvoice();
    const localPayment = await recordPayment();
    const before = await financialSnapshot();
    const calls: (() => PromiseLike<request.Response>)[] = [
      () => post('payments', { ...paymentBody(), clientId: foreignClient }),
      () =>
        post('allocations', {
          paymentId: foreignPayment.id,
          invoiceId: localInvoice.id,
          amount: '1.00',
        }),
      () =>
        post('allocations', {
          creditNoteId: foreignCredit.id,
          invoiceId: localInvoice.id,
          amount: '1.00',
        }),
      () =>
        post('allocations', {
          paymentId: localPayment.id,
          invoiceId: foreignInvoice.id,
          amount: '1.00',
        }),
      () =>
        post(`allocations/${stringField(foreignAllocation, 'id')}/reverse`, { reason: 'Foreign' }),
      () => get(`payments/${stringField(foreignPayment, 'id')}`),
      () => get(`payments?clientId=${foreignClient}`),
      () =>
        post(`payments/${stringField(foreignPayment, 'id')}/void`, {
          expectedVersion: 0,
          reason: 'Foreign',
        }),
      () => post('refunds', refundBody(stringField(foreignPayment, 'id'), '1.00')),
      () =>
        post('refunds', {
          creditNoteId: foreignCredit.id,
          amount: '1.00',
          refundedOn: today(),
          method: 'other',
        }),
      () =>
        post(`refunds/${stringField(foreignRefund, 'id')}/void`, {
          expectedVersion: 0,
          reason: 'Foreign',
        }),
      () => get('payments/not-a-uuid'),
    ];
    for (const call of calls) {
      const response = await call();
      expect(response.status, text(response)).toBe(404);
    }
    expect(await financialSnapshot()).toEqual(before);
  });

  function url(path: string, companyId = company) {
    return `/api/c/${companyId}/${path}`;
  }
  function today() {
    return businessDateInZone(new Date(), TIMEZONE);
  }
  function paymentBody() {
    return { clientId, receivedOn: today(), amount: '100.00', method: 'bank_transfer' };
  }
  function refundBody(paymentId: string, amount: string) {
    return { paymentId, amount, refundedOn: today(), method: 'cash' };
  }
  function post(
    path: string,
    body: unknown,
    key: string = randomUUID(),
    name: string = randomUUID(),
    prefixKey = true,
    companyId = company,
  ) {
    const call = send(admin, 'post', url(path, companyId), cid(name), body);
    // Explicit undefined with a no-*-key name tests the missing-header case.
    if (!name.startsWith('no-')) call.set('Idempotency-Key', prefixKey ? `${runId}-${key}` : key);
    return call;
  }
  function get(path: string) {
    return send(admin, 'get', url(path), cid(randomUUID()));
  }
  async function recordPayment(extra: Record<string, unknown> = {}) {
    return createdEntity(await post('payments', { ...paymentBody(), ...extra }), 'payment');
  }
  async function createClient(companyId: string, name: string) {
    const response = await send(admin, 'post', url('clients', companyId), cid('client'), {
      kind: 'organisation',
      displayName: `${name} ${runId} (fictional)`,
      addresses: [
        {
          kind: 'billing',
          line1: '2 Fictional Road',
          city: 'Nicosia',
          countryCode: 'CY',
          isDefault: true,
        },
      ],
    });
    return stringField(createdEntity(response, 'client'), 'id');
  }
  async function createDraft(client = clientId, companyId = company) {
    const response = await send(admin, 'post', url('invoices', companyId), cid('draft'), {
      clientId: client,
      pricesIncludeTax: true,
      lines: [
        {
          position: 1,
          description: 'Fictional gift box',
          quantity: '1',
          unit: 'box',
          unitPrice: '100.00',
          taxCodeId: taxes.get(companyId),
        },
      ],
    });
    return createdEntity(response, 'invoice');
  }
  async function issuedInvoice(client = clientId, companyId = company) {
    const draft = await createDraft(client, companyId);
    return createdEntity(
      await send(
        admin,
        'post',
        url(`invoices/${stringField(draft, 'id')}/issue`, companyId),
        cid('issue'),
        { expectedVersion: draft.version },
      ),
      'invoice',
    );
  }
  async function issuedCredit(invoiceId: string, quantity: string, companyId = company) {
    const detail = createdEntity(
      await send(admin, 'get', url(`invoices/${invoiceId}`, companyId), cid('original')),
      'invoice',
    );
    const invoiceLineId = stringField(record(arrayOf(detail.lines)[0]), 'id');
    const draft = createdEntity(
      await send(
        admin,
        'post',
        url(`invoices/${invoiceId}/credit-notes`, companyId),
        cid('credit-draft'),
        { reason: 'Fictional returned goods', lines: [{ invoiceLineId, quantity }] },
      ),
      'creditNote',
    );
    return createdEntity(
      await send(
        admin,
        'post',
        url(`credit-notes/${stringField(draft, 'id')}/issue`, companyId),
        cid('credit-issue'),
        { expectedVersion: draft.version },
      ),
      'creditNote',
    );
  }
  function auditEvents(name: string) {
    return inCompany(company, (tx) =>
      tx.auditEvent.findMany({ where: { correlationId: cid(name) } }),
    );
  }
  async function expectAudit(name: string, action: string, outcome: string, objectId?: string) {
    expect(await auditEvents(name)).toEqual([
      expect.objectContaining({
        action,
        outcome,
        companyId: company,
        correlationId: cid(name),
        ...(objectId ? { objectId } : {}),
        actorType: 'user',
      }),
    ]);
  }
  async function financialSnapshot() {
    return Promise.all(
      [company, foreignCompany].map((companyId) =>
        inCompany(companyId, async (tx) => ({
          payments: await tx.payment.findMany({ orderBy: { id: 'asc' } }),
          allocations: await tx.allocation.findMany({ orderBy: { id: 'asc' } }),
          refunds: await tx.refund.findMany({ orderBy: { id: 'asc' } }),
          retries: await tx.idempotencyRecord.findMany({ orderBy: { id: 'asc' } }),
        })),
      ),
    );
  }
});

function createdEntity(response: request.Response, field: string): Record<string, unknown> {
  expect(response.status, text(response)).toBe(200);
  return record(record(response.body)[field]);
}

async function createDevUser(email: string): Promise<void> {
  await started()
    .get(PrismaService)
    .client.userAccount.create({
      data: {
        email,
        displayName: `Payments ${runId}`,
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
  return `pay-${name}-${runId}`.slice(0, 64);
}

function inCompany<T>(companyId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return new TenantDb(started().get(PrismaService).client).run(
    { companyId, actor: 'payments-test', correlationId: randomUUID() },
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
