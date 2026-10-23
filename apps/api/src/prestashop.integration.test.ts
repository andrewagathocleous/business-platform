import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, TenantDb, type TenantTransaction } from '@bp/db';
import { instantToWallTimeInZone, wallTimeInZoneToInstant } from '@bp/domain';
import { prestashopFixturesDirectory } from '@bp/integrations';
import { Logger } from 'nestjs-pino';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertDatabaseNameIsTest,
  assertEnvConnectionsTargetTestDatabase,
  assertTestDatabaseUrls,
} from '../../../tools/test-db-guard.mjs';
import { AppModule } from './app.module';
import { JobRunner, type ExternalJobHandler } from './automation/jobs/job-runner';
import { PrestashopPoller } from './automation/prestashop-poller';
import { prestashopPollIdempotencyKey } from './automation/store-sync.service';
import { correlationStorage } from './correlation/correlation';
import { PrismaService } from './database/prisma.service';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { LOG_STREAM } from './logging/logging.module';
import { CredentialVault } from './vault/credential-vault';

const COMPANY_A = 'Demo Company A Ltd (fictional)';
const COMPANY_B = 'Demo Company B Ltd (fictional)';
const ZONE = 'Asia/Nicosia';
const START = '2026-01-15 10:00:00';
const FIRST_IMPORT = '2026-01-01 00:00:00';
const KEY = '0123456789abcdef0123456789abcdef';
const BASIC = `Basic ${Buffer.from(`${KEY}:`, 'utf8').toString('base64')}`;
const runId = randomUUID().slice(0, 8);
const GIFT = fixtureGift();

type Agent = ReturnType<typeof request.agent>;
type Session = { agent: Agent; xsrf: string };
type Method = 'get' | 'post';
type ShopOrder = Record<string, unknown> & {
  id: string;
  reference: string;
  date_add: string;
  date_upd: string;
  current_state: string;
  gift: string;
  gift_message: string;
};
type Seen = {
  pathname: string;
  params: Record<string, string>;
  raw: string;
};

const logs: string[] = [];
const shop = {
  orders: [] as ShopOrder[],
  status: null as number | null,
  hold: null as Promise<void> | null,
  requests: [] as Seen[],
  failFullOrdersAfter: null as number | null,
  fullOrderCalls: 0,
};
const resources = loadResources();
const inflight: Promise<unknown>[] = [];
let releaseHold: () => void = () => undefined;
let sequence = 0;
let app: INestApplication | undefined;
let origin = '';
let closeFake: (() => Promise<void>) | undefined;
let storageRoot = '';
let mockRoot = '';
let companyA = '';
let companyB = '';
let adminUserId = '';
let connectionId = '';
let storeId = '';
let credentialId = '';
let shopifyConnectionId = '';
let admin: Session;
let syncToken = '';
let ingestToken = '';

const savedEnv = {
  APP_ENV: process.env.APP_ENV,
  AUTH_DEV_LOGIN_ENABLED: process.env.AUTH_DEV_LOGIN_ENABLED,
  SESSION_COOKIE_SECURE: process.env.SESSION_COOKIE_SECURE,
  CSRF_SECRET: process.env.CSRF_SECRET,
  AUTH_REQUIRE_MFA_FOR_PRIVILEGED: process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED,
  OUTBOUND_ALLOW_LOOPBACK_FOR_TESTS: process.env.OUTBOUND_ALLOW_LOOPBACK_FOR_TESTS,
  APP_MASTER_KEYS: process.env.APP_MASTER_KEYS,
  APP_MASTER_KEY_ACTIVE: process.env.APP_MASTER_KEY_ACTIVE,
  STORAGE_ROOT: process.env.STORAGE_ROOT,
  MOCK_PRINT_ROOT: process.env.MOCK_PRINT_ROOT,
  THROTTLE_ENABLED_IN_TEST: process.env.THROTTLE_ENABLED_IN_TEST,
};

