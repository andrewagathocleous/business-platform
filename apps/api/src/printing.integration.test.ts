import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { MockPrintProvider, shopifyFixturesDirectory } from '@bp/integrations';
import { Logger } from 'nestjs-pino';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  assertDatabaseNameIsTest,
  assertEnvConnectionsTargetTestDatabase,
  assertTestDatabaseUrls,
} from '../../../tools/test-db-guard.mjs';
import { AppModule } from './app.module';
import { AuditService } from './audit/audit.service';
import { InboxProcessor } from './automation/inbox.processor';
import { JobRunner } from './automation/jobs/job-runner';
import { PrismaService } from './database/prisma.service';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { LOG_STREAM } from './logging/logging.module';
import { PrintProcessor } from './printing/print.processor';
import { PRINT_PROVIDER } from './printing/print.tokens';

const COMPANY_A = 'Demo Company A Ltd (fictional)';
const COMPANY_B = 'Demo Company B Ltd (fictional)';
const GREEK_GIFT = 'Χρόνια πολλά, Μαρία!\n\nΜε αγάπη, \nΓιώργος & Ελένη — «καλή χρονιά»';
const runId = randomUUID().slice(0, 8);

type Agent = ReturnType<typeof request.agent>;
type Session = { agent: Agent; xsrf: string };
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type PrintView = Record<string, unknown>;

let app: INestApplication | undefined;
let storageRoot = '';
let mockRoot = '';
let sequence = 0;

