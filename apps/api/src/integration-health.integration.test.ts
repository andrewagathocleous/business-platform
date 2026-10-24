import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { Logger } from 'nestjs-pino';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

const COMPANY_A = 'Demo Company A Ltd (fictional)';
const COMPANY_B = 'Demo Company B Ltd (fictional)';
const KEY = 'FictionalShopKey000000000000H5tV';
const PRINT_KEY = 'FictionalPrintNodeKey000000H2kW';
const PREFIX = 'Health shop ';
const MINUTE = 60 * 1000;
const runId = randomUUID().slice(0, 8);

type Agent = ReturnType<typeof request.agent>;
type Session = { agent: Agent; xsrf: string };
type Method = 'get' | 'post' | 'put' | 'patch';

let app: INestApplication | undefined;
let storageRoot = '';
let mockRoot = '';
let companyA = '';
let companyB = '';
let brandId = '';
let locationId = '';
let admin: Session;
let adminB: Session;
let finance: Session;
const stores: Record<string, string> = {};
const connections: Record<string, string> = {};

const savedEnv = {
  APP_ENV: process.env.APP_ENV,
  AUTH_DEV_LOGIN_ENABLED: process.env.AUTH_DEV_LOGIN_ENABLED,
  SESSION_COOKIE_SECURE: process.env.SESSION_COOKIE_SECURE,
  CSRF_SECRET: process.env.CSRF_SECRET,
  AUTH_REQUIRE_MFA_FOR_PRIVILEGED: process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED,
  APP_MASTER_KEYS: process.env.APP_MASTER_KEYS,
  APP_MASTER_KEY_ACTIVE: process.env.APP_MASTER_KEY_ACTIVE,
  STORAGE_ROOT: process.env.STORAGE_ROOT,
  MOCK_PRINT_ROOT: process.env.MOCK_PRINT_ROOT,
  THROTTLE_ENABLED_IN_TEST: process.env.THROTTLE_ENABLED_IN_TEST,
};

