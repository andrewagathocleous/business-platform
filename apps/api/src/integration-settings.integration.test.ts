import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, TenantDb, type TenantTransaction } from '@bp/db';
import { wallTimeInZoneToInstant } from '@bp/domain';
import {
  buildPrestashopOrderPayload,
  createPrestashopClient,
  createSafeFetch,
  prestashopFixturesDirectory,
  type PrestashopOrderPayload,
} from '@bp/integrations';
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertDatabaseNameIsTest,
  assertEnvConnectionsTargetTestDatabase,
  assertTestDatabaseUrls,
} from '../../../tools/test-db-guard.mjs';
import { AppModule } from './app.module';
import { JobRunner } from './automation/jobs/job-runner';
import { PrismaService } from './database/prisma.service';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { PrestashopConnectionService } from './integrations/prestashop-connection.service';
import { PrintNodeAccountService } from './integrations/printnode-account.service';
import { LOG_STREAM } from './logging/logging.module';
import { CredentialVault } from './vault/credential-vault';

const COMPANY_A = 'Demo Company A Ltd (fictional)';
const COMPANY_B = 'Demo Company B Ltd (fictional)';
const ZONE = 'Asia/Nicosia';
const KEY = 'FictionalShopKey000000000000W9qZ';
const KEY_2 = 'FictionalShopKey000000000000Q7nR';
const PRINT_KEY = 'FictionalPrintNodeKey000000K3mP';
const PRINT_KEY_2 = 'FictionalPrintNodeKey000000M8rL';
const SECRET_MARKS = [KEY, KEY_2, 'W9qZ', 'Q7nR', PRINT_KEY, PRINT_KEY_2, 'K3mP', 'M8rL'];
const FIXTURE_STORE_PREFIXES = [
  'Settings shop ',
  'Archive shop ',
  'Concurrent shop ',
  'Probe shop ',
  'Blocked shop ',
  'Race shop ',
  'Lock shop ',
  'Commit shop ',
];
const runId = randomUUID().slice(0, 8);

type Agent = ReturnType<typeof request.agent>;
type Session = { agent: Agent; xsrf: string };
type Method = 'get' | 'post' | 'put' | 'patch';
type Seen = {
  pathname: string;
  params: Record<string, string>;
  authorization: string | undefined;
  raw: string;
};

const logs: string[] = [];
const bodies: string[] = [];
const shop = {
  requests: [] as Seen[],
  status: new Map<string, number>(),
  hold: null as Promise<void> | null,
  /** Holds the next `orders?display=full` request, the poll's page read. */
  holdFull: null as Promise<void> | null,
  heldFull: false,
};
const printShop = { status: null as number | null, requests: 0 };
let releaseHold: () => void = () => undefined;
let releaseFull: () => void = () => undefined;
let sequence = 0;
let app: INestApplication | undefined;
let origin = '';
let closeShop: (() => Promise<void>) | undefined;
let closePrint: (() => Promise<void>) | undefined;
let storageRoot = '';
let mockRoot = '';
let companyA = '';
let companyB = '';
let shopifyStoreId = '';
let brandId = '';
let locationId = '';
let storeId = '';
let connectionId = '';
let admin: Session;
let adminB: Session;
let ops: Session;
let finance: Session;
let syncToken = '';
let template: PrestashopOrderPayload;
const resources = loadResources();

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
  PRINTNODE_BASE_URL: process.env.PRINTNODE_BASE_URL,
  THROTTLE_ENABLED_IN_TEST: process.env.THROTTLE_ENABLED_IN_TEST,
};