describe('printing with the mock provider', () => {
  let companyA = '';
  let companyB = '';
  let adminUserId = '';
  let fulfilUserId = '';
  let fulfilMembershipId = '';
  let shopifyStoreA = '';
  let shopifyConnectionA = '';
  let shopifyStoreB = '';
  let shopifyConnectionB = '';
  let onlineA = '';
  let offlineA = '';
  let flakyA = '';
  let onlineB = '';
  let locationB = '';
  let adminA: Session;
  let adminB: Session;
  let fulfil: Session;
  let fulfilB: Session;
  let provider: MockPrintProvider;

  beforeAll(async () => {
    const refusal = assertTestDatabaseUrls();
    if (refusal) {
      throw new Error(refusal);
    }
    await assertEnvConnectionsTargetTestDatabase();
    seedDatabase();
    storageRoot = mkdtempSync(join(tmpdir(), 'bp-c2b2-store-'));
    mockRoot = mkdtempSync(join(tmpdir(), 'bp-c2b2-print-'));
    process.env.STORAGE_ROOT = storageRoot;
    process.env.MOCK_PRINT_ROOT = mockRoot;
    process.env.APP_ENV = 'test';
    process.env.AUTH_DEV_LOGIN_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECURE = 'false';
    process.env.CSRF_SECRET = 'integration-test-csrf-secret';
    process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED = 'false';
    delete process.env.THROTTLE_ENABLED_IN_TEST;
    app = await bootApp();
    const prisma = app.get(PrismaService);
    const databases = await prisma.client.$queryRaw<{ current_database: string; current_user: string }[]>`
      SELECT current_database() AS current_database, current_user AS current_user
    `;
    assertDatabaseNameIsTest(databases[0]?.current_database, 'DATABASE_URL');
    expect(databases[0]?.current_user).toBe('bp_app');
    companyA = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_A } })).id;
    companyB = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_B } })).id;
    adminUserId = (
      await prisma.client.userAccount.findFirstOrThrow({ where: { email: 'admin.a@example.test' } })
    ).id;
    const fulfilUser = await prisma.client.userAccount.findFirstOrThrow({
      where: { email: 'fulfil.a@example.test' },
    });
    fulfilUserId = fulfilUser.id;
    fulfilMembershipId = await withCompany(companyA, async (tx) => {
      const membership = await tx.membership.findFirstOrThrow({
        where: { userId: fulfilUserId, companyId: companyA },
      });
      return membership.id;
    });
    const shopifyA = await withCompany(companyA, (tx) =>
      tx.store.findFirstOrThrow({ where: { companyId: companyA, name: 'Nutbox Demo Shopify' } }),
    );
    shopifyStoreA = shopifyA.id;
    shopifyConnectionA = (
      await withCompany(companyA, (tx) =>
        tx.storeConnection.findFirstOrThrow({
          where: { companyId: companyA, storeId: shopifyStoreA, status: 'active', mode: 'mock' },
        }),
      )
    ).id;
    const shopifyB = await withCompany(companyB, (tx) =>
      tx.store.findFirstOrThrow({ where: { companyId: companyB, name: 'Olive Grove Demo Shopify' } }),
    );
    shopifyStoreB = shopifyB.id;
    shopifyConnectionB = (
      await withCompany(companyB, (tx) =>
        tx.storeConnection.findFirstOrThrow({
          where: { companyId: companyB, storeId: shopifyStoreB, status: 'active', mode: 'mock' },
        }),
      )
    ).id;
    adminA = await login(app, 'admin.a@example.test');
    adminB = await login(app, 'admin.b@example.test');
    fulfil = await login(app, 'fulfil.a@example.test');
    fulfilB = await login(app, 'fulfil.b@example.test');
    provider = app.get<MockPrintProvider>(PRINT_PROVIDER);
    const printersA = await printerList(adminA, companyA);
    onlineA = printerId(printersA, 'mock-laserjet-online');
    offlineA = printerId(printersA, 'mock-offline');
    flakyA = printerId(printersA, 'mock-flaky');
    const printersB = await printerList(adminB, companyB);
    onlineB = printerId(printersB, 'mock-laserjet-online');
    locationB = stringField(printersB.find((row) => stringField(row, 'id') === onlineB) ?? {}, 'locationId');
    await started().get(PrismaService).client.job.deleteMany({ where: { status: 'queued', type: 'inbox.process' } });
  });

  afterEach(() => {
    provider.beforeSubmit = null;
    if (app) {
      app.get(PrintProcessor).hooks = null;
    }
  });

  afterAll(async () => {
    await restorePrinting();
    await restoreFulfil();
    if (app) {
      await app.close();
    }
    if (storageRoot) {
      rmSync(storageRoot, { recursive: true, force: true });
    }
    if (mockRoot) {
      rmSync(mockRoot, { recursive: true, force: true });
    }
    if (app) {
      await app.get(PrismaService).client.job.updateMany({
        where: { type: { in: ['print.submit', 'print.refresh_status'] }, status: 'queued' },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
    }
  });

  it('prints a gift message once, reports done without calling it printed, and blocks a second first print', async () => {
    const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, GREEK_GIFT);
    const before = provider.submitCount;
    const correlationId = cid('first');
    const created = await requestPrint(fulfil, companyA, order.id, 'gift_message', correlationId);
    expect(created.status).toBe('queued');
    expect(created.provider).toBe('mock');
    expect(created.simulationLabel).toBe('Simulated — no physical printing');
    expect(created.label).toBe('Queued');
    expect(created.sourceVersion).toBe(1);
    const duplicate = await send(fulfil, 'post', `/api/c/${companyA}/print-requests`, cid('dup'), {
      documentType: 'gift_message',
      sourceType: 'order',
      sourceId: order.id,
    });
    expect(duplicate.status, text(duplicate)).toBe(409);
    expect(record(duplicate.body).error).toMatchObject({
      code: 'already_printed',
      printJobId: created.id,
    });
    const dupAudit = await auditEvents(app, cid('dup'), companyA);
    expect(dupAudit.some((event) => event.action === 'print_job.requested' && event.outcome === 'failure')).toBe(true);
    const finished = await finishPrint(fulfil, companyA, stringField(created, 'id'));
    expect(provider.submitCount).toBe(before + 1);
    expect(finished.status).toBe('done_reported');
    expect(finished.label).toBe('Sent to printer (provider reported done — not confirmed)');
    expect(String(finished.label)).not.toMatch(/^printed$/i);
    expect(finished.provider).toBe('mock');
    expect(finished.simulationLabel).toBe('Simulated — no physical printing');
    const pdf = await readFile(join(mockRoot, companyA.toLowerCase(), `${String(created.id).toLowerCase()}.pdf`));
    expect(pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    const detail = await send(fulfil, 'get', `/api/c/${companyA}/orders/${order.id}`);
    expect(detail.status, text(detail)).toBe(200);
    const slot = record(record(record(detail.body).order).printJobs).gift_message;
    expect(record(slot).status).toBe('done_reported');
    expect(record(slot).label).toBe(finished.label);
    expect(record(slot).provider).toBe('mock');
    const requested = await auditEvents(app, correlationId, companyA);
    expect(requested.map((event) => event.action)).toEqual(
      expect.arrayContaining(['print_job.requested', 'print_job.submitting', 'print_job.submitted', 'print_job.done_reported']),
    );
    const activity = await send(fulfil, 'get', `/api/c/${companyA}/orders/${order.id}/activity`);
    expect(activity.status, text(activity)).toBe(200);
    const actions = arrayOf(record(activity.body).events).map((event) => stringField(record(event), 'action'));
    expect(actions).toEqual(expect.arrayContaining(['print_job.requested', 'print_job.done_reported']));
    const confirmId = cid('first-confirm');
    const confirmed = await send(
      adminA,
      'post',
      `/api/c/${companyA}/print-jobs/${String(created.id)}/confirm`,
      confirmId,
      { outcome: 'printed' },
    );
    expect(confirmed.status, text(confirmed)).toBe(200);
    expect(record(record(confirmed.body).printJob).status).toBe('confirmed_printed');
    expectOutcome(await auditEvents(app, confirmId, companyA), confirmId, 'print_job.confirmed', 'success');
  });

  it('lets ten concurrent first prints create exactly one job', async () => {
    const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, GREEK_GIFT);
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_item, index) =>
        send(fulfil, 'post', `/api/c/${companyA}/print-requests`, cid(`race-${String(index)}`), {
          documentType: 'gift_message',
          sourceType: 'order',
          sourceId: order.id,
        }),
      ),
    );
    const created = responses.filter((response) => response.status === 200);
    const conflicts = responses.filter((response) => response.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(9);
    for (const conflict of conflicts) {
      expect(record(record(conflict.body).error).code).toBe('already_printed');
      expect(record(record(conflict.body).error).printJobId).toBe(record(record(created[0]?.body).printJob).id);
    }
    const listed = await send(fulfil, 'get', `/api/c/${companyA}/print-jobs?sourceId=${order.id}&pageSize=100`);
    expect(listed.status, text(listed)).toBe(200);
    expect(arrayOf(record(listed.body).printJobs)).toHaveLength(1);
  });

  it('refuses a reprint without print.reprint and accepts one with a reason', async () => {
    const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, GREEK_GIFT);
    const first = await requestPrint(fulfil, companyA, order.id, 'gift_message', cid('reprint-base'));
    const submitOnly = await installStaff(`submit-only-${runId}@example.test`, ['print.submit']);
    const denied = await send(submitOnly, 'post', `/api/c/${companyA}/print-requests`, cid('reprint-denied'), {
      documentType: 'gift_message',
      sourceType: 'order',
      sourceId: order.id,
      reprint: { ofPrintJobId: first.id, reason: 'card was smudged' },
    });
    await expectDenied(denied, 403, cid('reprint-denied'), companyA, 'permission_missing');
    const reprinted = await send(fulfil, 'post', `/api/c/${companyA}/print-requests`, cid('reprint-ok'), {
      documentType: 'gift_message',
      sourceType: 'order',
      sourceId: order.id,
      reprint: { ofPrintJobId: first.id, reason: 'card was smudged' },
    });
    expect(reprinted.status, text(reprinted)).toBe(200);
    const job = record(record(reprinted.body).printJob);
    expect(job.isReprint).toBe(true);
    expect(job.reprintOfId).toBe(first.id);
    expect(job.id).not.toBe(first.id);
    const reprintId = cid('reprint-ok');
    expectOutcome(await auditEvents(app, reprintId, companyA), reprintId, 'print_job.requested', 'success');
    const shortReason = await send(fulfil, 'post', `/api/c/${companyA}/print-requests`, cid('reprint-short'), {
      documentType: 'gift_message',
      sourceType: 'order',
      sourceId: order.id,
      reprint: { ofPrintJobId: first.id, reason: 'no' },
    });
    expect(shortReason.status, text(shortReason)).toBe(400);
  });

  it('fails an offline printer and leaves a timeout uncertain without a second submit', async () => {
    const offlineOrder = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, null);
    const offline = await requestPrint(fulfil, companyA, offlineOrder.id, 'packing_slip', cid('offline'), {
      printerId: offlineA,
    });
    const offlineDone = await finishPrint(fulfil, companyA, stringField(offline, 'id'));
    expect(offlineDone.status).toBe('failed');
    expect(offlineDone.lastError).toBe('printer_offline');
    expect(provider.submittedIds.filter((id) => id === offline.id)).toHaveLength(1);
    expectOutcome(await auditEvents(app, cid('offline'), companyA), cid('offline'), 'print_job.failed', 'failure');
    const flakyOrder = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, null);
    const flaky = await requestPrint(fulfil, companyA, flakyOrder.id, 'packing_slip', cid('flaky'), {
      printerId: flakyA,
    });
    const flakyDone = await finishPrint(fulfil, companyA, stringField(flaky, 'id'));
    expect(flakyDone.status).toBe('uncertain');
    expect(flakyDone.label).toBe('Uncertain — check the printer before reprinting');
    expect(provider.submittedIds.filter((id) => id === flaky.id)).toHaveLength(1);
    expectOutcome(await auditEvents(app, cid('flaky'), companyA), cid('flaky'), 'print_job.uncertain', 'failure');
    const again = await send(fulfil, 'post', `/api/c/${companyA}/print-requests`, cid('flaky-again'), {
      documentType: 'packing_slip',
      sourceType: 'order',
      sourceId: flakyOrder.id,
    });
    expect(again.status, text(again)).toBe(409);
    expect(provider.submittedIds.filter((id) => id === flaky.id)).toHaveLength(1);
    const submits = await started().get(PrismaService).client.job.count({
      where: { idempotencyKey: `print.submit:${String(flaky.id)}`, status: 'queued' },
    });
    expect(submits).toBe(0);
  });

  it('holds a job when printing is switched off after queueing, then prints on release', async () => {
    const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, GREEK_GIFT);
    const before = provider.submitCount;
    const queued = await requestPrint(fulfil, companyA, order.id, 'gift_message', cid('hold'));
    await setPrinting(false);
    try {
      await jobs().drainOnce();
      const held = await loadPrint(fulfil, companyA, stringField(queued, 'id'));
      expect(held.status).toBe('held');
      expect(provider.submitCount).toBe(before);
      expectOutcome(await auditEvents(app, cid('hold'), companyA), cid('hold'), 'print_job.held', 'success');
      await setPrinting(true);
      const released = await send(adminA, 'post', `/api/c/${companyA}/print-jobs/${String(queued.id)}/release`, cid('release'));
      expect(released.status, text(released)).toBe(200);
      expect(record(record(released.body).printJob).status).toBe('queued');
      const finished = await finishPrint(fulfil, companyA, stringField(queued, 'id'));
      expect(finished.status).toBe('done_reported');
      expect(provider.submitCount).toBe(before + 1);
      expectOutcome(await auditEvents(app, cid('release'), companyA), cid('release'), 'print_job.released', 'success');
    } finally {
      await setPrinting(true);
    }
  });

  it('holds company B jobs because printing is off', async () => {
    const mapped = await send(adminB, 'put', `/api/c/${companyB}/printer-mappings`, cid('map-b'), {
      locationId: locationB,
      documentType: 'packing_slip',
      printerId: onlineB,
      paperSize: 'A4',
      copies: 1,
    });
    expect(mapped.status, text(mapped)).toBe(200);
    const order = await makeOrder(companyB, shopifyStoreB, shopifyConnectionB, null);
    const before = provider.submitCount;
    const queued = await requestPrint(fulfilB, companyB, order.id, 'packing_slip', cid('hold-b'));
    await jobs().drainOnce();
    const held = await loadPrint(fulfilB, companyB, stringField(queued, 'id'));
    expect(held.status).toBe('held');
    expect(provider.submitCount).toBe(before);
  });

  it('keeps the first print after an import that only changes the phone', async () => {
    const token = await createToken(adminA, companyA, 'phone');
    const externalId = `print-${runId}-phone`;
    const name = `#P${runId}`;
    const created = cloneOrder(loadFixture('order-1001-paid-greek-gift.json'));
    created.id = externalId;
    created.name = name;
    created.updatedAt = '2026-03-01T10:15:00.000Z';
    const posted = await postEvent(token.token, companyA, shopifyConnectionA, `print-create-${runId}`, 'orders/create', created);
    expect(posted.status, text(posted.response)).toBe(202);
    await jobs().drainOnce();
    const order = await orderByNumber(adminA, companyA, name);
    const orderId = stringField(order, 'id');
    const first = await requestPrint(fulfil, companyA, orderId, 'gift_message', cid('version'));
    const later = cloneOrder(created);
    later.updatedAt = '2026-03-02T09:00:00.000Z';
    setPhone(later, '+35799001999');
    const updated = await postEvent(
      token.token,
      companyA,
      shopifyConnectionA,
      `print-update-${runId}`,
      'orders/updated',
      later,
    );
    expect(updated.status, text(updated.response)).toBe(202);
    await jobs().drainOnce();
    const after = await orderByNumber(adminA, companyA, name);
    expect(numberField(after, 'version')).toBeGreaterThan(numberField(order, 'version'));
    const second = await send(fulfil, 'post', `/api/c/${companyA}/print-requests`, cid('version-again'), {
      documentType: 'gift_message',
      sourceType: 'order',
      sourceId: orderId,
    });
    expect(second.status, text(second)).toBe(409);
    expect(record(record(second.body).error).printJobId).toBe(first.id);
    const noted = await send(fulfil, 'post', `/api/c/${companyA}/orders/${orderId}/notes`, cid('note'), {
      body: `packed ${runId}`,
    });
    expect(noted.status, text(noted)).toBe(200);
    const version = numberField(record(record(noted.body).order), 'version');
    const moved = await send(fulfil, 'post', `/api/c/${companyA}/orders/${orderId}/transitions`, cid('move'), {
      to: 'preparing',
      expectedVersion: version,
    });
    expect(moved.status, text(moved)).toBe(200);
    const activity = await send(fulfil, 'get', `/api/c/${companyA}/orders/${orderId}/activity`);
    const actions = arrayOf(record(activity.body).events).map((event) => stringField(record(event), 'action'));
    expect(actions).toEqual(
      expect.arrayContaining(['order.imported', 'order.source_updated', 'order.note_added', 'order.transition', 'print_job.requested']),
    );
  }, 60_000);

  it('does not call the provider when the requester was suspended', async () => {
    const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, GREEK_GIFT);
    const before = provider.submitCount;
    const queued = await requestPrint(fulfil, companyA, order.id, 'gift_message', cid('revoked'));
    const suspended = await send(adminA, 'patch', `/api/c/${companyA}/members/${fulfilMembershipId}`, cid('suspend'), {
      status: 'suspended',
    });
    expect(suspended.status, text(suspended)).toBe(200);
    try {
      await jobs().drainOnce();
      const failed = await loadPrint(adminA, companyA, stringField(queued, 'id'));
      expect(failed.status).toBe('failed');
      expect(failed.lastError).toBe('requester_no_longer_authorised');
      expect(provider.submitCount).toBe(before);
      const audited = await auditEvents(app, cid('revoked'), companyA);
      expect(
        audited.some(
          (event) =>
            event.action === 'print_job.failed' &&
            event.outcome === 'failure' &&
            detailField(event.details, 'reason') === 'requester_no_longer_authorised',
        ),
      ).toBe(true);
      const confirmed = await send(
        adminA,
        'post',
        `/api/c/${companyA}/print-jobs/${stringField(queued, 'id')}/confirm`,
        cid('revoked-confirm'),
        { outcome: 'printed' },
      );
      expect(confirmed.status, text(confirmed)).toBe(422);
      expect(record(record(confirmed.body).error).code).toBe('confirm_not_allowed');
      expect((await loadPrint(adminA, companyA, stringField(queued, 'id'))).status).toBe('failed');
      const confirmAudit = await auditEvents(app, cid('revoked-confirm'), companyA);
      expect(
        confirmAudit.some(
          (event) =>
            event.action === 'print_job.confirmed' &&
            event.outcome === 'failure' &&
            event.correlationId === cid('revoked-confirm') &&
            detailField(event.details, 'reason') === 'confirm_not_allowed',
        ),
      ).toBe(true);
    } finally {
      await restoreFulfil();
      fulfil = await login(started(), 'fulfil.a@example.test');
    }
  });

  it('never both cancels and submits, including a blocked claim', async () => {
    const earlyOrder = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, GREEK_GIFT);
    const early = await requestPrint(fulfil, companyA, earlyOrder.id, 'gift_message', cid('cancel-early'));
    const before = provider.submitCount;
    const cancelled = await send(fulfil, 'post', `/api/c/${companyA}/print-jobs/${String(early.id)}/cancel`, cid('cancel-early-do'));
    expect(cancelled.status, text(cancelled)).toBe(200);
    expectOutcome(
      await auditEvents(app, cid('cancel-early-do'), companyA),
      cid('cancel-early-do'),
      'print_job.cancelled',
      'success',
    );
    await jobs().drainOnce();
    expect(provider.submitCount).toBe(before);
    expect((await loadPrint(fulfil, companyA, stringField(early, 'id'))).status).toBe('cancelled');

    const blockedOrder = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, GREEK_GIFT);
    const blocked = await requestPrint(fulfil, companyA, blockedOrder.id, 'gift_message', cid('cancel-late'));
    let release = (): void => undefined;
    const entered = deferred();
    provider.beforeSubmit = () => {
      entered.resolve();
      return new Promise((done) => {
        release = done;
      });
    };
    const draining = jobs().drainOnce();
    try {
      await entered.promise;
      const late = await send(fulfil, 'post', `/api/c/${companyA}/print-jobs/${String(blocked.id)}/cancel`, cid('cancel-late-do'));
      expect(late.status, text(late)).toBe(409);
      expectOutcome(
        await auditEvents(app, cid('cancel-late-do'), companyA),
        cid('cancel-late-do'),
        'print_job.cancel',
        'failure',
      );
      expect(provider.submittedIds.filter((id) => id === blocked.id)).toHaveLength(1);
    } finally {
      release();
      provider.beforeSubmit = null;
      await draining;
    }

    for (let index = 0; index < 25; index += 1) {
      const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, GREEK_GIFT);
      const queued = await requestPrint(fulfil, companyA, order.id, 'gift_message', cid(`cancel-race-${String(index)}`));
      const [cancel] = await Promise.all([
        send(fulfil, 'post', `/api/c/${companyA}/print-jobs/${String(queued.id)}/cancel`, cid(`cancel-race-do-${String(index)}`)),
        jobs().drainOnce(),
      ]);
      const called = provider.submittedIds.includes(String(queued.id));
      expect(cancel.status === 200 && called).toBe(false);
      expect([200, 409]).toContain(cancel.status);
    }
  }, 180_000);

  it('submits once when the lease dies during the provider call and does not return the print to queued', async () => {
    const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, GREEK_GIFT);
    const queued = await requestPrint(fulfil, companyA, order.id, 'gift_message', cid('lease'));
    let release = (): void => undefined;
    const entered = deferred();
    provider.beforeSubmit = () => {
      entered.resolve();
      return new Promise((done) => {
        release = done;
      });
    };
    const draining = jobs().drainOnce();
    try {
      await entered.promise;
      await started().get(PrismaService).client.$executeRaw`
        UPDATE job
        SET locked_until = clock_timestamp() - interval '1 second'
        WHERE id = ${String(queued.queueJobId)}::uuid
      `;
      const other = new JobRunner(started().get(PrismaService), started().get(AuditService));
      other.register({
        type: 'print.submit',
        concurrency: 2,
        retryable: false,
        mode: 'external',
        run: () => Promise.resolve(),
      });
      expect(await other.reclaimExpired()).toBeGreaterThan(0);
      const mid = await loadPrint(adminA, companyA, stringField(queued, 'id'));
      expect(mid.status).toBe('uncertain');
      release();
      await draining;
      expect(provider.submittedIds.filter((id) => id === queued.id)).toHaveLength(1);
      const end = await loadPrint(adminA, companyA, stringField(queued, 'id'));
      expect(end.status).toBe('uncertain');
      expect(end.status).not.toBe('queued');
      expect(typeof end.providerJobId).toBe('string');
      const late = await auditEvents(app, cid('lease'), companyA);
      expect(
        late.some(
          (event) =>
            event.action === 'print_job.submitted' &&
            detailField(event.details, 'providerJobId') === end.providerJobId,
        ),
      ).toBe(true);
    } finally {
      release();
      provider.beforeSubmit = null;
      await draining.catch(() => undefined);
    }
  });

  it('does not call the provider when reclaim and cancel win between the claim and submit', async () => {
    const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, GREEK_GIFT);
    const queued = await requestPrint(fulfil, companyA, order.id, 'gift_message', cid('after-claim'));
    const before = provider.submitCount;
    const processor = started().get(PrintProcessor);
    const claimed = deferred();
    let release = (): void => undefined;
    processor.hooks = {
      afterClaim: () => {
        claimed.resolve();
        return new Promise((done) => {
          release = done;
        });
      },
    };
    const draining = jobs().drainOnce();
    try {
      await claimed.promise;
      await started().get(PrismaService).client.$executeRaw`
        UPDATE job
        SET locked_until = clock_timestamp() - interval '1 second'
        WHERE id = ${String(queued.queueJobId)}::uuid
      `;
      expect(await jobs().reclaimExpired()).toBeGreaterThan(0);
      expect((await loadPrint(adminA, companyA, stringField(queued, 'id'))).status).toBe('uncertain');
      const cancelled = await send(
        fulfil,
        'post',
        `/api/c/${companyA}/print-jobs/${stringField(queued, 'id')}/cancel`,
        cid('after-claim-cancel'),
      );
      expect(cancelled.status, text(cancelled)).toBe(200);
      release();
      await draining;
      expect(provider.submitCount).toBe(before);
      expect(provider.submittedIds.filter((id) => id === queued.id)).toHaveLength(0);
      expect((await loadPrint(fulfil, companyA, stringField(queued, 'id'))).status).toBe('cancelled');
    } finally {
      release();
      processor.hooks = null;
      await draining.catch(() => undefined);
    }
  });

  it('hides another store print job at the same location from a store grant', async () => {
    const placed = await withCompany(companyA, async (tx) => {
      const shopify = await tx.store.findFirstOrThrow({ where: { id: shopifyStoreA, companyId: companyA } });
      const presta = await tx.store.findFirstOrThrow({
        where: { companyId: companyA, name: 'Nutbox Demo PrestaShop' },
      });
      const connection = await tx.storeConnection.findFirstOrThrow({
        where: { companyId: companyA, storeId: presta.id, status: 'active', mode: 'mock' },
      });
      return { shopifyLocationId: shopify.locationId, prestaId: presta.id, prestaLocationId: presta.locationId, connectionId: connection.id };
    });
    expect(placed.prestaLocationId).toBe(placed.shopifyLocationId);
    const prestaOrder = await makeOrder(companyA, placed.prestaId, placed.connectionId, GREEK_GIFT);
    const hidden = await requestPrint(adminA, companyA, prestaOrder.id, 'gift_message', cid('scope-presta'));
    const viewer = await installStaff(`shopify-only-${runId}@example.test`, ['print.submit']);
    const listed = await send(viewer, 'get', `/api/c/${companyA}/print-jobs?pageSize=100`);
    expect(listed.status, text(listed)).toBe(200);
    expect(arrayOf(record(listed.body).printJobs).map((job) => stringField(record(job), 'id'))).not.toContain(hidden.id);
    const bySource = await send(viewer, 'get', `/api/c/${companyA}/print-jobs?sourceId=${prestaOrder.id}&pageSize=100`);
    expect(bySource.status, text(bySource)).toBe(200);
    expect(arrayOf(record(bySource.body).printJobs)).toHaveLength(0);
    const ownOrder = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, GREEK_GIFT);
    const own = await requestPrint(adminA, companyA, ownOrder.id, 'gift_message', cid('scope-shopify'));
    const ownList = await send(viewer, 'get', `/api/c/${companyA}/print-jobs?sourceId=${ownOrder.id}&pageSize=100`);
    expect(ownList.status, text(ownList)).toBe(200);
    expect(arrayOf(record(ownList.body).printJobs).map((job) => stringField(record(job), 'id'))).toContain(own.id);
    await send(adminA, 'post', `/api/c/${companyA}/print-jobs/${stringField(hidden, 'id')}/cancel`, cid('scope-presta-cancel'));
    await send(adminA, 'post', `/api/c/${companyA}/print-jobs/${stringField(own, 'id')}/cancel`, cid('scope-shopify-cancel'));
  });

  it('settles a hanging submit as uncertain within the timeout and records the late result', async () => {
    const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, GREEK_GIFT);
    const queued = await requestPrint(fulfil, companyA, order.id, 'gift_message', cid('hang'));
    const timeoutMs = 1_500;
    await started().get(PrismaService).client.$executeRaw`
      UPDATE job SET timeout_ms = ${timeoutMs} WHERE id = ${String(queued.queueJobId)}::uuid
    `;
    const before = provider.submittedIds.filter((id) => id === queued.id).length;
    const entered = deferred();
    let release = (): void => undefined;
    provider.beforeSubmit = () => {
      entered.resolve();
      return new Promise((done) => {
        release = done;
      });
    };
    const startedAt = Date.now();
    const draining = jobs().drainOnce();
    try {
      await entered.promise;
      await draining;
      expect(Date.now() - startedAt).toBeLessThan(timeoutMs + 2_500);
      const mid = await loadPrint(adminA, companyA, stringField(queued, 'id'));
      expect(mid.status).toBe('uncertain');
      expect(provider.submittedIds.filter((id) => id === queued.id).length - before).toBeLessThanOrEqual(1);
      expect(provider.submittedIds.filter((id) => id === queued.id).length - before).toBe(1);
      release();
      const end = await waitForPrint(
        adminA,
        companyA,
        stringField(queued, 'id'),
        (job) => typeof job.providerJobId === 'string',
      );
      expect(end.status).toBe('uncertain');
      expect(typeof end.providerJobId).toBe('string');
      expect(provider.submittedIds.filter((id) => id === queued.id)).toHaveLength(before + 1);
      const late = await auditEvents(app, cid('hang'), companyA);
      expect(
        late.some(
          (event) =>
            event.action === 'print_job.submitted' &&
            detailField(event.details, 'providerJobId') === end.providerJobId,
        ),
      ).toBe(true);
    } finally {
      release();
      provider.beforeSubmit = null;
      await draining.catch(() => undefined);
    }
  }, 20_000);

  it('does not deadlock when cancel runs with late result recording', async () => {
    const processor = started().get(PrintProcessor);
    for (let index = 0; index < 25; index += 1) {
      const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, GREEK_GIFT);
      const queued = await requestPrint(fulfil, companyA, order.id, 'gift_message', cid(`deadlock-${String(index)}`));
      const entered = deferred();
      const recording = deferred();
      let releaseSubmit = (): void => undefined;
      let releaseRecord = (): void => undefined;
      provider.beforeSubmit = () => {
        entered.resolve();
        return new Promise((done) => {
          releaseSubmit = done;
        });
      };
      processor.hooks = {
        duringRecord: () => {
          recording.resolve();
          return new Promise((done) => {
            releaseRecord = done;
          });
        },
      };
      const draining = jobs().drainOnce();
      try {
        await entered.promise;
        await started().get(PrismaService).client.$executeRaw`
          UPDATE job
          SET locked_until = clock_timestamp() - interval '1 second'
          WHERE id = ${String(queued.queueJobId)}::uuid
        `;
        expect(await jobs().reclaimExpired()).toBeGreaterThan(0);
        releaseSubmit();
        await recording.promise;
        const cancelling = send(
          fulfil,
          'post',
          `/api/c/${companyA}/print-jobs/${stringField(queued, 'id')}/cancel`,
          cid(`deadlock-cancel-${String(index)}`),
        );
        const overlapped = await Promise.race([
          cancelling.then(() => 'finished' as const),
          delay(400).then(() => 'blocked' as const),
        ]);
        expect(overlapped).toBe('blocked');
        releaseRecord();
        const cancelled = await cancelling;
        expect(cancelled.status, text(cancelled)).toBe(200);
        await draining;
        expect((await loadPrint(adminA, companyA, stringField(queued, 'id'))).status).toBe('cancelled');
        expect(provider.submittedIds.filter((id) => id === queued.id)).toHaveLength(1);
      } finally {
        releaseSubmit();
        releaseRecord();
        provider.beforeSubmit = null;
        processor.hooks = null;
        await draining.catch(() => undefined);
      }
    }
  }, 180_000);

  it('records the provider result when the first recording transaction fails', async () => {
    const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, GREEK_GIFT);
    const before = provider.submitCount;
    let failed = false;
    started().get(PrintProcessor).hooks = {
      beforeRecord: () => {
        if (!failed) {
          failed = true;
          throw new Error('recording_failed');
        }
        return Promise.resolve();
      },
    };
    const queued = await requestPrint(fulfil, companyA, order.id, 'gift_message', cid('retry-record'));
    try {
      const finished = await finishPrint(fulfil, companyA, stringField(queued, 'id'));
      expect(provider.submitCount).toBe(before + 1);
      expect(finished.status).toBe('done_reported');
      expect(typeof finished.providerJobId).toBe('string');
      expect(failed).toBe(true);
    } finally {
      started().get(PrintProcessor).hooks = null;
    }
  });

  it('does not deadlock when an expired refresh lease is reclaimed during late refresh recording', async () => {
    const runner = jobs();
    const processor = started().get(PrintProcessor);
    const client = started().get(PrismaService).client;
    for (let index = 0; index < 25; index += 1) {
      runner.drainDeadlineMs = 5_000;
      await runner.drainOnce();
      runner.drainDeadlineMs = 1_500;
      const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, GREEK_GIFT);
      const queued = await requestPrint(fulfil, companyA, order.id, 'gift_message', cid(`refresh-lock-${String(index)}`));
      await runner.drainOnce();
      runner.drainDeadlineMs = 5_000;
      const printId = stringField(queued, 'id');
      const refresh = await client.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status::text AS status
        FROM job
        WHERE type = 'print.refresh_status'
          AND payload->>'printJobId' = ${printId}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      expect(refresh[0]?.status, `iteration ${String(index)}`).toBe('queued');
      const refreshId = refresh[0]?.id;
      if (!refreshId) {
        throw new Error('refresh job missing');
      }
      const recording = deferred();
      let releaseRecord = (): void => undefined;
      processor.hooks = {
        duringRecord: () => {
          recording.resolve();
          return new Promise((done) => {
            releaseRecord = done;
          });
        },
      };
      await client.$executeRaw`
        UPDATE job
        SET run_after = clock_timestamp()
        WHERE id = ${refreshId}::uuid
      `;
      const draining = runner.drainOnce();
      let reclaiming: Promise<number> | undefined;
      try {
        await recording.promise;
        await client.$executeRaw`
          UPDATE job
          SET status = 'running'::"job_status",
              locked_by = 'stale-refresh-reclaim',
              locked_until = clock_timestamp() - interval '1 second',
              finished_at = NULL
          WHERE id = ${String(queued.queueJobId)}::uuid
        `;
        await client.$executeRaw`
          UPDATE job
          SET locked_until = clock_timestamp() - interval '1 second'
          WHERE id = ${refreshId}::uuid
            AND status = 'running'::"job_status"
        `;
        reclaiming = runner.reclaimExpired();
        expect(await waitForUngrantedLock()).toBe(true);
        processor.hooks = null;
        releaseRecord();
        await reclaiming;
        await draining;
        const status = (await loadPrint(adminA, companyA, printId)).status;
        expect(['submitted', 'delivered_to_printer', 'done_reported']).toContain(status);
      } finally {
        releaseRecord();
        processor.hooks = null;
        runner.drainDeadlineMs = 5_000;
        await Promise.allSettled([draining, reclaiming ?? Promise.resolve()]);
      }
    }
  }, 240_000);

  it('flags a gift-message change while the print is still submitting', async () => {
    const token = await createToken(adminA, companyA, 'submitting-gift');
    const externalId = `print-${runId}-submitting`;
    const name = `#S${runId}`;
    const created = cloneOrder(loadFixture('order-1001-paid-greek-gift.json'));
    created.id = externalId;
    created.name = name;
    created.updatedAt = '2026-03-01T10:15:00.000Z';
    const posted = await postEvent(
      token.token,
      companyA,
      shopifyConnectionA,
      `print-submitting-create-${runId}`,
      'orders/create',
      created,
    );
    expect(posted.status, text(posted.response)).toBe(202);
    await jobs().drainOnce();
    const order = await orderByNumber(adminA, companyA, name);
    const orderId = stringField(order, 'id');
    const queued = await requestPrint(fulfil, companyA, orderId, 'gift_message', cid('submitting-gift'));
    const processor = started().get(PrintProcessor);
    const held = deferred();
    let release = (): void => undefined;
    processor.hooks = {
      beforeRecord: () => {
        held.resolve();
        return new Promise((done) => {
          release = done;
        });
      },
    };
    const draining = jobs().drainOnce();
    try {
      await held.promise;
      const mid = await withCompany(companyA, (tx) =>
        tx.printJob.findFirstOrThrow({ where: { id: stringField(queued, 'id'), companyId: companyA } }),
      );
      expect(mid.status).toBe('submitting');
      const later = cloneOrder(created);
      later.updatedAt = '2026-03-02T09:00:00.000Z';
      setGift(later, 'Printed, then changed while submitting.');
      const updated = await postEvent(
        token.token,
        companyA,
        shopifyConnectionA,
        `print-submitting-update-${runId}`,
        'orders/updated',
        later,
      );
      expect(updated.status, text(updated.response)).toBe(202);
      const inbox = started().get(InboxProcessor);
      const other = new JobRunner(started().get(PrismaService), started().get(AuditService));
      other.register({
        type: 'inbox.process',
        concurrency: 4,
        retryable: true,
        run: (job, tx, signal) => inbox.run(job, tx, signal),
      });
      await other.drainOnce();
      const flagged = await orderByNumber(adminA, companyA, name);
      expect(flagged.fulfilmentStatus).toBe('review_required');
      expect(flagged.reviewReason).toBe('gift_message_changed_after_print');
    } finally {
      release();
      processor.hooks = null;
      await draining.catch(() => undefined);
    }
  }, 60_000);

  it('lists print jobs for a store-scoped submitter who also holds company-wide print.confirm', async () => {
    const placed = await withCompany(companyA, async (tx) => {
      const presta = await tx.store.findFirstOrThrow({
        where: { companyId: companyA, name: 'Nutbox Demo PrestaShop' },
      });
      const connection = await tx.storeConnection.findFirstOrThrow({
        where: { companyId: companyA, storeId: presta.id, status: 'active', mode: 'mock' },
      });
      return { prestaId: presta.id, connectionId: connection.id };
    });
    const hiddenOrder = await makeOrder(companyA, placed.prestaId, placed.connectionId, GREEK_GIFT);
    const ownOrder = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, GREEK_GIFT);
    const hidden = await requestPrint(adminA, companyA, hiddenOrder.id, 'gift_message', cid('confirm-scope-presta'));
    const own = await requestPrint(adminA, companyA, ownOrder.id, 'gift_message', cid('confirm-scope-shopify'));
    try {
      const viewer = await installConfirmStaff(`confirm-scope-${runId}@example.test`);
      const listed = await send(viewer, 'get', `/api/c/${companyA}/print-jobs?pageSize=100`, cid('confirm-scope-list'));
      expect(listed.status, text(listed)).toBe(200);
      const hiddenList = await send(
        viewer,
        'get',
        `/api/c/${companyA}/print-jobs?sourceId=${hiddenOrder.id}&pageSize=100`,
      );
      expect(hiddenList.status, text(hiddenList)).toBe(200);
      expect(arrayOf(record(hiddenList.body).printJobs)).toHaveLength(0);
      const ownList = await send(
        viewer,
        'get',
        `/api/c/${companyA}/print-jobs?sourceId=${ownOrder.id}&pageSize=100`,
      );
      expect(ownList.status, text(ownList)).toBe(200);
      expect(arrayOf(record(ownList.body).printJobs).map((job) => stringField(record(job), 'id'))).toContain(own.id);
      expect(arrayOf(record(ownList.body).printJobs).map((job) => stringField(record(job), 'id'))).not.toContain(
        hidden.id,
      );
    } finally {
      await send(adminA, 'post', `/api/c/${companyA}/print-jobs/${stringField(hidden, 'id')}/cancel`, cid('confirm-scope-cancel-presta'));
      await send(adminA, 'post', `/api/c/${companyA}/print-jobs/${stringField(own, 'id')}/cancel`, cid('confirm-scope-cancel-shopify'));
    }
  });

  it('leaves one printer when two discoveries run together', async () => {
    const externalPrinterId = `mock-race-${runId}`;
    const original = provider.listPrinters.bind(provider);
    provider.listPrinters = () =>
      Promise.resolve([
        {
          externalPrinterId,
          name: 'Race printer',
          description: 'concurrent discovery',
          paperSizes: ['A4'],
          status: 'online',
        },
      ]);
    try {
      const [first, second] = await Promise.all([
        send(adminA, 'post', `/api/c/${companyA}/printers/discover`, cid('discover-race-1'), {}),
        send(adminA, 'post', `/api/c/${companyA}/printers/discover`, cid('discover-race-2'), {}),
      ]);
      expect(first.status, text(first)).toBe(200);
      expect(second.status, text(second)).toBe(200);
      const count = await withCompany(companyA, (tx) =>
        tx.printer.count({ where: { companyId: companyA, provider: 'mock', externalPrinterId } }),
      );
      expect(count).toBe(1);
    } finally {
      provider.listPrinters = original;
      await withCompany(companyA, (tx) =>
        tx.printer.deleteMany({ where: { companyId: companyA, externalPrinterId } }),
      );
    }
  });

  it('accepts two identical first printer mappings and leaves one row', async () => {
    const printer = await withCompany(companyA, (tx) =>
      tx.printer.findFirstOrThrow({ where: { id: onlineA, companyId: companyA } }),
    );
    await withCompany(companyA, (tx) =>
      tx.printerMapping.deleteMany({
        where: { companyId: companyA, locationId: printer.locationId, documentType: 'shipping_label' },
      }),
    );
    const body = {
      locationId: printer.locationId,
      documentType: 'shipping_label',
      printerId: onlineA,
      paperSize: 'A4',
      copies: 1,
    };
    const [first, second] = await Promise.all([
      send(adminA, 'put', `/api/c/${companyA}/printer-mappings`, cid('map-race-1'), body),
      send(adminA, 'put', `/api/c/${companyA}/printer-mappings`, cid('map-race-2'), body),
    ]);
    expect(first.status, text(first)).toBe(200);
    expect(second.status, text(second)).toBe(200);
    const count = await withCompany(companyA, (tx) =>
      tx.printerMapping.count({
        where: { companyId: companyA, locationId: printer.locationId, documentType: 'shipping_label' },
      }),
    );
    expect(count).toBe(1);
  });

  it('refuses a gift message that the template cannot print', async () => {
    const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, '🎉');
    const before = provider.submitCount;
    const response = await send(fulfil, 'post', `/api/c/${companyA}/print-requests`, cid('emoji'), {
      documentType: 'gift_message',
      sourceType: 'order',
      sourceId: order.id,
    });
    expect(response.status, text(response)).toBe(422);
    expect(record(record(response.body).error).code).toBe('gift_message_needs_review');
    expect(provider.submitCount).toBe(before);
    const audited = await auditEvents(app, cid('emoji'), companyA);
    const failure = audited.find((event) => event.action === 'print_job.requested' && event.outcome === 'failure');
    expect(failure).toBeTruthy();
    const details = record(failure?.details);
    expect(details.reason).toBe('gift_message_needs_review');
    expect(details.fits).toBe(true);
    expect(details.unsupportedChars).toEqual(['🎉']);
    expect(details.message).toBeUndefined();
  });

  it('isolates print resources, documents, files, templates, switches and jobs', async () => {
    const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA, GREEK_GIFT);
    const queued = await requestPrint(fulfil, companyA, order.id, 'gift_message', cid('iso'));
    const preview = await send(adminB, 'get', `/api/c/${companyA}/orders/${order.id}/documents/packing-slip.pdf`, cid('iso-slip'));
    await expectDenied(preview, 404, cid('iso-slip'), companyA, 'not_a_member');
    const gift = await send(adminB, 'get', `/api/c/${companyA}/orders/${order.id}/documents/gift-message.pdf`, cid('iso-gift'));
    await expectDenied(gift, 404, cid('iso-gift'), companyA, 'not_a_member');
    const templates = await send(adminB, 'get', `/api/c/${companyA}/gift-message-templates`, cid('iso-templates'));
    await expectDenied(templates, 404, cid('iso-templates'), companyA, 'not_a_member');
    const fileId = stringField(queued, 'fileId');
    const file = await send(adminB, 'get', `/api/c/${companyB}/files/${fileId}`, cid('iso-file'));
    await expectDenied(file, 404, cid('iso-file'), companyB, 'out_of_scope');
    const crossRequest = await send(adminB, 'post', `/api/c/${companyA}/print-requests`, cid('iso-request'), {
      documentType: 'gift_message',
      sourceType: 'order',
      sourceId: order.id,
    });
    await expectDenied(crossRequest, 404, cid('iso-request'), companyA, 'not_a_member');
    const crossJob = await send(adminB, 'get', `/api/c/${companyB}/print-jobs/${String(queued.id)}`, cid('iso-job'));
    await expectDenied(crossJob, 404, cid('iso-job'), companyB, 'out_of_scope');
    const listed = await send(adminB, 'get', `/api/c/${companyB}/print-jobs?pageSize=100`);
    expect(listed.status, text(listed)).toBe(200);
    expect(arrayOf(record(listed.body).printJobs).map((job) => stringField(record(job), 'id'))).not.toContain(queued.id);
    const printers = await send(adminB, 'get', `/api/c/${companyB}/printers`);
    expect(printers.status, text(printers)).toBe(200);
    expect(arrayOf(record(printers.body).printers).map((row) => stringField(record(row), 'id'))).not.toContain(onlineA);
    const mapping = await send(adminB, 'put', `/api/c/${companyB}/printer-mappings`, cid('iso-map'), {
      locationId: locationB,
      documentType: 'gift_message',
      printerId: onlineA,
      paperSize: 'A6',
    });
    await expectDenied(mapping, 404, cid('iso-map'), companyB, 'not_found');
    const switches = await send(adminB, 'get', `/api/c/${companyA}/automation/switches`, cid('iso-switches'));
    await expectDenied(switches, 404, cid('iso-switches'), companyA, 'not_a_member');
    const jobsA = await send(adminB, 'get', `/api/c/${companyA}/automation/jobs`, cid('iso-jobs'));
    await expectDenied(jobsA, 404, cid('iso-jobs'), companyA, 'not_a_member');
    const jobsB = await send(adminB, 'get', `/api/c/${companyB}/automation/jobs?pageSize=100`);
    expect(jobsB.status, text(jobsB)).toBe(200);
    expect(arrayOf(record(jobsB.body).jobs).map((job) => stringField(record(job), 'id'))).not.toContain(queued.queueJobId);
    const badStatus = await send(fulfil, 'get', `/api/c/${companyA}/print-jobs?status=nope`);
    expect(badStatus.status, text(badStatus)).toBe(400);
    const badSource = await send(fulfil, 'get', `/api/c/${companyA}/print-jobs?sourceId=not-a-uuid`);
    expect(badSource.status, text(badSource)).toBe(400);
    const badId = await send(fulfil, 'get', `/api/c/${companyA}/print-jobs/not-a-uuid`, cid('bad-id'));
    await expectDenied(badId, 404, cid('bad-id'), companyA, 'out_of_scope');
  });

  async function makeOrder(
    companyId: string,
    storeId: string,
    connectionId: string,
    giftMessage: string | null,
  ): Promise<{ id: string }> {
    sequence += 1;
    const id = await withCompany(companyId, async (tx) => {
      const order = await tx.salesOrder.create({
        data: {
          companyId,
          storeId,
          connectionId,
          externalId: `c2b2-${runId}-${String(sequence)}`,
          externalNumber: `#C2B2-${runId}-${String(sequence)}`,
          sourcePlatform: 'shopify',
          sourceStatus: {},
          paymentStatus: 'paid',
          fulfilmentStatus: 'new',
          integrationStatus: 'synced',
          deliveryMethod: 'courier_cy',
          currency: 'EUR',
          subtotal: '1.00',
          shippingTotal: '0.00',
          taxTotal: '0.00',
          total: '1.00',
          giftMessage,
          recipient: { firstName: 'Μαρία', lastName: 'Παπαδοπούλου', address1: '1 Demo Street', city: 'Λευκωσία', zip: '1000', countryCodeV2: 'CY' },
          version: 1,
          lines: {
            create: [{ sku: 'NUTS', title: 'Mixed nuts', quantity: '1.0000', unitPrice: '1.0000', total: '1.00' }],
          },
        },
        select: { id: true },
      });
      return order.id;
    });
    return { id };
  }

  async function installStaff(email: string, permissions: string[]): Promise<Session> {
    const client = started().get(PrismaService).client;
    const user = await client.userAccount.create({
      data: { email, displayName: email, locale: 'en', status: 'active', isPlatformOwner: false },
    });
    await client.userIdentity.create({
      data: {
        userId: user.id,
        provider: 'dev',
        issuer: 'https://dev-login.invalid',
        subject: email,
        emailAtLink: email,
      },
    });
    const membership = await client.membership.create({
      data: { userId: user.id, companyId: companyA, status: 'active' },
    });
    const role = await client.role.create({
      data: {
        companyId: companyA,
        key: `custom-${randomUUID().slice(0, 8)}`,
        name: email,
        permissions: { create: permissions.map((permission) => ({ permission })) },
      },
    });
    await client.membershipRole.create({
      data: {
        membershipId: membership.id,
        roleId: role.id,
        scopeType: 'store',
        scopeId: shopifyStoreA,
        grantedById: adminUserId,
      },
    });
    return login(started(), email);
  }

  async function installConfirmStaff(email: string): Promise<Session> {
    const client = started().get(PrismaService).client;
    const user = await client.userAccount.create({
      data: { email, displayName: email, locale: 'en', status: 'active', isPlatformOwner: false },
    });
    await client.userIdentity.create({
      data: {
        userId: user.id,
        provider: 'dev',
        issuer: 'https://dev-login.invalid',
        subject: email,
        emailAtLink: email,
      },
    });
    const membership = await client.membership.create({
      data: { userId: user.id, companyId: companyA, status: 'active' },
    });
    const submitRole = await client.role.create({
      data: {
        companyId: companyA,
        key: `submit-${randomUUID().slice(0, 8)}`,
        name: `${email} submit`,
        permissions: { create: [{ permission: 'print.submit' }] },
      },
    });
    const confirmRole = await client.role.create({
      data: {
        companyId: companyA,
        key: `confirm-${randomUUID().slice(0, 8)}`,
        name: `${email} confirm`,
        permissions: { create: [{ permission: 'print.confirm' }] },
      },
    });
    await client.membershipRole.create({
      data: {
        membershipId: membership.id,
        roleId: submitRole.id,
        scopeType: 'store',
        scopeId: shopifyStoreA,
        grantedById: adminUserId,
      },
    });
    await client.membershipRole.create({
      data: {
        membershipId: membership.id,
        roleId: confirmRole.id,
        scopeType: 'company',
        scopeId: null,
        grantedById: adminUserId,
      },
    });
    return login(started(), email);
  }

  async function setPrinting(enabled: boolean): Promise<void> {
    const response = await send(adminA, 'put', `/api/c/${companyA}/automation/switches/printing`, cid(`switch-${String(enabled)}`), {
      enabled,
      reason: `c2b2 printing ${String(enabled)} ${runId}`,
    });
    expect(response.status, text(response)).toBe(200);
  }

  async function restorePrinting(): Promise<void> {
    if (!app) {
      return;
    }
    const response = await send(adminA, 'put', `/api/c/${companyA}/automation/switches/printing`, cid('switch-restore'), {
      enabled: true,
      reason: `c2b2 restore ${runId}`,
    });
    expect(response.status, text(response)).toBe(200);
  }

  async function restoreFulfil(): Promise<void> {
    if (!app || !fulfilMembershipId) {
      return;
    }
    await started().get(PrismaService).client.membership.update({
      where: { id: fulfilMembershipId },
      data: { status: 'active', suspendedAt: null },
    });
  }

  function withCompany<T>(companyId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return new TenantDb(started().get(PrismaService).client).run(
      { companyId, actor: adminUserId || 'printing-test', correlationId: `c2b2-db-${runId}` },
      fn,
    );
  }
});