describe('PrestaShop reader', () => {
  beforeAll(async () => {
    const refusal = assertTestDatabaseUrls();
    if (refusal) {
      throw new Error(refusal);
    }
    await assertEnvConnectionsTargetTestDatabase();
    seedDatabase();
    const fake = await startFake();
    origin = fake.origin;
    closeFake = fake.close;
    storageRoot = mkdtempSync(join(tmpdir(), 'bp-r1c2-store-'));
    mockRoot = mkdtempSync(join(tmpdir(), 'bp-r1c2-print-'));
    process.env.APP_ENV = 'test';
    process.env.AUTH_DEV_LOGIN_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECURE = 'false';
    process.env.CSRF_SECRET = 'integration-test-csrf-secret';
    process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED = 'false';
    process.env.OUTBOUND_ALLOW_LOOPBACK_FOR_TESTS = 'true';
    process.env.APP_MASTER_KEYS = JSON.stringify({ k1: Buffer.alloc(32, 7).toString('base64') });
    process.env.APP_MASTER_KEY_ACTIVE = 'k1';
    process.env.STORAGE_ROOT = storageRoot;
    process.env.MOCK_PRINT_ROOT = mockRoot;
    delete process.env.THROTTLE_ENABLED_IN_TEST;
    app = await bootApp();
    const prisma = app.get(PrismaService);
    const databases = await prisma.client.$queryRaw<
      { current_database: string; current_user: string }[]
    >`
      SELECT current_database() AS current_database, current_user AS current_user
    `;
    assertDatabaseNameIsTest(databases[0]?.current_database, 'DATABASE_URL');
    expect(databases[0]?.current_user).toBe('bp_app');
    const runner = app.get(JobRunner);
    runner.leaseMs = 180_000;
    companyA = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_A } }))
      .id;
    companyB = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_B } }))
      .id;
    adminUserId = (
      await prisma.client.userAccount.findFirstOrThrow({ where: { email: 'admin.a@example.test' } })
    ).id;
    const shopify = await withCompany(companyA, (tx) =>
      tx.store.findFirstOrThrow({ where: { companyId: companyA, name: 'Nutbox Demo Shopify' } }),
    );
    shopifyConnectionId = (
      await withCompany(companyA, (tx) =>
        tx.storeConnection.findFirstOrThrow({
          where: { companyId: companyA, storeId: shopify.id, status: 'active' },
        }),
      )
    ).id;
    await deleteFictionalStores();
    admin = await login(app, 'admin.a@example.test');
    syncToken = await createToken(['store.sync.trigger'], 'sync');
    ingestToken = await createToken(['store.events.ingest'], 'ingest');
    credentialId = (
      await correlationStorage.run({ correlationId: cid('seal-key') }, () =>
        started().get(CredentialVault).encrypt({
          companyId: companyA,
          provider: 'prestashop',
          label: 'webservice_key',
          plaintext: KEY,
          createdById: adminUserId,
        }),
      )
    ).id;
    const store = await withCompany(companyA, (tx) =>
      tx.store.create({
        data: {
          companyId: companyA,
          brandId: shopify.brandId,
          locationId: shopify.locationId,
          platform: 'prestashop',
          name: `Fictional PrestaShop ${runId}`,
          domain: `fictional-${runId}.prestashop.test`,
          deliveryMethodMap: { '2': 'courier_cy', '9': 'post_international' },
          status: 'active',
        },
      }),
    );
    storeId = store.id;
    connectionId = (
      await withCompany(companyA, (tx) =>
        tx.storeConnection.create({
          data: {
            companyId: companyA,
            storeId,
            mode: 'live',
            status: 'active',
            credentialId,
            readOnly: true,
            writeBackEnabled: false,
            settings: liveSettings(FIRST_IMPORT),
          },
        }),
      )
    ).id;
  }, 180_000);

  beforeEach(async () => {
    releaseHold();
    shop.orders = [];
    shop.status = null;
    shop.hold = null;
    shop.requests = [];
    shop.failFullOrdersAfter = null;
    shop.fullOrderCalls = 0;
    const waiting = inflight.splice(0);
    await Promise.allSettled(waiting);
    if (!app || !connectionId) {
      return;
    }
    setPollConcurrency(1);
    started().get(PrestashopPoller).hooks = null;
    await started()
      .get(PrismaService)
      .client.job.updateMany({
        where: { status: 'queued' },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
    await deleteImported();
    await resetConnection();
  });

  afterEach(async () => {
    assertShopRequests();
    if (app && companyA) {
      await assertSecretsHidden();
    }
  });

  afterAll(async () => {
    releaseHold();
    await Promise.allSettled(inflight.splice(0));
    if (app && connectionId) {
      await deleteImported();
      await withCompany(companyA, async (tx) => {
        await tx.storeConnection.delete({ where: { id: connectionId } });
        await tx.store.delete({ where: { id: storeId } });
        await tx.integrationCredential.delete({ where: { id: credentialId } });
      });
    }
    if (app) {
      await app.close();
      app = undefined;
    }
    if (closeFake) {
      await closeFake();
    }
    if (storageRoot) {
      rmSync(storageRoot, { recursive: true, force: true });
    }
    if (mockRoot) {
      rmSync(mockRoot, { recursive: true, force: true });
    }
    restoreEnv('APP_ENV', savedEnv.APP_ENV);
    restoreEnv('AUTH_DEV_LOGIN_ENABLED', savedEnv.AUTH_DEV_LOGIN_ENABLED);
    restoreEnv('SESSION_COOKIE_SECURE', savedEnv.SESSION_COOKIE_SECURE);
    restoreEnv('CSRF_SECRET', savedEnv.CSRF_SECRET);
    restoreEnv('AUTH_REQUIRE_MFA_FOR_PRIVILEGED', savedEnv.AUTH_REQUIRE_MFA_FOR_PRIVILEGED);
    restoreEnv('OUTBOUND_ALLOW_LOOPBACK_FOR_TESTS', savedEnv.OUTBOUND_ALLOW_LOOPBACK_FOR_TESTS);
    restoreEnv('APP_MASTER_KEYS', savedEnv.APP_MASTER_KEYS);
    restoreEnv('APP_MASTER_KEY_ACTIVE', savedEnv.APP_MASTER_KEY_ACTIVE);
    restoreEnv('STORAGE_ROOT', savedEnv.STORAGE_ROOT);
    restoreEnv('MOCK_PRINT_ROOT', savedEnv.MOCK_PRINT_ROOT);
    restoreEnv('THROTTLE_ENABLED_IN_TEST', savedEnv.THROTTLE_ENABLED_IN_TEST);
  });

  it('rejects a staff session on store-sync', async () => {
    const correlationId = cid('staff');
    const response = await admin.agent
      .post(syncUrl(companyA))
      .set('X-XSRF-TOKEN', admin.xsrf)
      .set('X-Correlation-Id', correlationId);
    expect(response.status).toBe(401);
    expect(detailReason((await auditEvents(correlationId, companyA))[0]?.details)).toBe(
      'automation_requires_bearer',
    );
  });

  it('refuses a token without store.sync.trigger', async () => {
    const correlationId = cid('forbidden');
    const response = await postSync(ingestToken, companyA, correlationId);
    expect(response.status).toBe(403);
    expect(detailReason((await auditEvents(correlationId, companyA))[0]?.details)).toBe(
      'permission_missing',
    );
  });

  it('returns 404 when company A token calls company B', async () => {
    const correlationId = cid('cross');
    const response = await postSync(syncToken, companyB, correlationId);
    expect(response.status).toBe(404);
    expect(detailReason((await auditEvents(correlationId, companyB))[0]?.details)).toBe(
      'service_company_mismatch',
    );
  });

  it('queues a due connection once in the same interval', async () => {
    const firstId = cid('due-1');
    const secondId = cid('due-2');
    const first = await postSync(syncToken, companyA, firstId);
    const second = await postSync(syncToken, companyA, secondId);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(counts(first)).toEqual({ queued: 1, notDue: 0, skipped: 0 });
    expect(counts(second)).toEqual({ queued: 0, notDue: 0, skipped: 0 });
    const jobs = await pollJobs();
    expect(jobs).toHaveLength(1);
    const key = jobs[0]?.idempotencyKey ?? '';
    expect(key).toBe(prestashopPollIdempotencyKey(connectionId, 180, new Date()));
    expect(await auditEvents(firstId, companyA)).toEqual([]);
    expect(await auditEvents(secondId, companyA)).toEqual([]);
    expect(await pollJobsFor(shopifyConnectionId)).toHaveLength(0);
  });

  it('does not queue a connection that is not due, paused, mock, or Shopify', async () => {
    await withCompany(companyA, (tx) =>
      tx.storeConnection.update({
        where: { id: connectionId },
        data: { lastSyncAt: new Date() },
      }),
    );
    const notDue = await postSync(syncToken, companyA, cid('not-due'));
    expect(notDue.status).toBe(202);
    expect(counts(notDue)).toEqual({ queued: 0, notDue: 1, skipped: 0 });
    expect(await pollJobs()).toHaveLength(0);

    await withCompany(companyA, (tx) =>
      tx.storeConnection.update({
        where: { id: connectionId },
        data: { status: 'paused', lastSyncAt: null },
      }),
    );
    const paused = await postSync(syncToken, companyA, cid('paused'));
    expect(counts(paused)).toEqual({ queued: 0, notDue: 0, skipped: 1 });
    expect(await pollJobs()).toHaveLength(0);

    await withCompany(companyA, (tx) =>
      tx.storeConnection.update({
        where: { id: connectionId },
        data: { status: 'active', mode: 'mock' },
      }),
    );
    const mock = await postSync(syncToken, companyA, cid('mock'));
    expect(counts(mock)).toEqual({ queued: 0, notDue: 0, skipped: 0 });
    expect(await pollJobs()).toHaveLength(0);
    expect(await pollJobsFor(shopifyConnectionId)).toHaveLength(0);

    await withCompany(companyA, (tx) =>
      tx.storeConnection.update({
        where: { id: connectionId },
        data: { mode: 'live', settings: {} },
      }),
    );
    const invalid = await postSync(syncToken, companyA, cid('invalid-settings'));
    expect(invalid.status).toBe(202);
    expect(counts(invalid)).toEqual({ queued: 0, notDue: 0, skipped: 1 });
    expect(await pollJobs()).toHaveLength(0);
  });

  it('imports 120 orders once, updates a newer date_upd, and marks an older one stale', async () => {
    shop.orders = buildOrders(120, START);
    const first = await pollAndDrain('import');
    const imported = await auditEvents(first.correlationId, companyA);
    const sync = imported.find((event) => event.action === 'store.sync_imported');
    expect(sync).toEqual(
      expect.objectContaining({
        actorType: 'system',
        actorLabel: 'prestashop.poll',
        outcome: 'success',
        objectId: connectionId,
      }),
    );
    expect(sync?.details).toEqual({ connectionId, newEvents: 120, duplicates: 1 });
    expect(await inboxCount()).toBe(120);
    expect(await orderCount()).toBe(120);
    const gift = await salesOrder('501');
    expect(Buffer.from(gift.giftMessage ?? '', 'utf8').equals(Buffer.from(GIFT, 'utf8'))).toBe(
      true,
    );
    expect(gift.fulfilmentStatus).toBe('new');
    expect(gift.paymentStatus).toBe('paid');
    const unmapped = await salesOrder('601');
    expect(unmapped.fulfilmentStatus).toBe('review_required');
    expect(unmapped.reviewReason?.split(',')).toContain('unknown_payment');
    const cancelled = await salesOrder('602');
    expect(cancelled.fulfilmentStatus).toBe('review_required');
    expect(cancelled.paymentStatus).toBe('voided');
    expect(cancelled.reviewReason?.split(',')).toContain('cancelled_at_source');
    expect(dateUpdOf((await connection()).syncCheckpoint)).toBe(addSeconds(START, 119));
    const failedInbox = (await inboxRows()).filter((row) => row.status === 'failed');
    expect(failedInbox.map((row) => row.error)).toEqual([]);

    const again = await pollAndDrain('import-again');
    expect(await inboxCount()).toBe(120);
    expect(await orderCount()).toBe(120);
    expect(
      (await auditEvents(again.correlationId, companyA)).some(
        (event) => event.action === 'store.sync_imported',
      ),
    ).toBe(false);

    const target = shop.orders.find((order) => order.id === '501');
    if (!target) {
      throw new Error('order 501 missing');
    }
    target.date_upd = '2026-01-15 12:00:00';
    target.reference = 'DEMO-501B';
    await pollAndDrain('newer');
    const updated = await salesOrder('501');
    expect(updated.externalNumber).toBe('DEMO-501B');
    expect(updated.sourceUpdatedAt?.getTime()).toBe(
      wallTimeInZoneToInstant('2026-01-15 12:00:00', ZONE).getTime(),
    );
    expect(Buffer.from(updated.giftMessage ?? '', 'utf8').equals(Buffer.from(GIFT, 'utf8'))).toBe(
      true,
    );
    expect(dateUpdOf((await connection()).syncCheckpoint)).toBe('2026-01-15 12:00:00');

    target.date_upd = '2026-01-15 11:55:00';
    await pollAndDrain('older');
    const stale = await withCompany(companyA, (tx) =>
      tx.integrationInbox.findFirstOrThrow({
        where: {
          connectionId,
          externalEventId: 'order:501:2026-01-15 11:55:00',
        },
      }),
    );
    expect(stale.status).toBe('stale');
    const unchanged = await salesOrder('501');
    expect(unchanged.externalNumber).toBe('DEMO-501B');
    expect(unchanged.sourceUpdatedAt?.getTime()).toBe(updated.sourceUpdatedAt?.getTime());
    expect(dateUpdOf((await connection()).syncCheckpoint)).toBe('2026-01-15 12:00:00');
    expect(await orderCount()).toBe(120);
  }, 180_000);

  it('keeps every order when the checkpoint write throws after the first page', async () => {
    shop.orders = buildOrders(120, START);
    started().get(PrestashopPoller).hooks = {
      beforeCheckpoint: () => Promise.reject(new Error('injected checkpoint failure')),
    };
    const crashed = await pollAndDrain('crash');
    expect((await jobOf(crashed.id)).status).toBe('failed');
    expect((await connection()).syncCheckpoint).toBeNull();
    expect(await inboxCount()).toBe(100);
    started().get(PrestashopPoller).hooks = null;
    await pollAndDrain('crash-retry');
    expect(await inboxCount()).toBe(120);
    expect(await orderCount()).toBe(120);
    const externalIds = (await salesOrders()).map((order) => order.externalId);
    expect(new Set(externalIds).size).toBe(120);
  }, 180_000);

  it('lets one of two polls take the lease and leaves the other as a no-op', async () => {
    shop.orders = buildOrders(3, START);
    holdNextOrders();
    setPollConcurrency(2);
    const first = await enqueuePoll('lease-a');
    const second = await enqueuePoll('lease-b');
    const runner = started().get(JobRunner);
    const jobA = await runner.claimOne();
    const jobB = await runner.claimOne();
    expect([jobA?.id, jobB?.id].sort()).toEqual([first.id, second.id].sort());
    if (!jobA || !jobB) {
      throw new Error('both polls should be claimed');
    }
    try {
      inflight.push(runner.execute(jobA), runner.execute(jobB));
      await waitFor(
        async () => orderCalls() >= 1 && (await succeededCount([jobA.id, jobB.id])) === 1,
      );
      expect(orderCalls()).toBe(1);
      releaseHold();
      await Promise.all(inflight);
    } finally {
      releaseHold();
      await Promise.allSettled(inflight.splice(0));
      setPollConcurrency(1);
    }
    expect(orderCalls()).toBe(1);
    expect((await jobOf(jobA.id)).status).toBe('succeeded');
    expect((await jobOf(jobB.id)).status).toBe('succeeded');
    expect(await inboxCount()).toBe(3);
    expect((await connection()).syncLockedUntil).toBeNull();
    await drainQueued();
    expect(await orderCount()).toBe(3);
  }, 60_000);

  it('pauses the connection on 401 and the trigger then skips it', async () => {
    shop.status = 401;
    shop.orders = buildOrders(1, START);
    const ran = await pollAndDrain('auth');
    expect((await jobOf(ran.id)).status).toBe('succeeded');
    const row = await connection();
    expect(row.status).toBe('auth_failed');
    expect(row.lastErrorClass).toBe('auth_failed');
    const paused = (await auditEvents(ran.correlationId, companyA)).filter(
      (event) => event.action === 'store.connection_paused',
    );
    expect(paused).toHaveLength(1);
    expect(paused[0]?.outcome).toBe('success');
    expect(paused[0]?.details).toEqual({ reason: 'auth_failed' });
    const trigger = await postSync(syncToken, companyA, cid('auth-skip'));
    expect(trigger.status).toBe(202);
    expect(counts(trigger)).toEqual({ queued: 0, notDue: 0, skipped: 1 });
    expect(await pollJobs()).toHaveLength(1);
  });

  it('audits a 500 once across two failures and leaves the checkpoint', async () => {
    shop.status = 500;
    shop.orders = buildOrders(2, START);
    const first = await pollAndDrain('bad-1');
    const second = await pollAndDrain('bad-2');
    expect((await jobOf(first.id)).status).toBe('failed');
    expect((await jobOf(first.id)).lastError).toBe('bad_response');
    expect((await jobOf(second.id)).status).toBe('failed');
    const row = await connection();
    expect(row.status).toBe('active');
    expect(row.syncCheckpoint).toBeNull();
    expect(row.lastSyncAt).toBeNull();
    expect(row.lastErrorClass).toBe('bad_response');
    const firstAudits = (await auditEvents(first.correlationId, companyA)).filter(
      (event) => event.action === 'store.sync_failed',
    );
    const secondAudits = (await auditEvents(second.correlationId, companyA)).filter(
      (event) => event.action === 'store.sync_failed',
    );
    expect(firstAudits).toHaveLength(1);
    expect(firstAudits[0]?.outcome).toBe('failure');
    expect(firstAudits[0]?.details).toEqual({ connectionId, errorClass: 'bad_response' });
    expect(secondAudits).toHaveLength(0);
  });

  it('stops when more than 100 orders share the requested second', async () => {
    const firstImportFrom = '2026-06-15 12:00:00';
    const from = instantToWallTimeInZone(
      new Date(wallTimeInZoneToInstant(firstImportFrom, ZONE).getTime() - 10 * 60 * 1000),
      ZONE,
    );
    await withCompany(companyA, (tx) =>
      tx.storeConnection.update({
        where: { id: connectionId },
        data: { settings: liveSettings(firstImportFrom) },
      }),
    );
    shop.orders = buildOrders(101, from).map((order) => ({
      ...order,
      date_add: from,
      date_upd: from,
    }));
    const ran = await pollAndDrain('no-progress');
    expect((await jobOf(ran.id)).status).toBe('failed');
    expect((await jobOf(ran.id)).lastError).toBe('too_many_in_one_second');
    const row = await connection();
    expect(row.lastErrorClass).toBe('too_many_in_one_second');
    expect(row.syncCheckpoint).toBeNull();
    expect(row.lastSyncAt).toBeNull();
    expect(row.status).toBe('active');
    expect(await inboxCount()).toBe(100);
    const failed = (await auditEvents(ran.correlationId, companyA)).filter(
      (event) => event.action === 'store.sync_failed',
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.details).toEqual({ connectionId, errorClass: 'too_many_in_one_second' });
  }, 120_000);

  it('imports an order past a 2,400-order overlap in one run', async () => {
    const checkpoint = '2026-06-15 12:10:00';
    const overlapStart = '2026-06-15 12:00:00';
    const newerAt = '2026-06-15 12:11:00';
    const existing = datedOrders(2_400, (index) => addSeconds(overlapStart, Math.floor(index / 4)));
    const newer = datedOrders(1, () => newerAt)[0];
    if (!newer) {
      throw new Error('newer order missing');
    }
    newer.id = '7777';
    newer.reference = 'DEMO-7777';
    shop.orders = [...existing, newer];
    await withCompany(companyA, (tx) =>
      tx.storeConnection.update({
        where: { id: connectionId },
        data: { syncCheckpoint: { dateUpd: checkpoint } },
      }),
    );
    await seedInbox(existing);
    const ran = await runPoll('overlap-pass');
    await drainQueued();
    expect((await jobOf(ran.id)).status).toBe('succeeded');
    expect(orderCalls()).toBe(25);
    expect(dateUpdOf((await connection()).syncCheckpoint)).toBe(newerAt);
    expect((await connection()).lastSyncAt).not.toBeNull();
    const imported = await salesOrder('7777');
    expect(imported.externalNumber).toBe('DEMO-7777');
  }, 300_000);

  it('stops with overlap_too_large when 5,001 orders stay before the checkpoint', async () => {
    const checkpoint = '2026-06-15 12:10:00';
    const overlapStart = '2026-06-15 12:00:00';
    const marker = new Date('2026-04-01T00:00:00.000Z');
    shop.orders = datedOrders(5_001, (index) =>
      addSeconds(overlapStart, Math.floor(index / 9)),
    );
    await withCompany(companyA, (tx) =>
      tx.storeConnection.update({
        where: { id: connectionId },
        data: { syncCheckpoint: { dateUpd: checkpoint }, lastSyncAt: marker },
      }),
    );
    const ran = await runPoll('overlap-cap');
    expect((await jobOf(ran.id)).status).toBe('failed');
    expect((await jobOf(ran.id)).lastError).toBe('overlap_too_large');
    expect(orderCalls()).toBe(50);
    const row = await connection();
    expect(row.status).toBe('active');
    expect(row.lastErrorClass).toBe('overlap_too_large');
    expect(dateUpdOf(row.syncCheckpoint)).toBe(checkpoint);
    expect(row.lastSyncAt?.getTime()).toBe(marker.getTime());
    const failed = (await auditEvents(ran.correlationId, companyA)).filter(
      (event) => event.action === 'store.sync_failed',
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.details).toEqual({ connectionId, errorClass: 'overlap_too_large' });
  }, 300_000);

  it('imports the page already received when the next page is unauthorized', async () => {
    shop.orders = buildOrders(100, START);
    shop.failFullOrdersAfter = 1;
    const ran = await pollAndDrain('page-auth');
    expect((await jobOf(ran.id)).status).toBe('succeeded');
    const row = await connection();
    expect(row.status).toBe('auth_failed');
    expect(await orderCount()).toBe(100);
    const rows = await inboxRows();
    expect(rows).toHaveLength(100);
    expect(rows.every((inbox) => inbox.status === 'processed')).toBe(true);
    const paused = (await auditEvents(ran.correlationId, companyA)).filter(
      (event) => event.action === 'store.connection_paused',
    );
    expect(paused).toHaveLength(1);
  }, 180_000);

  it('imports from firstImportFrom when the checkpoint is not a real date', async () => {
    shop.orders = buildOrders(2, START);
    await withCompany(companyA, (tx) =>
      tx.storeConnection.update({
        where: { id: connectionId },
        data: { syncCheckpoint: { dateUpd: '2026-02-30 12:00:00' } },
      }),
    );
    const ran = await pollAndDrain('bad-checkpoint');
    expect((await jobOf(ran.id)).status).toBe('succeeded');
    expect(await orderCount()).toBe(2);
    expect(dateUpdOf((await connection()).syncCheckpoint)).toBe('2026-01-15 10:00:01');
    expect((await connection()).lastErrorClass).toBeNull();
    const failed = (await auditEvents(ran.correlationId, companyA)).filter(
      (event) => event.action === 'store.sync_failed',
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.outcome).toBe('failure');
    expect(failed[0]?.details).toEqual({ connectionId, errorClass: 'checkpoint_reset' });
  });

  it('makes no shop request when the key is missing or revoked', async () => {
    await withCompany(companyA, (tx) =>
      tx.storeConnection.update({
        where: { id: connectionId },
        data: { credentialId: null },
      }),
    );
    const missing = await pollAndDrain('no-key');
    expect(shop.requests).toHaveLength(0);
    expect((await jobOf(missing.id)).status).toBe('failed');
    expect((await jobOf(missing.id)).lastError).toBe('credential_unavailable');
    expect((await connection()).status).toBe('active');
    expect((await connection()).lastErrorClass).toBe('credential_unavailable');
    expect(
      (await auditEvents(missing.correlationId, companyA)).some(
        (event) => event.action === 'store.sync_failed',
      ),
    ).toBe(false);

    shop.requests = [];
    await withCompany(companyA, async (tx) => {
      await tx.integrationCredential.update({
        where: { id: credentialId },
        data: { revokedAt: new Date() },
      });
      await tx.storeConnection.update({
        where: { id: connectionId },
        data: { credentialId, lastErrorClass: null, lastErrorAt: null },
      });
    });
    const revoked = await pollAndDrain('revoked-key');
    expect(shop.requests).toHaveLength(0);
    expect((await jobOf(revoked.id)).lastError).toBe('credential_unavailable');
    expect((await connection()).status).toBe('active');
    expect(
      (await auditEvents(revoked.correlationId, companyA)).some(
        (event) => event.action === 'store.sync_failed',
      ),
    ).toBe(false);
  });
});