describe('integration health', () => {
  beforeAll(async () => {
    const refusal = assertTestDatabaseUrls();
    if (refusal) {
      throw new Error(refusal);
    }
    await assertEnvConnectionsTargetTestDatabase();
    seedDatabase();
    storageRoot = mkdtempSync(join(tmpdir(), 'bp-r1e-store-'));
    mockRoot = mkdtempSync(join(tmpdir(), 'bp-r1e-print-'));
    process.env.APP_ENV = 'test';
    process.env.AUTH_DEV_LOGIN_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECURE = 'false';
    process.env.CSRF_SECRET = 'integration-test-csrf-secret';
    process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED = 'false';
    process.env.APP_MASTER_KEYS = JSON.stringify({ k1: Buffer.alloc(32, 7).toString('base64') });
    process.env.APP_MASTER_KEY_ACTIVE = 'k1';
    process.env.STORAGE_ROOT = storageRoot;
    process.env.MOCK_PRINT_ROOT = mockRoot;
    delete process.env.THROTTLE_ENABLED_IN_TEST;
    app = await bootApp();
    const prisma = app.get(PrismaService);
    const databases = await prisma.client.$queryRaw<{ current_database: string }[]>`
      SELECT current_database() AS current_database
    `;
    assertDatabaseNameIsTest(databases[0]?.current_database, 'DATABASE_URL');
    companyA = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_A } })).id;
    companyB = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_B } })).id;
    await removeFixtures();
    const seeded = await withCompany(companyA, (tx) =>
      tx.store.findFirstOrThrow({
        where: { companyId: companyA, name: 'Nutbox Demo PrestaShop' },
        select: { brandId: true, locationId: true },
      }),
    );
    brandId = seeded.brandId;
    locationId = seeded.locationId;
    admin = await login(app, 'admin.a@example.test');
    adminB = await login(app, 'admin.b@example.test');
    finance = await login(app, 'finance.a@example.test');
    await createFixtures();
  }, 120_000);

  afterAll(async () => {
    if (app) {
      await removeFixtures();
      await app.close();
    }
    if (storageRoot) {
      rmSync(storageRoot, { recursive: true, force: true });
    }
    if (mockRoot) {
      rmSync(mockRoot, { recursive: true, force: true });
    }
    restoreEnv();
  });

  it('reports each PrestaShop store with its health and counts', async () => {
    const response = await call(admin, 'get', healthUrl(companyA), cid('read'));
    expect(response.status, text(response)).toBe(200);
    const body = record(response.body);
    expect(typeof body.now).toBe('string');
    const rows = (body.prestashop as Record<string, unknown>[]).filter((row) =>
      String(row.storeName).startsWith(PREFIX),
    );
    const byName = new Map(rows.map((row) => [String(row.storeName), row]));
    expect([...byName.keys()].sort()).toEqual(
      ['active', 'auth', 'none', 'paused', 'stale'].map((name) => `${PREFIX}${name} ${runId}`).sort(),
    );

    const active = record(byName.get(`${PREFIX}active ${runId}`)?.connection);
    expect(active.health).toEqual({ level: 'ok', reason: 'ok' });
    expect(active.keySet).toBe(true);
    expect(active.pollIntervalSeconds).toBe(180);
    expect(active.failedImports).toBe(2);
    expect(active.waitingImports).toBe(1);
    expect(active.reviewRequired).toBe(1);

    expect(record(byName.get(`${PREFIX}stale ${runId}`)?.connection).health).toEqual({
      level: 'error',
      reason: 'sync_stale',
    });
    expect(record(byName.get(`${PREFIX}paused ${runId}`)?.connection).health).toEqual({
      level: 'paused',
      reason: 'paused',
    });
    expect(record(byName.get(`${PREFIX}auth ${runId}`)?.connection).health).toEqual({
      level: 'error',
      reason: 'auth_failed',
    });
    expect(byName.get(`${PREFIX}none ${runId}`)?.connection).toBeNull();

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain(KEY);
    expect(serialised).not.toContain(KEY.slice(-4));
    expect(serialised).not.toContain('baseUrl');
    expect(serialised).not.toContain('credentialId');
    expect(serialised).not.toContain(stores.bNoise ?? 'missing');
  });

  it('reports PrintNode, printers, mappings and recent print failures', async () => {
    const saved = await call(admin, 'put', `/api/c/${companyA}/print-accounts/printnode`, cid('pn'), {
      key: PRINT_KEY,
    });
    expect(saved.status, text(saved)).toBe(200);
    const response = await call(admin, 'get', healthUrl(companyA), cid('printing'));
    expect(response.status, text(response)).toBe(200);
    const printing = record(record(response.body).printing);
    expect(printing.printNodeKeySet).toBe(true);
    expect(typeof printing.printNodeKeySetAt).toBe('string');
    expect(JSON.stringify(printing)).not.toContain(PRINT_KEY);

    const expected = await withCompany(companyA, async (tx) => ({
      printers: await tx.printer.count({ where: { companyId: companyA, location: { archivedAt: null } } }),
      locations: await tx.location.count({ where: { companyId: companyA, archivedAt: null } }),
      gift: await tx.printerMapping.findFirst({
        where: { companyId: companyA, locationId, documentType: 'gift_message' },
        select: { paperSize: true, printer: { select: { name: true } } },
      }),
      failed: await tx.printJob.count({
        where: {
          companyId: companyA,
          status: { in: ['failed', 'uncertain'] },
          createdAt: { gt: new Date(Date.now() - 24 * 60 * MINUTE) },
        },
      }),
    }));
    expect((printing.printers as unknown[]).length).toBe(expected.printers);
    const mappings = printing.mappings as Record<string, unknown>[];
    expect(mappings.length).toBe(expected.locations);
    const seededLocation = mappings.find((row) => row.locationId === locationId);
    if (expected.gift) {
      expect(record(seededLocation?.giftMessage)).toMatchObject({
        printerName: expected.gift.printer.name,
        paper: expected.gift.paperSize,
      });
    } else {
      expect(seededLocation?.giftMessage).toBeNull();
    }
    expect(printing.failedLast24h).toBe(expected.failed);
  });

  it('never counts company B, and denies a member without integration.view', async () => {
    const own = await call(adminB, 'get', healthUrl(companyB), cid('b-read'));
    expect(own.status, text(own)).toBe(200);
    const serialised = JSON.stringify(own.body);
    for (const id of Object.values(stores)) {
      if (id !== stores.bNoise) {
        expect(serialised).not.toContain(id);
      }
    }
    expect(serialised).not.toContain(PREFIX + 'active');

    const foreign = await call(adminB, 'get', healthUrl(companyA), cid('b-foreign'));
    expect(foreign.status).toBe(404);

    const denied = await call(finance, 'get', healthUrl(companyA), cid('denied'));
    expect(denied.status).toBe(403);
    const events = await withPlatform(companyA, (tx) =>
      tx.auditEvent.findMany({ where: { correlationId: cid('denied') }, select: { action: true } }),
    );
    expect(events.map((event) => event.action)).toContain('authorization.denied');
  });
});