async function requestPrint(
  session: Session,
  companyId: string,
  orderId: string,
  documentType: 'gift_message' | 'packing_slip',
  correlationId: string,
  extra?: { printerId?: string },
): Promise<PrintView> {
  const response = await send(session, 'post', `/api/c/${companyId}/print-requests`, correlationId, {
    documentType,
    sourceType: 'order',
    sourceId: orderId,
    ...(extra?.printerId ? { printerId: extra.printerId } : {}),
  });
  expect(response.status, text(response)).toBe(200);
  return record(record(response.body).printJob);
}

async function finishPrint(session: Session, companyId: string, printJobId: string): Promise<PrintView> {
  await jobs().drainOnce();
  await started().get(PrismaService).client.$executeRaw`
    UPDATE job
    SET run_after = clock_timestamp()
    WHERE type = 'print.refresh_status'
      AND payload->>'printJobId' = ${printJobId}
  `;
  await jobs().drainOnce();
  return loadPrint(session, companyId, printJobId);
}

async function loadPrint(session: Session, companyId: string, id: string): Promise<PrintView> {
  const response = await send(session, 'get', `/api/c/${companyId}/print-jobs/${id}`);
  expect(response.status, text(response)).toBe(200);
  return record(record(response.body).printJob);
}

async function printerList(session: Session, companyId: string): Promise<PrintView[]> {
  const response = await send(session, 'get', `/api/c/${companyId}/printers`);
  expect(response.status, text(response)).toBe(200);
  return arrayOf(record(response.body).printers).map((row) => record(row));
}