function liveSettings(firstImportFrom: string): Prisma.InputJsonValue {
  return {
    baseUrl: origin,
    timezone: ZONE,
    firstImportFrom,
    pollIntervalSeconds: 180,
    stateMap: {
      '2': { payment: 'paid', cancelled: false },
      '10': { payment: 'pending', cancelled: false },
      '6': { payment: 'voided', cancelled: true },
    },
  };
}

function buildOrders(count: number, start: string): ShopOrder[] {
  const orders: ShopOrder[] = [];
  for (let index = 0; index < count; index += 1) {
    const order = baseOrder();
    const id =
      index === 0 ? '501' : index === 1 ? '601' : index === 2 ? '602' : String(1000 + index);
    const when = addSeconds(start, index);
    order.id = id;
    order.reference = `DEMO-${id}`;
    order.date_add = when;
    order.date_upd = when;
    order.current_state = index === 1 ? '99' : index === 2 ? '6' : '2';
    order.gift = index === 0 ? '1' : '0';
    if (index !== 0) {
      order.gift_message = '';
    }
    orders.push(order);
  }
  return orders;
}

function addSeconds(wall: string, seconds: number): string {
  const instant = wallTimeInZoneToInstant(wall, ZONE);
  return instantToWallTimeInZone(new Date(instant.getTime() + seconds * 1000), ZONE);
}