describe('integration settings', () => {
  beforeAll(async () => {
    const refusal = assertTestDatabaseUrls();
    if (refusal) {
      throw new Error(refusal);
    }
    await assertEnvConnectionsTargetTestDatabase();
    seedDatabase();
    const fake = await startFake(handleShop);
    origin = fake.origin;
    closeShop = fake.close;
    const printing = await startFake(handlePrint);
    closePrint = printing.close;
    template = await loadTemplate(origin);
    storageRoot = mkdtempSync(join(tmpdir(), 'bp-r1b-store-'));
    mockRoot = mkdtempSync(join(tmpdir(), 'bp-r1b-print-'));
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
    process.env.PRINTNODE_BASE_URL = printing.origin;
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
    runner.drainDeadlineMs = 180_000;
    companyA = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_A } })).id;
    companyB = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_B } })).id;
    await removeSettingsFixtures();
    const seeded = await withCompany(companyA, (tx) =>
      tx.store.findFirstOrThrow({
        where: { companyId: companyA, name: 'Nutbox Demo PrestaShop' },
        select: { brandId: true, locationId: true },
      }),
    );
    brandId = seeded.brandId;
    locationId = seeded.locationId;
    shopifyStoreId = (
      await withCompany(companyA, (tx) =>
        tx.store.findFirstOrThrow({
          where: { companyId: companyA, name: 'Nutbox Demo Shopify' },
          select: { id: true },
        }),
      )
    ).id;
    admin = await login(app, 'admin.a@example.test');
    adminB = await login(app, 'admin.b@example.test');
    ops = await login(app, 'ops.a@example.test');
    finance = await login(app, 'finance.a@example.test');
    syncToken = await createToken(['store.sync.trigger'], 'sync');
  }, 120_000);

  afterAll(async () => {
    if (app) {
      started().get(PrestashopConnectionService).hooks = null;
      await removeSettingsFixtures();
      await app.close();
    }
    await closeShop?.();
    await closePrint?.();
    if (storageRoot) {
      rmSync(storageRoot, { recursive: true, force: true });
    }
    if (mockRoot) {
      rmSync(mockRoot, { recursive: true, force: true });
    }
    restoreEnv();
  });

  it('creates and updates a connection without returning the key', async () => {
    storeId = await createStore('Settings shop');
    const created = await call(admin, 'put', connectionUrl(storeId), cid('create'), {
      ...settingsBody(origin),
      key: KEY,
    });
    expect(created.status, text(created)).toBe(200);
    const connection = record(record(created.body).connection);
    connectionId = stringField(connection, 'id');
    expect(connection.status).toBe('paused');
    expect(connection.keySet).toBe(true);
    expect(connection.firstImportLocked).toBe(false);
    expect(JSON.stringify(created.body)).not.toContain(KEY);
    const createdAudits = await audits(cid('create'));
    expect(createdAudits.map((event) => event.action).sort()).toEqual([
      'credential.stored',
      'integration.connection_created',
      'integration.credential_set',
    ]);
    expect(detailFields(createdAudits, 'integration.connection_created')).toEqual([
      'baseUrl',
      'timezone',
      'firstImportFrom',
      'pollIntervalSeconds',
      'key',
    ]);

    const updated = await call(admin, 'put', connectionUrl(storeId), cid('tz'), {
      ...settingsBody(origin),
      timezone: 'Europe/Athens',
    });
    expect(updated.status, text(updated)).toBe(200);
    expect(record(record(updated.body).connection).status).toBe('paused');
    const timezoneAudits = await audits(cid('tz'));
    expect(timezoneAudits.map((event) => event.action)).toEqual(['integration.connection_updated']);
    expect(detailFields(timezoneAudits, 'integration.connection_updated')).toEqual(['timezone']);
    const kept = await liveCredential(connectionId);
    expect(kept.revokedAt).toBeNull();

    const before = await auditCount();
    const same = await call(admin, 'put', connectionUrl(storeId), cid('noop'), {
      ...settingsBody(origin),
      timezone: 'Europe/Athens',
    });
    expect(same.status, text(same)).toBe(200);
    expect(await auditCount()).toBe(before);

    const replaced = await call(admin, 'put', connectionUrl(storeId), cid('replace'), {
      ...settingsBody(origin),
      key: KEY_2,
    });
    expect(replaced.status, text(replaced)).toBe(200);
    const after = record(record(replaced.body).connection);
    expect(after.status).toBe('paused');
    expect(after.lastTestAt).toBeNull();
    expect(after.lastTestResult).toBeNull();
    expect(kept.id).not.toBe(stringField(await credentialRow(connectionId), 'id'));
    expect((await credentialById(kept.id)).revokedAt).not.toBeNull();
    expect((await audits(cid('replace'))).map((event) => event.action).sort()).toEqual([
      'credential.stored',
      'integration.connection_paused',
      'integration.connection_updated',
      'integration.credential_replaced',
    ]);
    expect(pauseReason(await audits(cid('replace')))).toBe('settings_changed');
  });

  it('rejects the wrong company, platform, archive, locked import and missing permission', async () => {
    const foreign = await call(
      adminB,
      'get',
      `/api/c/${companyB}/stores/${storeId}/prestashop-connection`,
      cid('foreign'),
    );
    expect(foreign.status, text(foreign)).toBe(404);
    expect((await auditsFor(cid('foreign'), companyB)).some((event) => event.action === 'authorization.denied')).toBe(
      true,
    );

    const platform = await call(admin, 'put', connectionUrl(shopifyStoreId), cid('platform'), {
      ...settingsBody('https://shop.example.test'),
      key: KEY,
    });
    expect(platform.status, text(platform)).toBe(422);
    expect(errorCode(platform)).toBe('wrong_platform');

    const side = await createStore('Archive shop');
    await call(admin, 'put', connectionUrl(side), cid('archive-create'), {
      ...settingsBody(origin),
      key: KEY,
    });
    const archived = await call(admin, 'patch', `/api/c/${companyA}/stores/${side}`, cid('archive'), {
      archived: true,
    });
    expect(archived.status, text(archived)).toBe(200);
    const refused = await call(admin, 'put', connectionUrl(side), cid('archived-put'), {
      ...settingsBody(origin),
    });
    expect(refused.status, text(refused)).toBe(422);
    expect(errorCode(refused)).toBe('store_archived');
    const readable = await call(admin, 'get', connectionUrl(side), cid('archived-get'));
    expect(readable.status, text(readable)).toBe(200);
    expect(record(readable.body).connection).not.toBeNull();

    await withCompany(companyA, (tx) =>
      tx.storeConnection.update({
        where: { id: connectionId },
        data: { syncCheckpoint: { dateUpd: '2026-06-15 16:45:00' } },
      }),
    );
    const locked = await call(admin, 'put', connectionUrl(storeId), cid('locked'), {
      ...settingsBody(origin),
      timezone: 'Europe/Athens',
      firstImportFrom: '2026-02-01 00:00:00',
    });
    expect(locked.status, text(locked)).toBe(422);
    expect(errorCode(locked)).toBe('first_import_locked');
    const sameImport = await call(admin, 'put', connectionUrl(storeId), cid('same-import'), {
      ...settingsBody(origin),
      timezone: 'Europe/Athens',
    });
    expect(sameImport.status, text(sameImport)).toBe(200);
    await withCompany(companyA, (tx) =>
      tx.storeConnection.update({
        where: { id: connectionId },
        data: { syncCheckpoint: Prisma.DbNull },
      }),
    );

    const financeGet = await call(finance, 'get', connectionUrl(storeId), cid('fin-get'));
    const financePut = await call(finance, 'put', connectionUrl(storeId), cid('fin-put'), {
      ...settingsBody(origin),
      timezone: 'Europe/Athens',
    });
    expect(financeGet.status).toBe(403);
    expect(financePut.status).toBe(403);
    expect((await audits(cid('fin-get'))).some((event) => event.action === 'authorization.denied')).toBe(true);
    expect((await audits(cid('fin-put'))).some((event) => event.action === 'authorization.denied')).toBe(true);
    const opsGet = await call(ops, 'get', connectionUrl(storeId), cid('ops-get'));
    const opsPut = await call(ops, 'put', connectionUrl(storeId), cid('ops-put'), {
      ...settingsBody(origin),
      timezone: 'Europe/Athens',
    });
    expect(opsGet.status, text(opsGet)).toBe(200);
    expect(opsPut.status).toBe(403);
    expect((await audits(cid('ops-put'))).some((event) => event.action === 'authorization.denied')).toBe(true);
  });

  it('tests the shop, saves maps and the poller uses them', async () => {
    shop.requests = [];
    const tested = await call(admin, 'post', `${connectionUrl(storeId)}/test`, cid('test-ok'), {});
    expect(tested.status, text(tested)).toBe(200);
    expect(tested.body).toEqual({ ok: true });
    expect((await connectionRow()).lastTestResult).toBe('ok');
    expect(shop.requests.map((entry) => entry.pathname)).toEqual([
      '/api/orders',
      '/api/customers',
      '/api/addresses',
      '/api/countries',
      '/api/carriers',
      '/api/order_states',
      '/api/currencies',
    ]);
    expect(basicUser(shop.requests[0]?.authorization)).toBe(KEY_2);

    const carriers = await call(admin, 'get', `${connectionUrl(storeId)}/carriers`, cid('carriers'));
    expect(carriers.status, text(carriers)).toBe(200);
    const carrierRows = carriers.body as { idReference: string; name: string }[];
    expect(carrierRows.find((row) => row.idReference === '9')?.name).toBe('Demo international post');
    expect(carrierRows.find((row) => row.idReference === '4')?.name).toBe('Ten');
    expect(carrierRows.some((row) => row.name === 'Deleted higher id')).toBe(false);
    const states = await call(admin, 'get', `${connectionUrl(storeId)}/order-states`, cid('states'));
    expect(states.status, text(states)).toBe(200);
    const stateRows = states.body as { id: string; name: string }[];
    expect(stateRows.find((row) => row.id === '2')?.name).toBe('Paid demo');

    const badPayment = await call(admin, 'put', `${connectionUrl(storeId)}/maps`, cid('bad-map'), {
      stateMap: { '2': { payment: 'not-a-status', cancelled: false } },
      carrierMap: {},
    });
    expect(badPayment.status).toBe(400);
    const badKey = await call(admin, 'put', `${connectionUrl(storeId)}/maps`, cid('bad-key'), {
      stateMap: { abc: { payment: 'paid', cancelled: false } },
      carrierMap: {},
    });
    expect(badKey.status).toBe(400);
    const mapped = await call(admin, 'put', `${connectionUrl(storeId)}/maps`, cid('maps'), {
      stateMap: { '2': { payment: 'authorized', cancelled: false } },
      carrierMap: { '2': 'collection' },
    });
    expect(mapped.status, text(mapped)).toBe(200);
    const mapAudit = await audits(cid('maps'));
    expect(record(mapAudit[0]?.details).states).toBe(1);
    expect(record(mapAudit[0]?.details).carriers).toBe(1);

    const startedSync = await call(admin, 'post', `${connectionUrl(storeId)}/activate`, cid('activate'), {});
    expect(startedSync.status, text(startedSync)).toBe(200);
    expect(record(record(startedSync.body).connection).status).toBe('active');
    const again = await call(admin, 'post', `${connectionUrl(storeId)}/activate`, cid('activate-again'), {});
    expect(again.status, text(again)).toBe(200);
    expect(await audits(cid('activate-again'))).toEqual([]);

    shop.requests = [];
    await enqueuePoll('mapped');
    await drain();
    const imported = await withCompany(companyA, (tx) =>
      tx.salesOrder.findFirstOrThrow({
        where: { companyId: companyA, connectionId, externalId: '501' },
      }),
    );
    expect(imported.paymentStatus).toBe('authorized');
    expect(imported.deliveryMethod).toBe('collection');
    const full = shop.requests.find((entry) => entry.pathname === '/api/orders' && entry.params.display === 'full');
    expect(basicUser(full?.authorization)).toBe(KEY_2);

    shop.requests = [];
    const rotated = await call(admin, 'put', connectionUrl(storeId), cid('rotate'), {
      ...settingsBody(origin),
      timezone: 'Europe/Athens',
      key: KEY,
    });
    expect(rotated.status, text(rotated)).toBe(200);
    expect(record(record(rotated.body).connection).status).toBe('paused');
    const retest = await call(admin, 'post', `${connectionUrl(storeId)}/test`, cid('retest'), {});
    expect(retest.status, text(retest)).toBe(200);
    expect(basicUser(shop.requests[0]?.authorization)).toBe(KEY);
    await call(admin, 'post', `${connectionUrl(storeId)}/activate`, cid('reactivate'), {});
    shop.requests = [];
    await enqueuePoll('rotated');
    await drain();
    const rotatedRead = shop.requests.find(
      (entry) => entry.pathname === '/api/orders' && entry.params.display === 'full',
    );
    expect(basicUser(rotatedRead?.authorization)).toBe(KEY);
  });

  it('re-enqueues received rows and skips a paused or archived store', async () => {
    const payloads = Array.from({ length: 100 }, (_item, index) => {
      const id = String(8000 + index);
      const payload = structuredClone(template);
      payload.order.id = id;
      payload.order.reference = `DEMO${id}`;
      return payload;
    });
    await withCompany(companyA, (tx) =>
      tx.integrationInbox.createMany({
        data: payloads.map((payload) => ({
          companyId: companyA,
          connectionId,
          provider: 'prestashop',
          externalEventId: `order:${payload.order.id}:${payload.order.date_upd}`,
          topic: 'orders/updated',
          externalObjectId: payload.order.id,
          sourceUpdatedAt: wallTimeInZoneToInstant(payload.order.date_upd, ZONE),
          payload,
          status: 'received',
        })),
      }),
    );
    const received = await withCompany(companyA, (tx) =>
      tx.integrationInbox.findMany({
        where: { companyId: companyA, connectionId, status: 'received' },
        select: { id: true },
      }),
    );
    expect(received.length).toBeGreaterThanOrEqual(100);
    await started()
      .get(PrismaService)
      .client.job.createMany({
        data: received.map((row) => ({
          companyId: companyA,
          type: 'inbox.process',
          payload: { inboxId: row.id, serviceIdentityId: null, actorLabel: null },
          status: 'succeeded' as const,
          attempts: 1,
          maxAttempts: 5,
          correlationId: cid('spent'),
          idempotencyKey: `inbox:${row.id}`,
          finishedAt: new Date(),
        })),
      });
    await withCompany(companyA, (tx) =>
      tx.storeConnection.update({
        where: { id: connectionId },
        data: { status: 'auth_failed', lastTestResult: 'ok' },
      }),
    );
    const activated = await call(admin, 'post', `${connectionUrl(storeId)}/activate`, cid('requeue'), {});
    expect(activated.status, text(activated)).toBe(200);
    expect(record((await audits(cid('requeue')))[0]?.details).requeued).toBe(received.length);
    await drain();
    const processed = await withCompany(companyA, (tx) =>
      tx.integrationInbox.count({
        where: { companyId: companyA, connectionId, externalObjectId: { in: payloads.map((item) => item.order.id) }, status: 'processed' },
      }),
    );
    expect(processed).toBe(100);

    const paused = await call(admin, 'post', `${connectionUrl(storeId)}/pause`, cid('pause'), {});
    expect(paused.status, text(paused)).toBe(200);
    expect(pauseReason(await audits(cid('pause')))).toBe('manual');
    const pauseAgain = await call(admin, 'post', `${connectionUrl(storeId)}/pause`, cid('pause-again'), {});
    expect(pauseAgain.status).toBe(200);
    expect(await audits(cid('pause-again'))).toEqual([]);
    const skipped = await callSync(cid('skip-paused'));
    expect(skipped.status, text(skipped)).toBe(202);
    expect(counts(skipped).skipped).toBe(await skippedConnections());
    expect(await pollJobs(connectionId)).toBe(0);

    await call(admin, 'post', `${connectionUrl(storeId)}/activate`, cid('resume'), {});
    await call(admin, 'patch', `/api/c/${companyA}/stores/${storeId}`, cid('archive-main'), { archived: true });
    expect((await connectionRow()).status).toBe('active');
    const archivedSkip = await callSync(cid('skip-archived'));
    expect(archivedSkip.status, text(archivedSkip)).toBe(202);
    expect(counts(archivedSkip).skipped).toBe(await skippedConnections());
    expect(await pollJobs(connectionId)).toBe(0);
    await call(admin, 'patch', `/api/c/${companyA}/stores/${storeId}`, cid('restore-main'), { archived: false });
  }, 120_000);

  it('stops a running poll when the connection is paused or its key replaced', async () => {
    await withCompany(companyA, (tx) =>
      tx.storeConnection.update({
        where: { id: connectionId },
        data: { status: 'active', lastTestResult: 'ok', syncCheckpoint: Prisma.DbNull },
      }),
    );
    const inboxBefore = await inboxTotals();
    const rowBefore = await connectionRow();

    holdNextPage();
    await enqueuePoll('pause-mid');
    const pausing = drain();
    await waitFor(() => shop.heldFull);
    const paused = await call(admin, 'post', `${connectionUrl(storeId)}/pause`, cid('pause-mid-api'), {});
    expect(paused.status, text(paused)).toBe(200);
    releaseFull();
    await pausing;
    expect(await inboxTotals()).toEqual(inboxBefore);
    const afterPause = await connectionRow();
    expect(afterPause.status).toBe('paused');
    expect(afterPause.syncCheckpoint).toBeNull();
    expect(afterPause.lastSyncAt).toEqual(rowBefore.lastSyncAt);
    expect(await pollJobStatus('pause-mid')).toBe('succeeded');

    const resumed = await call(admin, 'post', `${connectionUrl(storeId)}/activate`, cid('pause-mid-resume'), {});
    expect(record(record(resumed.body).connection).status).toBe('active');
    const errorBefore = (await connectionRow()).lastErrorClass;
    holdNextPage();
    await enqueuePoll('swap-mid');
    const swapping = drain();
    await waitFor(() => shop.heldFull);
    const swapped = await call(admin, 'put', connectionUrl(storeId), cid('swap-mid-api'), {
      ...settingsBody(origin),
      timezone: 'Europe/Athens',
      key: KEY_2,
    });
    expect(swapped.status, text(swapped)).toBe(200);
    shop.status.set('orders', 401);
    releaseFull();
    await swapping;
    shop.status.clear();
    const afterSwap = await connectionRow();
    expect(afterSwap.status).toBe('paused');
    expect(afterSwap.lastErrorClass).toBe(errorBefore);
    const pollAudits = await audits(cid('swap-mid'));
    expect(pollAudits.map((event) => event.action)).not.toContain('store.connection_paused');
    expect(pollAudits.map((event) => event.action)).not.toContain('store.sync_failed');
    expect(await pollJobStatus('swap-mid')).toBe('succeeded');

    shop.requests = [];
    const retested = await call(admin, 'post', `${connectionUrl(storeId)}/test`, cid('swap-mid-test'), {});
    expect(retested.body).toEqual({ ok: true });
    expect(basicUser(shop.requests[0]?.authorization)).toBe(KEY_2);
    const restarted = await call(admin, 'post', `${connectionUrl(storeId)}/activate`, cid('swap-mid-start'), {});
    expect(record(record(restarted.body).connection).status).toBe('active');
  }, 120_000);

  it('leaves a replaced connection alone when opening the old key fails', async () => {
    const before = await connectionRow();
    expect(before.status).toBe('active');
    const vault = started().get(CredentialVault);
    const original = vault.decrypt.bind(vault);
    let swapped = false;
    // Between the poll's row read and its decrypt, the owner replaces the key; then the
    // decrypt of the old key fails.
    vault.decrypt = async (companyId: string, credentialId: string) => {
      if (!swapped) {
        swapped = true;
        const replaced = await call(admin, 'put', connectionUrl(storeId), cid('open-swap-api'), {
          ...settingsBody(origin),
          timezone: 'Europe/Athens',
          key: KEY,
        });
        expect(replaced.status, text(replaced)).toBe(200);
        throw new Error('decrypt failed');
      }
      return original(companyId, credentialId);
    };
    try {
      await enqueuePoll('open-swap');
      await drain();
    } finally {
      vault.decrypt = original;
    }
    expect(swapped).toBe(true);
    const after = await connectionRow();
    expect(after.status).toBe('paused');
    expect(after.lastErrorClass).toBe(before.lastErrorClass);
    expect(after.lastErrorAt).toEqual(before.lastErrorAt);
    expect(await pollJobStatus('open-swap')).toBe('succeeded');
  });

  it('records success when stored settings hold a number JavaScript would round', async () => {
    await withCompany(companyA, (tx) => tx.$executeRaw`
      UPDATE store_connection
      SET status = 'active',
          settings = jsonb_set(settings, '{pollIntervalSeconds}', '180.0000000000000000001'::jsonb)
      WHERE id = ${connectionId}::uuid
    `);
    const before = await connectionRow();
    await enqueuePoll('exact-number');
    await drain();
    const after = await connectionRow();
    expect(await pollJobStatus('exact-number')).toBe('succeeded');
    expect(after.lastSyncAt).not.toBeNull();
    expect(after.lastSyncAt?.getTime()).toBeGreaterThan(before.lastSyncAt?.getTime() ?? 0);
    await withCompany(companyA, (tx) => tx.$executeRaw`
      UPDATE store_connection
      SET settings = jsonb_set(settings, '{pollIntervalSeconds}', '180'::jsonb)
      WHERE id = ${connectionId}::uuid
    `);
  });

  it('revokes the new key when the commit itself fails', async () => {
    const fresh = await createStore('Commit shop');
    const created = await call(admin, 'put', connectionUrl(fresh), cid('commit-create'), {
      ...settingsBody(origin),
      key: KEY,
    });
    expect(created.status, text(created)).toBe(200);
    const before = await withCompany(companyA, (tx) =>
      tx.storeConnection.findFirstOrThrow({ where: { companyId: companyA, storeId: fresh, mode: 'live' } }),
    );
    const service = started().get(PrestashopConnectionService);
    const tenants: unknown = Reflect.get(service, 'tenants');
    if (!(tenants instanceof TenantDb)) {
      throw new Error('missing tenants');
    }
    // A one-second transaction timeout and a hook that outlasts it: the callback returns,
    // then Prisma's commit fails because the transaction has already been rolled back.
    Reflect.set(service, 'tenants', {
      run: <T>(context: Parameters<TenantDb['run']>[0], fn: (tx: TenantTransaction) => Promise<T>) =>
        tenants.run(context, fn, { timeoutMs: 1_000 }),
    });
    service.hooks = { beforeCommit: () => new Promise((resolveWait) => setTimeout(resolveWait, 1_500)) };
    try {
      const failed = await call(admin, 'put', connectionUrl(fresh), cid('commit-fail'), {
        ...settingsBody(origin),
        key: KEY_2,
      });
      expect(failed.status).toBe(500);
    } finally {
      service.hooks = null;
      Reflect.set(service, 'tenants', tenants);
    }
    const after = await withCompany(companyA, (tx) =>
      tx.storeConnection.findFirstOrThrow({ where: { id: before.id } }),
    );
    expect(after.credentialId).toBe(before.credentialId);
    expect(after.status).toBe(before.status);
    const stranded = await withCompany(companyA, (tx) =>
      tx.integrationCredential.findMany({
        where: { companyId: companyA, provider: 'prestashop', revokedAt: null, connections: { none: {} } },
      }),
    );
    expect(stranded).toEqual([]);
  });

  it('refuses a first-import change when a poll commits the first checkpoint meanwhile', async () => {
    const fresh = await createStore('Lock shop');
    const created = await call(admin, 'put', connectionUrl(fresh), cid('lock-create'), {
      ...settingsBody(origin),
      key: KEY,
    });
    const lockedId = stringField(record(record(created.body).connection), 'id');
    let commitPoll: () => void = () => undefined;
    const pollHeld = new Promise<void>((resolveHold) => {
      commitPoll = resolveHold;
    });
    let pollLocked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolveLock) => {
      pollLocked = resolveLock;
    });
    // The poller's checkpoint write: lock the connection, write the checkpoint, commit later.
    const poll = started()
      .get(PrismaService)
      .client.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.company_id', ${companyA}, true)`;
          await tx.$queryRaw`SELECT id FROM store_connection WHERE id = ${lockedId}::uuid FOR UPDATE`;
          await tx.$executeRaw`
            UPDATE store_connection SET sync_checkpoint = '{"dateUpd":"2026-03-01 10:00:00"}'::jsonb
            WHERE id = ${lockedId}::uuid
          `;
          pollLocked();
          await pollHeld;
        },
        { timeout: 20_000 },
      );
    await lockTaken;
    const pending = call(admin, 'put', connectionUrl(fresh), cid('lock-put'), {
      ...settingsBody(origin),
      firstImportFrom: '2026-02-01 00:00:00',
    });
    await waitForLockWait();
    commitPoll();
    await poll;
    const refused = await pending;
    expect(refused.status, text(refused)).toBe(422);
    expect(errorCode(refused)).toBe('first_import_locked');
    const row = await withCompany(companyA, (tx) => tx.storeConnection.findFirstOrThrow({ where: { id: lockedId } }));
    expect(record(row.settings).firstImportFrom).toBe('2026-01-01 00:00:00');
  });

  it('keeps one connection, revokes a failed key and does not record a raced test', async () => {
    const fresh = await createStore('Concurrent shop');
    const [first, second] = await Promise.all([
      call(admin, 'put', connectionUrl(fresh), cid('race-a'), { ...settingsBody(origin), key: KEY }),
      call(admin, 'put', connectionUrl(fresh), cid('race-b'), { ...settingsBody(origin), key: KEY_2 }),
    ]);
    expect(first.status, text(first)).toBe(200);
    expect(second.status, text(second)).toBe(200);
    const rows = await withCompany(companyA, (tx) =>
      tx.storeConnection.findMany({ where: { companyId: companyA, storeId: fresh, mode: 'live' } }),
    );
    expect(rows).toHaveLength(1);
    const live = await withCompany(companyA, (tx) =>
      tx.integrationCredential.findMany({
        where: { companyId: companyA, provider: 'prestashop', revokedAt: null, connections: { some: { storeId: fresh } } },
      }),
    );
    expect(live).toHaveLength(1);
    expect(rows[0]?.credentialId).toBe(live[0]?.id);

    const service = started().get(PrestashopConnectionService);
    const before = await withCompany(companyA, (tx) =>
      tx.storeConnection.findFirstOrThrow({ where: { id: rows[0]?.id } }),
    );
    service.hooks = {
      beforeCommit: () => Promise.reject(new Error('stop-before-commit')),
    };
    const failed = await call(admin, 'put', connectionUrl(fresh), cid('hook'), {
      ...settingsBody(origin),
      key: KEY,
    });
    service.hooks = null;
    expect(failed.status).toBe(500);
    const after = await withCompany(companyA, (tx) =>
      tx.storeConnection.findFirstOrThrow({ where: { id: before.id } }),
    );
    expect(after.credentialId).toBe(before.credentialId);
    expect(after.settings).toEqual(before.settings);
    expect((await credentialById(before.credentialId ?? '')).revokedAt).toBeNull();
    const stranded = await withCompany(companyA, (tx) =>
      tx.integrationCredential.findMany({
        where: {
          companyId: companyA,
          provider: 'prestashop',
          revokedAt: null,
          connections: { none: {} },
        },
      }),
    );
    expect(stranded).toEqual([]);

    const probeStore = await createStore('Probe shop');
    await call(admin, 'put', connectionUrl(probeStore), cid('probe-create'), {
      ...settingsBody(origin),
      key: KEY,
    });
    shop.status.set('customers', 401);
    const unauthorised = await call(admin, 'post', `${connectionUrl(probeStore)}/test`, cid('probe-401'), {});
    shop.status.clear();
    expect(unauthorised.status, text(unauthorised)).toBe(200);
    expect(unauthorised.body).toEqual({ ok: false, errorClass: 'auth_failed', resource: 'customers' });

    shop.status.set('orders', 404);
    const missing = await call(admin, 'post', `${connectionUrl(probeStore)}/test`, cid('probe-404'), {});
    shop.status.clear();
    expect(missing.body).toEqual({ ok: false, errorClass: 'not_found', resource: 'orders' });

    const blockedStore = await createStore('Blocked shop');
    await call(admin, 'put', connectionUrl(blockedStore), cid('blocked-create'), {
      ...settingsBody('https://10.0.0.1'),
      key: KEY,
    });
    const blocked = await call(admin, 'post', `${connectionUrl(blockedStore)}/test`, cid('blocked'), {});
    expect(blocked.status, text(blocked)).toBe(200);
    expect(blocked.body).toEqual({ ok: false, errorClass: 'blocked_destination', resource: 'orders' });

    const raceStore = await createStore('Race shop');
    const saved = await call(admin, 'put', connectionUrl(raceStore), cid('race-create'), {
      ...settingsBody(origin),
      key: KEY,
    });
    const racedId = stringField(record(record(saved.body).connection), 'id');
    const seenBefore = shop.requests.length;
    holdNext();
    const pending = call(admin, 'post', `${connectionUrl(raceStore)}/test`, cid('race-test'), {});
    await waitFor(() => shop.requests.length > seenBefore);
    const swapped = await call(admin, 'put', connectionUrl(raceStore), cid('race-swap'), {
      ...settingsBody(origin),
      key: KEY_2,
    });
    expect(swapped.status, text(swapped)).toBe(200);
    releaseHold();
    const raced = await pending;
    expect(raced.status, text(raced)).toBe(200);
    const racedRow = await withCompany(companyA, (tx) =>
      tx.storeConnection.findFirstOrThrow({ where: { id: racedId } }),
    );
    expect(racedRow.lastTestAt).toBeNull();
    expect(racedRow.lastTestResult).toBeNull();
  });

  it('stores and tests a PrintNode key without returning it from the read', async () => {
    const before = await call(adminB, 'get', `/api/c/${companyB}/print-accounts/printnode`, cid('pn-b-before'));
    expect(before.status, text(before)).toBe(200);
    const saved = await call(admin, 'put', `/api/c/${companyA}/print-accounts/printnode`, cid('pn-put'), {
      key: PRINT_KEY,
    });
    expect(saved.status, text(saved)).toBe(200);
    expect(saved.body).toMatchObject({ keySet: true });
    expect(JSON.stringify(saved.body)).not.toContain(PRINT_KEY);
    expect(JSON.stringify(saved.body)).not.toContain('email');
    const read = await call(admin, 'get', `/api/c/${companyA}/print-accounts/printnode`, cid('pn-get'));
    expect(read.body).toEqual(saved.body);
    const replaced = await call(admin, 'put', `/api/c/${companyA}/print-accounts/printnode`, cid('pn-replace'), {
      key: PRINT_KEY_2,
    });
    expect(replaced.status, text(replaced)).toBe(200);
    const live = await withCompany(companyA, (tx) =>
      tx.integrationCredential.findMany({
        where: { companyId: companyA, provider: 'printnode', label: 'api_key', revokedAt: null },
      }),
    );
    expect(live).toHaveLength(1);
    const tested = await call(admin, 'post', `/api/c/${companyA}/print-accounts/printnode/test`, cid('pn-test'), {});
    expect(tested.status, text(tested)).toBe(200);
    expect(tested.body).toEqual({ ok: true, email: 'print.owner@example.test' });
    const testAudit = (await audits(cid('pn-test'))).find((event) => event.action === 'integration.connection_tested');
    expect(record(testAudit?.details)).toEqual({ result: 'ok' });
    expect(testAudit?.objectType).toBe('integration_credential');
    printShop.status = 401;
    const denied = await call(admin, 'post', `/api/c/${companyA}/print-accounts/printnode/test`, cid('pn-401'), {});
    printShop.status = null;
    expect(denied.body).toEqual({ ok: false, errorClass: 'auth_failed' });
    printShop.status = 404;
    const missing = await call(admin, 'post', `/api/c/${companyA}/print-accounts/printnode/test`, cid('pn-404'), {});
    printShop.status = 500;
    const broken = await call(admin, 'post', `/api/c/${companyA}/print-accounts/printnode/test`, cid('pn-500'), {});
    printShop.status = null;
    expect(missing.body).toEqual({ ok: false, errorClass: 'not_found' });
    expect(broken.body).toEqual({ ok: false, errorClass: 'bad_response' });
    const foreign = await call(adminB, 'get', `/api/c/${companyA}/print-accounts/printnode`, cid('pn-foreign'));
    expect(foreign.status).toBe(404);
    const after = await call(adminB, 'get', `/api/c/${companyB}/print-accounts/printnode`, cid('pn-b-after'));
    expect(after.body).toEqual(before.body);
    expect(JSON.stringify(after.body)).not.toContain(PRINT_KEY_2);

    const service = started().get(PrintNodeAccountService);
    service.hooks = { beforeCommit: () => Promise.reject(new Error('stop-before-commit')) };
    const failed = await call(admin, 'put', `/api/c/${companyA}/print-accounts/printnode`, cid('pn-hook'), {
      key: PRINT_KEY,
    });
    service.hooks = null;
    expect(failed.status).toBe(500);
    const still = await withCompany(companyA, (tx) =>
      tx.integrationCredential.findMany({
        where: { companyId: companyA, provider: 'printnode', label: 'api_key', revokedAt: null },
      }),
    );
    expect(still.map((row) => row.id)).toEqual(live.map((row) => row.id));
  });

  it('keeps the key out of logs, responses and audit details', async () => {
    const joined = logs.join('\n');
    for (const mark of SECRET_MARKS) {
      expect(joined).not.toContain(mark);
    }
    for (const body of bodies) {
      for (const mark of SECRET_MARKS) {
        expect(body).not.toContain(mark);
      }
    }
    const events = [
      ...(await auditIntegration(companyA)),
      ...(await auditIntegration(companyB)),
    ];
    for (const event of events) {
      const details = JSON.stringify(event.details);
      for (const mark of SECRET_MARKS) {
        expect(details, event.action).not.toContain(mark);
      }
    }
  });
});