function printerId(rows: PrintView[], externalPrinterId: string): string {
  const found = rows.find((row) => row.externalPrinterId === externalPrinterId);
  if (!found) {
    throw new Error(`printer ${externalPrinterId} was not listed`);
  }
  return stringField(found, 'id');
}

function jobs(): JobRunner {
  return started().get(JobRunner);
}

async function login(application: INestApplication, email: string): Promise<Session> {
  const agent = request.agent(application.getHttpServer() as App);
  const response = await agent.post('/api/auth/dev/login').send({ email });
  expect(response.status, text(response)).toBe(200);
  return { agent, xsrf: cookieValue(cookieHeader(response, 'XSRF-TOKEN'), 'XSRF-TOKEN') };
}

function send(session: Session, method: Method, url: string, correlationId?: string, payload?: unknown) {
  const call = session.agent[method](url).set('X-XSRF-TOKEN', session.xsrf);
  if (correlationId) {
    call.set('X-Correlation-Id', correlationId);
  }
  if (payload !== undefined && payload !== null && typeof payload === 'object') {
    call.send(payload);
  }
  return call;
}

async function createToken(session: Session, companyId: string, label: string): Promise<{ token: string }> {
  const response = await send(session, 'post', `/api/c/${companyId}/service-identities`, cid(`token-${label}`), {
    name: `print-${label}-${runId}`,
    purpose: 'store events',
    permissions: ['store.events.ingest'],
  });
  expect(response.status, text(response)).toBe(200);
  return { token: stringField(record(response.body), 'token') };
}