function datedOrders(count: number, at: (index: number) => string): ShopOrder[] {
  const seed = baseOrder();
  const orders: ShopOrder[] = [];
  for (let index = 0; index < count; index += 1) {
    const order = structuredClone(seed);
    const id = String(10_000 + index);
    const when = at(index);
    order.id = id;
    order.reference = `DEMO-${id}`;
    order.date_add = when;
    order.date_upd = when;
    order.current_state = '2';
    order.gift = '0';
    order.gift_message = '';
    orders.push(order);
  }
  return orders;
}

async function seedInbox(orders: readonly ShopOrder[]): Promise<void> {
  const chunk = 500;
  for (let start = 0; start < orders.length; start += chunk) {
    const slice = orders.slice(start, start + chunk);
    await withCompany(companyA, (tx) =>
      tx.integrationInbox.createMany({
        data: slice.map((order) => ({
          companyId: companyA,
          connectionId,
          provider: 'prestashop',
          externalEventId: `order:${order.id}:${order.date_upd}`,
          topic: 'orders/updated',
          externalObjectId: order.id,
          sourceUpdatedAt: wallTimeInZoneToInstant(order.date_upd, ZONE),
          payload: {},
          status: 'processed',
        })),
      }),
    );
  }
}

function holdNextOrders(): void {
  shop.hold = new Promise((resolveHold) => {
    releaseHold = () => {
      releaseHold = () => undefined;
      resolveHold();
    };
  });
}