function settingsBody(baseUrl: string) {
  return {
    baseUrl,
    timezone: 'Asia/Nicosia',
    firstImportFrom: '2026-01-01 00:00:00',
    pollIntervalSeconds: 180,
  };
}

function connectionUrl(id: string): string {
  return `/api/c/${companyA}/stores/${id}/prestashop-connection`;
}

async function createStore(name: string): Promise<string> {
  const response = await call(admin, 'post', `/api/c/${companyA}/stores`, cid(`store-${name}`), {
    name: `${name} ${runId}`,
    platform: 'prestashop',
    brandId,
    locationId,
  });
  expect(response.status, text(response)).toBe(200);
  return stringField(record(record(response.body).store), 'id');
}

async function connectionRow() {
  return withCompany(companyA, (tx) => tx.storeConnection.findFirstOrThrow({ where: { id: connectionId } }));
}

async function liveCredential(id: string) {
  const row = await credentialRow(id);
  return credentialById(row.id);
}

async function credentialRow(id: string) {
  const connection = await withCompany(companyA, (tx) =>
    tx.storeConnection.findFirstOrThrow({
      where: { id },
      select: { credential: { select: { id: true, revokedAt: true } } },
    }),
  );
  if (!connection.credential) {
    throw new Error('missing credential');
  }
  return connection.credential;
}