async function createFixtures(): Promise<void> {
  for (const name of ['active', 'stale', 'paused', 'auth']) {
    stores[name] = await createStore(name);
    const saved = await call(admin, 'put', connectionUrl(stores[name]), cid(`conn-${name}`), {
      baseUrl: 'https://shop.example.test',
      timezone: 'Asia/Nicosia',
      firstImportFrom: '2026-01-01 00:00:00',
      pollIntervalSeconds: 180,
      key: KEY,
    });
    expect(saved.status, text(saved)).toBe(200);
    connections[name] = stringField(record(record(saved.body).connection), 'id');
  }
  stores.none = await createStore('none');
  stores.archived = await createStore('archived');
  const archived = await call(admin, 'patch', `/api/c/${companyA}/stores/${stores.archived}`, cid('archive'), {
    archived: true,
  });
  expect(archived.status, text(archived)).toBe(200);

  const now = Date.now();
  await withCompany(companyA, async (tx) => {
    await tx.storeConnection.update({
      where: { id: connections.active },
      data: { status: 'active', lastSyncAt: new Date(now - MINUTE) },
    });
    await tx.storeConnection.update({
      where: { id: connections.stale },
      data: { status: 'active', lastSyncAt: new Date(now - 20 * MINUTE) },
    });
    await tx.storeConnection.update({
      where: { id: connections.auth },
      data: { status: 'auth_failed', lastErrorClass: 'auth_failed', lastErrorAt: new Date(now - MINUTE) },
    });
    const inbox = [
      { status: 'failed' as const, receivedAt: new Date(now - MINUTE) },
      { status: 'failed' as const, receivedAt: new Date(now - 2 * MINUTE) },
      { status: 'received' as const, receivedAt: new Date(now - 20 * MINUTE) },
      { status: 'received' as const, receivedAt: new Date(now - MINUTE) },
      { status: 'processed' as const, receivedAt: new Date(now - MINUTE) },
    ];
    await tx.integrationInbox.createMany({
      data: inbox.map((row, index) => ({
        companyId: companyA,
        connectionId: connections.active ?? '',
        provider: 'prestashop',
        externalEventId: `health:${runId}:${String(index)}`,
        topic: 'orders/updated',
        payload: {},
        status: row.status,
        receivedAt: row.receivedAt,
      })),
    });
    for (const [index, status] of (['review_required', 'new'] as const).entries()) {
      await tx.salesOrder.create({
        data: {
          companyId: companyA,
          storeId: stores.active ?? '',
          connectionId: connections.active ?? '',
          externalId: `health-${runId}-${String(index)}`,
          externalNumber: `#H-${runId}-${String(index)}`,
          sourcePlatform: 'prestashop',
          sourceStatus: {},
          paymentStatus: 'paid',
          fulfilmentStatus: status,
          integrationStatus: 'synced',
          deliveryMethod: 'courier_cy',
          currency: 'EUR',
          subtotal: '1.00',
          shippingTotal: '0.00',
          taxTotal: '0.00',
          total: '1.00',
          recipient: { firstName: 'Ada', lastName: 'Health' },
          version: 1,
        },
      });
    }
  });

  // Company B noise: failed inbox rows on one of B's seeded connections.
  await withCompany(companyB, async (tx) => {
    const store = await tx.store.findFirstOrThrow({
      where: { companyId: companyB, connections: { some: {} } },
      select: { id: true, connections: { select: { id: true }, take: 1 } },
    });
    stores.bNoise = store.id;
    const connection = store.connections[0];
    if (!connection) {
      return;
    }
    await tx.integrationInbox.createMany({
      data: [0, 1, 2].map((index) => ({
        companyId: companyB,
        connectionId: connection.id,
        provider: 'prestashop',
        externalEventId: `health-b:${runId}:${String(index)}`,
        topic: 'orders/updated',
        payload: {},
        status: 'failed' as const,
      })),
    });
  });
}