function orderCalls(): number {
  return shop.requests.filter(
    (entry) => entry.pathname === '/api/orders' && entry.params.display === 'full',
  ).length;
}

function assertShopRequests(): void {
  for (const entry of shop.requests) {
    expect(entry.raw.toLowerCase()).not.toContain('ws_key');
    expect(entry.raw.toLowerCase()).not.toContain('output_format');
    expect(entry.raw).not.toContain(KEY);
    if (entry.pathname === '/api/customers') {
      expect(entry.params.display).toBe('[id,firstname,lastname,email]');
    }
    if (entry.pathname === '/api/orders' && entry.params.display === 'full') {
      expect(entry.params.limit?.startsWith('0,')).toBe(true);
    }
  }
}

async function assertSecretsHidden(): Promise<void> {
  const text = logs.join('');
  expect(text.includes(KEY)).toBe(false);
  expect(text.includes(BASIC)).toBe(false);
  const jobs = await started().get(PrismaService).client.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM job
    WHERE strpos(payload::text, ${KEY}) > 0
       OR strpos(coalesce(last_error, ''), ${KEY}) > 0
       OR strpos(payload::text, ${BASIC}) > 0
       OR strpos(coalesce(last_error, ''), ${BASIC}) > 0
  `;
  expect(jobs[0]?.n ?? 0).toBe(0);
  const rest = await withCompany(
    companyA,
    (tx) => tx.$queryRaw<{ n: number }[]>`
    SELECT (
      (SELECT count(*) FROM integration_inbox
        WHERE strpos(payload::text, ${KEY}) > 0
           OR strpos(coalesce(error, ''), ${KEY}) > 0
           OR strpos(payload::text, ${BASIC}) > 0
           OR strpos(coalesce(error, ''), ${BASIC}) > 0)
      +
      (SELECT count(*) FROM audit_event
        WHERE strpos(coalesce(details::text, ''), ${KEY}) > 0
           OR strpos(coalesce(details::text, ''), ${BASIC}) > 0)
    )::int AS n
  `,
  );
  expect(rest[0]?.n ?? 0).toBe(0);
}

function setPollConcurrency(concurrency: number): void {
  const poller = started().get(PrestashopPoller);
  const handler: ExternalJobHandler = {
    type: 'prestashop.poll',
    concurrency,
    retryable: true,
    mode: 'external',
    run: (job, external) => poller.run(job, external),
  };
  started().get(JobRunner).register(handler);
}

async function enqueuePoll(
  name: string,
  timeoutMs = 240_000,
): Promise<{ id: string; correlationId: string }> {
  const correlationId = cid(name);
  const id = randomUUID();
  sequence += 1;
  await started()
    .get(PrismaService)
    .client.job.create({
      data: {
        id,
        companyId: companyA,
        type: 'prestashop.poll',
        payload: { connectionId },
        status: 'queued',
        attempts: 0,
        maxAttempts: 1,
        timeoutMs,
        runAfter: new Date(),
        correlationId,
        idempotencyKey: `prestashop.poll:${connectionId}:test:${name}:${runId}:${String(sequence)}`,
      },
    });
  return { id, correlationId };
}

async function pollAndDrain(name: string): Promise<{ id: string; correlationId: string }> {
  const job = await enqueuePoll(name);
  await drain();
  return job;
}

async function runPoll(name: string): Promise<{ id: string; correlationId: string }> {
  const queued = await enqueuePoll(name);
  const runner = started().get(JobRunner);
  const job = await runner.claimOne();
  if (!job || job.id !== queued.id) {
    throw new Error('poll was not claimed');
  }
  await runner.execute(job);
  return queued;
}

async function drain(): Promise<void> {
  await cancelForeignQueued();
  await drainQueued();
}

async function drainQueued(): Promise<void> {
  const runner = started().get(JobRunner);
  const previous = runner.drainDeadlineMs;
  runner.drainDeadlineMs = 180_000;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const result = await runner.drainOnce();
      if (result.processed === 0) {
        return;
      }
    }
  } finally {
    runner.drainDeadlineMs = previous;
  }
  throw new Error('drain did not finish');
}

async function cancelForeignQueued(): Promise<void> {
  await withCompany(
    companyA,
    (tx) => tx.$executeRaw`
    UPDATE job
    SET status = 'cancelled', finished_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE status = 'queued'
      AND NOT (
        type = 'prestashop.poll' AND payload->>'connectionId' = ${connectionId}
      )
      AND NOT (
        type = 'inbox.process'
        AND payload->>'inboxId' IN (
          SELECT id::text FROM integration_inbox WHERE connection_id = ${connectionId}::uuid
        )
      )
  `,
  );
}

async function deleteFictionalStores(): Promise<void> {
  const stores = await withCompany(companyA, (tx) =>
    tx.store.findMany({
      where: { companyId: companyA, name: { startsWith: 'Fictional PrestaShop ' } },
      select: { id: true },
    }),
  );
  for (const store of stores) {
    const connections = await withCompany(companyA, (tx) =>
      tx.storeConnection.findMany({
        where: { companyId: companyA, storeId: store.id },
        select: { id: true },
      }),
    );
    for (const connection of connections) {
      connectionId = connection.id;
      await deleteImported();
      await withCompany(companyA, (tx) =>
        tx.storeConnection.delete({ where: { id: connection.id } }),
      );
    }
    await withCompany(companyA, (tx) => tx.store.delete({ where: { id: store.id } }));
  }
  connectionId = '';
  const credentials = await withCompany(companyA, (tx) =>
    tx.integrationCredential.findMany({
      where: { companyId: companyA, provider: 'prestashop', label: 'webservice_key' },
      select: { id: true },
    }),
  );
  for (const credential of credentials) {
    const used = await withCompany(companyA, (tx) =>
      tx.storeConnection.count({ where: { companyId: companyA, credentialId: credential.id } }),
    );
    if (used === 0) {
      await withCompany(companyA, (tx) =>
        tx.integrationCredential.delete({ where: { id: credential.id } }),
      );
    }
  }
}

async function resetConnection(): Promise<void> {
  await withCompany(companyA, async (tx) => {
    await tx.integrationCredential.update({
      where: { id: credentialId },
      data: { revokedAt: null },
    });
    await tx.storeConnection.update({
      where: { id: connectionId },
      data: {
        status: 'active',
        mode: 'live',
        readOnly: true,
        writeBackEnabled: false,
        credentialId,
        lastSyncAt: null,
        lastErrorClass: null,
        lastErrorAt: null,
        syncLockedUntil: null,
        syncCheckpoint: Prisma.DbNull,
        settings: liveSettings(FIRST_IMPORT),
      },
    });
  });
}

async function deleteImported(): Promise<void> {
  await withCompany(companyA, async (tx) => {
    await tx.$executeRaw`
      DELETE FROM job
      WHERE type = 'inbox.process'
        AND payload->>'inboxId' IN (
          SELECT id::text FROM integration_inbox WHERE connection_id = ${connectionId}::uuid
        )
    `;
    await tx.$executeRaw`
      DELETE FROM job
      WHERE type = 'prestashop.poll' AND payload->>'connectionId' = ${connectionId}
    `;
    const orders = await tx.salesOrder.findMany({
      where: { companyId: companyA, connectionId },
      select: { id: true },
    });
    const orderIds = orders.map((order) => order.id);
    if (orderIds.length > 0) {
      await tx.orderNote.deleteMany({ where: { companyId: companyA, orderId: { in: orderIds } } });
      await tx.salesOrderLine.deleteMany({
        where: { companyId: companyA, orderId: { in: orderIds } },
      });
    }
    await tx.salesOrder.deleteMany({ where: { companyId: companyA, connectionId } });
    await tx.integrationInbox.deleteMany({ where: { companyId: companyA, connectionId } });
  });
}

async function pollJobs() {
  return pollJobsFor(connectionId);
}

function pollJobsFor(id: string) {
  return started()
    .get(PrismaService)
    .client.job.findMany({
      where: {
        type: 'prestashop.poll',
        payload: { path: ['connectionId'], equals: id },
      },
    });
}

function jobOf(id: string) {
  return started().get(PrismaService).client.job.findUniqueOrThrow({ where: { id } });
}

function connection() {
  return withCompany(companyA, (tx) =>
    tx.storeConnection.findFirstOrThrow({ where: { id: connectionId, companyId: companyA } }),
  );
}

function inboxRows() {
  return withCompany(companyA, (tx) =>
    tx.integrationInbox.findMany({ where: { companyId: companyA, connectionId } }),
  );
}

async function inboxCount(): Promise<number> {
  return withCompany(companyA, (tx) =>
    tx.integrationInbox.count({ where: { companyId: companyA, connectionId } }),
  );
}

function salesOrders() {
  return withCompany(companyA, (tx) =>
    tx.salesOrder.findMany({ where: { companyId: companyA, connectionId } }),
  );
}

async function orderCount(): Promise<number> {
  return withCompany(companyA, (tx) =>
    tx.salesOrder.count({ where: { companyId: companyA, connectionId } }),
  );
}

function salesOrder(externalId: string) {
  return withCompany(companyA, (tx) =>
    tx.salesOrder.findFirstOrThrow({
      where: { companyId: companyA, connectionId, externalId },
    }),
  );
}

async function succeededCount(ids: string[]): Promise<number> {
  const rows = await started()
    .get(PrismaService)
    .client.job.findMany({
      where: { id: { in: ids } },
      select: { status: true },
    });
  return rows.filter((row) => row.status === 'succeeded').length;
}

function syncUrl(companyId: string): string {
  return `/api/automation/v1/c/${companyId}/store-sync`;
}

function postSync(token: string, companyId: string, correlationId: string) {
  return request(started().getHttpServer() as App)
    .post(syncUrl(companyId))
    .set('Authorization', `Bearer ${token}`)
    .set('X-Correlation-Id', correlationId);
}

function counts(response: request.Response): { queued: number; notDue: number; skipped: number } {
  const body = record(response.body);
  return {
    queued: numberField(body, 'queued'),
    notDue: numberField(body, 'notDue'),
    skipped: numberField(body, 'skipped'),
  };
}

async function createToken(permissions: string[], label: string): Promise<string> {
  const response = await send(
    admin,
    'post',
    `/api/c/${companyA}/service-identities`,
    cid(`token-${label}`),
    {
      name: `prestashop-${label}-${runId}`,
      purpose: 'store sync test',
      permissions,
    },
  );
  expect(response.status, text(response)).toBe(200);
  return stringField(record(response.body), 'token');
}

async function login(application: INestApplication, email: string): Promise<Session> {
  const agent = request.agent(application.getHttpServer() as App);
  const response = await agent.post('/api/auth/dev/login').send({ email });
  expect(response.status, text(response)).toBe(200);
  return { agent, xsrf: cookieValue(cookieHeader(response, 'XSRF-TOKEN'), 'XSRF-TOKEN') };
}

function send(
  session: Session,
  method: Method,
  url: string,
  correlationId?: string,
  payload?: object,
) {
  const call = session.agent[method](url).set('X-XSRF-TOKEN', session.xsrf);
  if (correlationId) {
    call.set('X-Correlation-Id', correlationId);
  }
  if (payload !== undefined) {
    call.send(payload);
  }
  return call;
}

async function auditEvents(correlationId: string, companyId: string) {
  const prisma = started().get(PrismaService);
  return prisma.client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform_scope', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.company_id', ${companyId}, true)`;
    return tx.auditEvent.findMany({ where: { correlationId }, orderBy: { occurredAt: 'asc' } });
  });
}