function credentialById(id: string) {
  return withCompany(companyA, (tx) => tx.integrationCredential.findFirstOrThrow({ where: { id } }));
}

async function skippedConnections(): Promise<number> {
  const rows = await withCompany(companyA, (tx) => tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM store_connection c
    JOIN store s ON s.id = c.store_id AND s.company_id = c.company_id
    WHERE c.company_id = ${companyA}::uuid
      AND s.platform = 'prestashop'::"store_platform"
      AND (s.status = 'archived' OR c.status <> 'active')
  `);
  return rows[0]?.n ?? 0;
}

async function inboxTotals(): Promise<{ rows: number; duplicates: number }> {
  const rows = await withCompany(companyA, (tx) => tx.$queryRaw<{ rows: number; duplicates: number }[]>`
    SELECT count(*)::int AS rows, coalesce(sum(duplicate_count), 0)::int AS duplicates
    FROM integration_inbox
    WHERE company_id = ${companyA}::uuid AND connection_id = ${connectionId}::uuid
  `);
  return rows[0] ?? { rows: 0, duplicates: 0 };
}

async function pollJobStatus(name: string): Promise<string | undefined> {
  const job = await started()
    .get(PrismaService)
    .client.job.findFirst({
      where: { type: 'prestashop.poll', correlationId: cid(name) },
      select: { status: true },
    });
  return job?.status;
}

/** Waits until some backend is blocked on a row lock. */
async function waitForLockWait(): Promise<void> {
  const prisma = started().get(PrismaService).client;
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted
    `;
    if ((rows[0]?.n ?? 0) > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for a lock wait');
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

async function pollJobs(id: string): Promise<number> {
  return started()
    .get(PrismaService)
    .client.job.count({
      where: { type: 'prestashop.poll', status: 'queued', payload: { path: ['connectionId'], equals: id } },
    });
}

async function enqueuePoll(name: string): Promise<void> {
  sequence += 1;
  await started()
    .get(PrismaService)
    .client.job.create({
      data: {
        id: randomUUID(),
        companyId: companyA,
        type: 'prestashop.poll',
        payload: { connectionId },
        status: 'queued',
        attempts: 0,
        maxAttempts: 1,
        timeoutMs: 240_000,
        runAfter: new Date(),
        correlationId: cid(name),
        idempotencyKey: `prestashop.poll:${connectionId}:settings:${name}:${runId}:${String(sequence)}`,
      },
    });
}

async function drain(): Promise<void> {
  await withCompany(companyA, (tx) => tx.$executeRaw`
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
  `);
  const runner = started().get(JobRunner);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await runner.drainOnce();
    if (result.processed === 0) {
      return;
    }
  }
  throw new Error('drain did not finish');
}

async function loadTemplate(baseUrl: string): Promise<PrestashopOrderPayload> {
  const client = createPrestashopClient({
    fetch: createSafeFetch({ appEnv: 'test', allowLoopbackForTests: true }),
    baseUrl,
    apiKey: KEY,
  });
  const orders = await client.listOrdersUpdatedBetween({
    from: '2026-01-01 00:00:00',
    to: '2026-12-31 23:59:59',
    offset: 0,
    limit: 5,
  });
  const order = orders[0];
  if (!order) {
    throw new Error('fixture order missing');
  }
  const addresses = await client.getAddresses([order.id_address_delivery, order.id_address_invoice]);
  return buildPrestashopOrderPayload(order, {
    customers: await client.getCustomers([order.id_customer]),
    addresses,
    countries: await client.getCountries(addresses.map((address) => address.id_country)),
    carriers: await client.getCarriers([order.id_carrier]),
    currencies: await client.getCurrencies([order.id_currency]),
    states: await client.getOrderStates(),
  });
}

function holdNextPage(): void {
  shop.heldFull = false;
  shop.holdFull = new Promise((resolveHold) => {
    releaseFull = () => {
      releaseFull = () => undefined;
      resolveHold();
    };
  });
}

function holdNext(): void {
  shop.hold = new Promise((resolveHold) => {
    releaseHold = () => {
      releaseHold = () => undefined;
      resolveHold();
    };
  });
}

async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the shop');
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

function basicUser(header: string | undefined): string {
  const encoded = header?.replace(/^Basic /i, '') ?? '';
  return Buffer.from(encoded, 'base64').toString('utf8').replace(/:$/, '');
}

function detailFields(
  events: { action: string; details: unknown }[],
  action: string,
): unknown {
  return record(events.find((event) => event.action === action)?.details).fields;
}

function pauseReason(events: { action: string; details: unknown }[]): unknown {
  return record(events.find((event) => event.action === 'integration.connection_paused')?.details).reason;
}

async function auditCount(): Promise<number> {
  const rows = await withPlatform(companyA, (tx) =>
    tx.auditEvent.count({ where: { companyId: companyA, action: { startsWith: 'integration.' } } }),
  );
  return rows;
}

function audits(correlationId: string) {
  return auditsFor(correlationId, companyA);
}

function auditsFor(correlationId: string, companyId: string) {
  return withPlatform(companyId, (tx) =>
    tx.auditEvent.findMany({
      where: { correlationId, companyId },
      orderBy: { occurredAt: 'asc' },
      select: { action: true, details: true, outcome: true, objectType: true },
    }),
  );
}

function auditIntegration(companyId: string) {
  return withPlatform(companyId, (tx) =>
    tx.auditEvent.findMany({
      where: { companyId, action: { startsWith: 'integration.' } },
      select: { details: true, action: true },
    }),
  );
}

function withPlatform<T>(companyId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return started()
    .get(PrismaService)
    .client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform_scope', 'on', true)`;
      await tx.$executeRaw`SELECT set_config('app.company_id', ${companyId}, true)`;
      return fn(tx);
    });
}