async function removeFixtures(): Promise<void> {
  if (!companyA) {
    return;
  }
  await withCompany(companyA, async (tx) => {
    const found = await tx.store.findMany({
      where: { companyId: companyA, name: { startsWith: PREFIX } },
      select: { id: true },
    });
    const storeIds = found.map((row) => row.id);
    if (storeIds.length > 0) {
      await tx.salesOrder.deleteMany({ where: { companyId: companyA, storeId: { in: storeIds } } });
      const linked = await tx.storeConnection.findMany({
        where: { companyId: companyA, storeId: { in: storeIds } },
        select: { id: true },
      });
      const connectionIds = linked.map((row) => row.id);
      if (connectionIds.length > 0) {
        await tx.integrationInbox.deleteMany({ where: { companyId: companyA, connectionId: { in: connectionIds } } });
        await tx.storeConnection.deleteMany({ where: { companyId: companyA, id: { in: connectionIds } } });
      }
      await tx.store.deleteMany({ where: { companyId: companyA, id: { in: storeIds } } });
    }
    await tx.integrationCredential.deleteMany({
      where: { companyId: companyA, provider: 'prestashop', label: 'webservice_key', connections: { none: {} } },
    });
    await tx.integrationCredential.updateMany({
      where: { companyId: companyA, provider: 'printnode', label: 'api_key', revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });
  if (companyB) {
    await withCompany(companyB, (tx) =>
      tx.integrationInbox.deleteMany({
        where: { companyId: companyB, externalEventId: { startsWith: 'health-b:' } },
      }),
    );
  }
}

async function createStore(name: string): Promise<string> {
  const response = await call(admin, 'post', `/api/c/${companyA}/stores`, cid(`store-${name}`), {
    name: `${PREFIX}${name} ${runId}`,
    platform: 'prestashop',
    brandId,
    locationId,
  });
  expect(response.status, text(response)).toBe(200);
  return stringField(record(record(response.body).store), 'id');
}

function healthUrl(companyId: string): string {
  return `/api/c/${companyId}/integrations/health`;
}

function connectionUrl(storeId: string | undefined): string {
  return `/api/c/${companyA}/stores/${storeId ?? ''}/prestashop-connection`;
}

function withCompany<T>(companyId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return new TenantDb(started().get(PrismaService).client).run(
    { companyId, actor: 'health-test', correlationId: cid('db') },
    fn,
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

function call(session: Session, method: Method, url: string, correlationId: string, payload?: object) {
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
  return `r1e-${name}-${runId}`.slice(0, 64);
}

function seedDatabase(): void {
  const root = resolve(process.cwd(), '../..');
  const result = spawnSync('pnpm', ['--filter', '@bp/db', 'seed'], { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`seed exited ${String(result.status ?? result.signal)}`);
  }
}

async function bootApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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

function text(response: request.Response): string {
  return JSON.stringify(response.body);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('expected an object');
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') {
    throw new Error(`missing ${key}`);
  }
  return field;
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