function withCompany<T>(
  companyId: string,
  fn: (tx: TenantTransaction) => Promise<T>,
  actor = 'prestashop-test',
): Promise<T> {
  return new TenantDb(started().get(PrismaService).client).run(
    { companyId, actor, correlationId: cid('db') },
    fn,
  );
}

function cid(name: string): string {
  return `r1c2-${name}-${runId}`.slice(0, 64);
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
    write(chunk, _encoding, callback) {
      logs.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
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

function dateUpdOf(value: unknown): string | null {
  if (!isRecord(value) || typeof value.dateUpd !== 'string') {
    return null;
  }
  return value.dateUpd;
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

function detailReason(details: unknown): string {
  if (!isRecord(details)) {
    return '';
  }
  return typeof details.reason === 'string' ? details.reason : '';
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
    throw new Error(`cookie ${name} was empty`);
  }
  return value;
}

function restoreEnv(name: EnvName, value: string | undefined): void {
  if (value === undefined) {
    switch (name) {
      case 'APP_ENV':
        delete process.env.APP_ENV;
        return;
      case 'AUTH_DEV_LOGIN_ENABLED':
        delete process.env.AUTH_DEV_LOGIN_ENABLED;
        return;
      case 'SESSION_COOKIE_SECURE':
        delete process.env.SESSION_COOKIE_SECURE;
        return;
      case 'CSRF_SECRET':
        delete process.env.CSRF_SECRET;
        return;
      case 'AUTH_REQUIRE_MFA_FOR_PRIVILEGED':
        delete process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED;
        return;
      case 'OUTBOUND_ALLOW_LOOPBACK_FOR_TESTS':
        delete process.env.OUTBOUND_ALLOW_LOOPBACK_FOR_TESTS;
        return;
      case 'APP_MASTER_KEYS':
        delete process.env.APP_MASTER_KEYS;
        return;
      case 'APP_MASTER_KEY_ACTIVE':
        delete process.env.APP_MASTER_KEY_ACTIVE;
        return;
      case 'STORAGE_ROOT':
        delete process.env.STORAGE_ROOT;
        return;
      case 'MOCK_PRINT_ROOT':
        delete process.env.MOCK_PRINT_ROOT;
        return;
      case 'THROTTLE_ENABLED_IN_TEST':
        delete process.env.THROTTLE_ENABLED_IN_TEST;
        return;
      default: {
        const unreachable: never = name;
        throw new Error(unreachable);
      }
    }
  }
  process.env[name] = value;
}

type EnvName =
  | 'APP_ENV'
  | 'AUTH_DEV_LOGIN_ENABLED'
  | 'SESSION_COOKIE_SECURE'
  | 'CSRF_SECRET'
  | 'AUTH_REQUIRE_MFA_FOR_PRIVILEGED'
  | 'OUTBOUND_ALLOW_LOOPBACK_FOR_TESTS'
  | 'APP_MASTER_KEYS'
  | 'APP_MASTER_KEY_ACTIVE'
  | 'STORAGE_ROOT'
  | 'MOCK_PRINT_ROOT'
  | 'THROTTLE_ENABLED_IN_TEST';

async function waitFor(ready: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await ready()) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting');
    }
    await new Promise((resolveWait) => {
      setTimeout(resolveWait, 20);
    });
  }
}