async function removeSettingsFixtures(): Promise<void> {
  if (!companyA) {
    return;
  }
  await withCompany(companyA, async (tx) => {
    const stores = await tx.store.findMany({
      where: {
        companyId: companyA,
        OR: FIXTURE_STORE_PREFIXES.map((prefix) => ({ name: { startsWith: prefix } })),
      },
      select: { id: true },
    });
    const storeIds = stores.map((row) => row.id);
    if (storeIds.length > 0) {
      const orders = await tx.salesOrder.findMany({
        where: { companyId: companyA, storeId: { in: storeIds } },
        select: { id: true },
      });
      const orderIds = orders.map((row) => row.id);
      if (orderIds.length > 0) {
        await tx.salesOrderLine.deleteMany({ where: { companyId: companyA, orderId: { in: orderIds } } });
        await tx.orderNote.deleteMany({ where: { companyId: companyA, orderId: { in: orderIds } } });
        await tx.invoice.updateMany({
          where: { companyId: companyA, sourceOrderId: { in: orderIds } },
          data: { sourceOrderId: null },
        });
        await tx.salesOrder.deleteMany({ where: { companyId: companyA, id: { in: orderIds } } });
      }
      const connections = await tx.storeConnection.findMany({
        where: { companyId: companyA, storeId: { in: storeIds } },
        select: { id: true },
      });
      const connectionIds = connections.map((row) => row.id);
      if (connectionIds.length > 0) {
        await tx.integrationInbox.deleteMany({
          where: { companyId: companyA, connectionId: { in: connectionIds } },
        });
        await tx.storeConnection.deleteMany({ where: { companyId: companyA, id: { in: connectionIds } } });
      }
      await tx.store.deleteMany({ where: { companyId: companyA, id: { in: storeIds } } });
    }
    await tx.integrationCredential.deleteMany({
      where: {
        companyId: companyA,
        provider: 'prestashop',
        label: 'webservice_key',
        connections: { none: {} },
      },
    });
    await tx.integrationCredential.updateMany({
      where: { companyId: companyA, provider: 'printnode', label: 'api_key', revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });
  await started()
    .get(PrismaService)
    .client.job.updateMany({
      where: {
        companyId: companyA,
        status: 'queued',
        type: { in: ['prestashop.poll', 'inbox.process'] },
      },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
}

function withCompany<T>(companyId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return new TenantDb(started().get(PrismaService).client).run(
    { companyId, actor: 'settings-test', correlationId: cid('db') },
    fn,
  );
}

async function createToken(permissions: string[], label: string): Promise<string> {
  const response = await call(admin, 'post', `/api/c/${companyA}/service-identities`, cid(`token-${label}`), {
    name: `settings-${label}-${runId}`,
    purpose: 'settings test',
    permissions,
  });
  expect(response.status, text(response)).toBe(200);
  return stringField(record(response.body), 'token');
}

async function callSync(name: string) {
  const response = await request(started().getHttpServer() as App)
    .post(`/api/automation/v1/c/${companyA}/store-sync`)
    .set('Authorization', `Bearer ${syncToken}`)
    .set('X-Correlation-Id', cid(name));
  bodies.push(JSON.stringify(response.body));
  return response;
}

function counts(response: request.Response): { queued: number; notDue: number; skipped: number } {
  const body = record(response.body);
  return {
    queued: numberField(body, 'queued'),
    notDue: numberField(body, 'notDue'),
    skipped: numberField(body, 'skipped'),
  };
}

async function call(
  session: Session,
  method: Method,
  url: string,
  correlationId: string,
  payload?: object,
) {
  const response = await send(session, method, url, correlationId, payload);
  bodies.push(JSON.stringify(response.body));
  return response;
}

function send(session: Session, method: Method, url: string, correlationId: string, payload?: object) {
  const pending = session.agent[method](url).set('X-XSRF-TOKEN', session.xsrf).set('X-Correlation-Id', correlationId);
  if (payload !== undefined) {
    pending.send(payload);
  }
  return pending;
}

async function login(application: INestApplication, email: string): Promise<Session> {
  const agent = request.agent(application.getHttpServer() as App);
  const response = await agent.post('/api/auth/dev/login').send({ email });
  expect(response.status, text(response)).toBe(200);
  return { agent, xsrf: cookieValue(cookieHeader(response, 'XSRF-TOKEN'), 'XSRF-TOKEN') };
}

function cid(name: string): string {
  return `r1b-${name}-${runId}`.slice(0, 64);
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
  return application;
}

function started(): INestApplication {
  if (!app) {
    throw new Error('the API was not started');
  }
  return app;
}

function errorCode(response: request.Response): string {
  return stringField(record(record(response.body).error), 'code');
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
  if (typeof field !== 'string') {
    throw new Error(`missing ${key}`);
  }
  return field;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== 'number') {
    throw new Error(`missing ${key}`);
  }
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

function restoreEnv(): void {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
}

function loadResources(): Map<string, Record<string, unknown>[]> {
  const files: Record<string, string> = {
    orders: 'orders-page-1.json',
    customers: 'customers.json',
    addresses: 'addresses.json',
    countries: 'countries.json',
    carriers: 'carriers.json',
    currencies: 'currencies.json',
    order_states: 'order-states.json',
  };
  const loaded = new Map<string, Record<string, unknown>[]>();
  for (const [name, file] of Object.entries(files)) {
    const parsed: unknown = JSON.parse(readFileSync(resolve(prestashopFixturesDirectory(), file), 'utf8'));
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

async function startFake(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
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
    close: () =>
      new Promise((resolveClose, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolveClose();
          }
        });
      }),
  };
}

async function handleShop(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const seen = capture(req);
  shop.requests.push(seen);
  if (shop.hold && seen.params.display === '[id]') {
    const pending = shop.hold;
    shop.hold = null;
    await pending;
  }
  if (shop.holdFull && seen.pathname === '/api/orders' && seen.params.display === 'full') {
    const pending = shop.holdFull;
    shop.holdFull = null;
    shop.heldFull = true;
    await pending;
  }
  req.resume();
  const name = seen.pathname.replace(/^\/api\//, '');
  const forced = shop.status.get(name);
  if (forced !== undefined) {
    json(res, forced, {});
    return;
  }
  if (seen.params.display === '[id]' && seen.params.limit === '1') {
    json(res, 200, []);
    return;
  }
  if (name === 'carriers' && (seen.params.display ?? '').includes('deleted')) {
    json(res, 200, { carriers: listedCarriers() });
    return;
  }
  if (name === 'orders') {
    const page = filterOrders(resources.get('orders') ?? [], seen.params);
    json(res, 200, page.length === 0 ? [] : { orders: page });
    return;
  }
  const rows = resources.get(name);
  if (!rows) {
    json(res, 404, []);
    return;
  }
  const filtered = filterIds(rows, seen.params['filter[id]']);
  json(res, 200, filtered.length === 0 ? [] : { [name]: filtered });
}

function listedCarriers(): Record<string, unknown>[] {
  const rows = (resources.get('carriers') ?? []).map((row) => ({ ...row, deleted: '0' }));
  return [
    ...rows,
    { id: '99', id_reference: '9', name: 'Deleted higher id', deleted: '1' },
    { id: '9', id_reference: '4', name: 'Nine', deleted: '0' },
    { id: '10', id_reference: '4', name: 'Ten', deleted: '0' },
  ];
}

function handlePrint(req: IncomingMessage, res: ServerResponse): Promise<void> {
  printShop.requests += 1;
  req.resume();
  if (printShop.status !== null) {
    json(res, printShop.status, {});
    return Promise.resolve();
  }
  json(res, 200, { email: 'print.owner@example.test' });
  return Promise.resolve();
}

function filterOrders(
  orders: readonly Record<string, unknown>[],
  params: Record<string, string>,
): Record<string, unknown>[] {
  const match = /^\[(.+),(.+)\]$/.exec(params['filter[date_upd]'] ?? '');
  const from = match?.[1] ?? '';
  const to = match?.[2] ?? '';
  const chosen = orders.filter((order) => {
    const updated = order.date_upd;
    return typeof updated === 'string' && updated >= from && updated <= to;
  });
  const [offsetText, countText] = (params.limit ?? '0,100').split(',');
  const offset = Number(offsetText ?? '0');
  const count = Number(countText ?? '100');
  return chosen.slice(offset, offset + count);
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
  return {
    pathname: url.pathname,
    params,
    authorization: req.headers.authorization,
    raw,
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