async function postEvent(
  token: string,
  companyId: string,
  connectionId: string,
  eventId: string,
  topic: 'orders/create' | 'orders/updated',
  payload: Record<string, unknown>,
) {
  const updatedAt = payload.updatedAt;
  if (typeof updatedAt !== 'string') {
    throw new Error('updatedAt missing');
  }
  const response = await request(started().getHttpServer() as App)
    .post(`/api/automation/v1/c/${companyId}/store-connections/${connectionId}/events`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Correlation-Id', cid(eventId))
    .send({ eventId, topic, occurredAt: updatedAt, payload });
  return { status: response.status, response };
}

async function orderByNumber(session: Session, companyId: string, externalNumber: string): Promise<Record<string, unknown>> {
  const listed = await send(session, 'get', `/api/c/${companyId}/orders?q=${encodeURIComponent(externalNumber)}&pageSize=100`);
  expect(listed.status, text(listed)).toBe(200);
  const found = arrayOf(record(listed.body).orders).map((row) => record(row)).find((order) => order.externalNumber === externalNumber);
  if (!found) {
    throw new Error(`order ${externalNumber} was not listed`);
  }
  const detail = await send(session, 'get', `/api/c/${companyId}/orders/${stringField(found, 'id')}`);
  expect(detail.status, text(detail)).toBe(200);
  return record(record(detail.body).order);
}

async function auditEvents(application: INestApplication | undefined, correlationId: string, companyId: string) {
  if (!application) {
    throw new Error('the API was not started');
  }
  const prisma = application.get(PrismaService);
  return prisma.client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform_scope', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.company_id', ${companyId}, true)`;
    return tx.auditEvent.findMany({ where: { correlationId }, orderBy: { occurredAt: 'asc' } });
  });
}

async function expectDenied(
  response: request.Response,
  status: number,
  correlationId: string,
  companyId: string,
  reason: string,
): Promise<void> {
  expect(response.status, text(response)).toBe(status);
  const events = await auditEvents(app, correlationId, companyId);
  expect(events.length).toBeGreaterThan(0);
  expect(events[0]?.action).toBe('authorization.denied');
  expect(events[0]?.outcome).toBe('denied');
  expect(events[0]?.correlationId).toBe(correlationId);
  expect(detailField(events[0]?.details, 'reason')).toBe(reason);
}

function expectOutcome(
  events: { action: string; outcome: string; correlationId: string }[],
  correlationId: string,
  action: string,
  outcome: string,
): void {
  expect(
    events.some(
      (event) =>
        event.action === action && event.outcome === outcome && event.correlationId === correlationId,
    ),
  ).toBe(true);
}

function cid(name: string): string {
  return `c2b2-${name}-${runId}`.slice(0, 64);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForPrint(
  session: Session,
  companyId: string,
  id: string,
  ready: (job: PrintView) => boolean,
): Promise<PrintView> {
  const startedAt = Date.now();
  let latest = await loadPrint(session, companyId, id);
  while (!ready(latest)) {
    if (Date.now() - startedAt > 5_000) {
      return latest;
    }
    await delay(50);
    latest = await loadPrint(session, companyId, id);
  }
  return latest;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function loadFixture(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(shopifyFixturesDirectory(), name), 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${name} is not an object`);
  }
  return parsed;
}