function fixtureGift(): string {
  const order = baseOrder();
  if (order.gift_message.length === 0) {
    throw new Error('gift message missing');
  }
  return order.gift_message;
}

function baseOrder(): ShopOrder {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(prestashopFixturesDirectory(), 'orders-page-1.json'), 'utf8'),
  );
  if (!isRecord(parsed) || !Array.isArray(parsed.orders) || !isRecord(parsed.orders[0])) {
    throw new Error('orders fixture missing');
  }
  return structuredClone(parsed.orders[0]) as ShopOrder;
}

function loadResources(): Map<string, Record<string, unknown>[]> {
  const files: Record<string, string> = {
    customers: 'customers.json',
    addresses: 'addresses.json',
    countries: 'countries.json',
    carriers: 'carriers.json',
    currencies: 'currencies.json',
    order_states: 'order-states.json',
  };
  const loaded = new Map<string, Record<string, unknown>[]>();
  for (const [name, file] of Object.entries(files)) {
    const parsed: unknown = JSON.parse(
      readFileSync(resolve(prestashopFixturesDirectory(), file), 'utf8'),
    );
    if (!isRecord(parsed) || !Array.isArray(parsed[name])) {
      throw new Error(`${name} fixture missing`);
    }
    loaded.set(
      name,
      parsed[name].filter((row): row is Record<string, unknown> => isRecord(row)),
    );
  }
  return loaded;
}

async function startFake(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('missing port');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolveClose();
          }
        });
      });
    },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const seen = capture(req);
  shop.requests.push(seen);
  req.resume();
  if (shop.status !== null) {
    json(res, shop.status, {});
    return;
  }
  if (seen.pathname === '/api/orders' && seen.params.display === 'full') {
    shop.fullOrderCalls += 1;
    if (shop.failFullOrdersAfter !== null && shop.fullOrderCalls > shop.failFullOrdersAfter) {
      json(res, 401, {});
      return;
    }
  }
  if (seen.pathname === '/api/orders' && seen.params.display === 'full' && shop.hold) {
    const pending = shop.hold;
    shop.hold = null;
    await pending;
  }
  if (seen.pathname === '/api/orders') {
    const page = filterOrders(shop.orders, seen.params);
    json(res, 200, page.length === 0 ? [] : { orders: page });
    return;
  }
  const name = seen.pathname.replace(/^\/api\//, '');
  const rows = resources.get(name);
  if (!rows) {
    json(res, 404, []);
    return;
  }
  const filtered = filterIds(rows, seen.params['filter[id]']);
  json(res, 200, filtered.length === 0 ? [] : { [name]: filtered });
}

function filterOrders(orders: readonly ShopOrder[], params: Record<string, string>): ShopOrder[] {
  const match = /^\[(.+),(.+)\]$/.exec(params['filter[date_upd]'] ?? '');
  const from = match?.[1] ?? '';
  const to = match?.[2] ?? '';
  const chosen = orders.filter((order) => order.date_upd >= from && order.date_upd <= to);
  const [offsetText, countText] = (params.limit ?? '0,100').split(',');
  const offset = Number(offsetText ?? '0');
  const count = Number(countText ?? '100');
  return [...chosen]
    .sort((left, right) => {
      if (left.date_upd !== right.date_upd) {
        return left.date_upd < right.date_upd ? -1 : 1;
      }
      return Number(left.id) - Number(right.id);
    })
    .slice(offset, offset + count);
}

function filterIds(
  rows: readonly Record<string, unknown>[],
  filter: string | undefined,
): Record<string, unknown>[] {
  if (!filter) {
    return [...rows];
  }
  const ids = new Set(filter.slice(1, -1).split('|'));
  return rows.filter((row) => ids.has(String(row.id)));
}

function capture(req: IncomingMessage): Seen {
  const raw = req.url ?? '';
  const url = new URL(raw, 'http://127.0.0.1');
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    params[key] = value;
  }
  return { pathname: url.pathname, params, raw };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