function cloneOrder(payload: Record<string, unknown>): Record<string, unknown> {
  const cloned: unknown = structuredClone(payload);
  if (!isRecord(cloned)) {
    throw new Error('clone failed');
  }
  return cloned;
}

function setPhone(payload: Record<string, unknown>, phone: string): void {
  if (!isRecord(payload.shippingAddress)) {
    throw new Error('shippingAddress missing');
  }
  payload.shippingAddress.phone = phone;
}

function setGift(payload: Record<string, unknown>, gift: string): void {
  if (!Array.isArray(payload.customAttributes)) {
    throw new Error('customAttributes missing');
  }
  for (const entry of payload.customAttributes) {
    if (isRecord(entry) && entry.key === 'Gift Message') {
      entry.value = gift;
      return;
    }
  }
  throw new Error('gift message missing');
}

async function waitForUngrantedLock(): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3_000) {
    const rows = await started().get(PrismaService).client.$queryRaw<{ waiting: number }[]>`
      SELECT COUNT(*)::int AS waiting FROM pg_locks WHERE NOT granted
    `;
    if ((rows[0]?.waiting ?? 0) > 0) {
      return true;
    }
    await delay(50);
  }
  return false;
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

async function bootApp(): Promise<INestApplication> {
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
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
    const server = application.getHttpServer() as { setMaxListeners(count: number): void };
    server.setMaxListeners(0);
    return application;
}

function started(): INestApplication {
  if (!app) {
    throw new Error('the API was not started');
  }
  return app;
}

function text(response: request.Response): string {
  return JSON.stringify(response.body);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('expected an object');
  }
  return value;
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

function detailField(details: unknown, key: string): string | undefined {
  if (!isRecord(details)) {
    return undefined;
  }
  const value = details[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
