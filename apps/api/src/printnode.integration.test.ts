import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TenantDb, type TenantTransaction } from '@bp/db';
import {
  createSafeFetch,
  MockPrintProvider,
  PrintNodeProvider,
  ProviderRejected,
} from '@bp/integrations';
import { Logger } from 'nestjs-pino';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  assertDatabaseNameIsTest,
  assertEnvConnectionsTargetTestDatabase,
  assertTestDatabaseUrls,
} from '../../../tools/test-db-guard.mjs';
import { AppModule } from './app.module';
import { JobRunner } from './automation/jobs/job-runner';
import { APP_CONFIG, type AppConfig } from './config/env';
import { correlationStorage } from './correlation/correlation';
import { PrismaService } from './database/prisma.service';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { LOG_STREAM } from './logging/logging.module';
import { createPrintProviderRegistry, PrintProviderRegistry } from './printing/print-providers';
import { MOCK_PRINT_PROVIDER } from './printing/print.tokens';
import { CredentialVault } from './vault/credential-vault';

const COMPANY_A = 'Demo Company A Ltd (fictional)';
const GIFT = 'Happy birthday';
const runId = randomUUID().slice(0, 8);
const API_KEY = `pn-fictional-${runId}`;

type Agent = ReturnType<typeof request.agent>;
type Session = { agent: Agent; xsrf: string };
type Method = 'get' | 'post';

type Script = {
  submitStatus: number;
  submitBody: unknown;
  states: unknown;
  posts: { idempotencyKey: string; body: unknown }[];
  stateGets: number;
};

const script: Script = {
  submitStatus: 201,
  submitBody: 4242,
  states: [],
  posts: [],
  stateGets: 0,
};

const PRINTERS = [
  {
    id: 1001,
    name: 'Zebra ZD230',
    state: 'online',
    computer: { name: 'Shop PC' },
    capabilities: { papers: { A6: { width: 105 }, A4: { width: 210 } } },
  },
];

let app: INestApplication | undefined;
let bare: INestApplication | undefined;
let storageRoot = '';
let mockRoot = '';
let origin = '';
let closeFake: (() => Promise<void>) | undefined;
let sequence = 0;
const savedEnv = {
  PRINTNODE_BASE_URL: process.env.PRINTNODE_BASE_URL,
  OUTBOUND_ALLOW_LOOPBACK_FOR_TESTS: process.env.OUTBOUND_ALLOW_LOOPBACK_FOR_TESTS,
  APP_MASTER_KEYS: process.env.APP_MASTER_KEYS,
  APP_MASTER_KEY_ACTIVE: process.env.APP_MASTER_KEY_ACTIVE,
};

describe('PrintNode provider', () => {
  let companyA = '';
  let adminUserId = '';
  let shopifyStoreA = '';
  let shopifyConnectionA = '';
  let locationId = '';
  let zebraId = '';
  let adminA: Session;
  let fulfil: Session;

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
    storageRoot = mkdtempSync(join(tmpdir(), 'bp-r1d-store-'));
    mockRoot = mkdtempSync(join(tmpdir(), 'bp-r1d-print-'));
    process.env.STORAGE_ROOT = storageRoot;
    process.env.MOCK_PRINT_ROOT = mockRoot;
    process.env.APP_ENV = 'test';
    process.env.AUTH_DEV_LOGIN_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECURE = 'false';
    process.env.CSRF_SECRET = 'integration-test-csrf-secret';
    process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED = 'false';
    process.env.PRINTNODE_BASE_URL = origin;
    process.env.OUTBOUND_ALLOW_LOOPBACK_FOR_TESTS = 'true';
    process.env.APP_MASTER_KEYS = JSON.stringify({ k1: Buffer.alloc(32, 7).toString('base64') });
    process.env.APP_MASTER_KEY_ACTIVE = 'k1';
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
    companyA = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_A } }))
      .id;
    adminUserId = (
      await prisma.client.userAccount.findFirstOrThrow({ where: { email: 'admin.a@example.test' } })
    ).id;
    const shopifyA = await withCompany(companyA, (tx) =>
      tx.store.findFirstOrThrow({ where: { companyId: companyA, name: 'Nutbox Demo Shopify' } }),
    );
    shopifyStoreA = shopifyA.id;
    locationId = shopifyA.locationId;
    shopifyConnectionA = (
      await withCompany(companyA, (tx) =>
        tx.storeConnection.findFirstOrThrow({
          where: { companyId: companyA, storeId: shopifyStoreA, status: 'active', mode: 'mock' },
        }),
      )
    ).id;
    await revokeKeys(companyA, adminUserId);
    await correlationStorage.run({ correlationId: cid('store-key') }, () =>
      started().get(CredentialVault).encrypt({
        companyId: companyA,
        provider: 'printnode',
        label: 'api_key',
        plaintext: API_KEY,
        createdById: adminUserId,
      }),
    );
    adminA = await login(app, 'admin.a@example.test');
    fulfil = await login(app, 'fulfil.a@example.test');
    const discovered = await send(
      adminA,
      'post',
      `/api/c/${companyA}/printers/discover`,
      cid('discover'),
      { locationId },
    );
    expect(discovered.status, text(discovered)).toBe(200);
    const printers = arrayOf(record(discovered.body).printers).map((row) => record(row));
    expect(printers).toHaveLength(1);
    const zebra = printers[0];
    if (!zebra) {
      throw new Error('PrintNode discovery returned no printer');
    }
    expect(zebra.provider).toBe('printnode');
    expect(zebra.externalPrinterId).toBe('1001');
    expect(zebra.name).toBe('Zebra ZD230');
    expect(zebra.description).toBe('Shop PC');
    expect(zebra.paperSizes).toEqual(['A6', 'A4']);
    expect(zebra.status).toBe('online');
    expect(zebra.simulationLabel).toBeNull();
    expect(zebra.locationId).toBe(locationId);
    zebraId = stringField(zebra, 'id');
    const events = await auditEvents(app, cid('discover'), companyA);
    const found = events.find((event) => event.action === 'printer.discovered');
    expect(found?.outcome).toBe('success');
    expect(detailField(found?.details, 'provider')).toBe('printnode');
    await started()
      .get(PrismaService)
      .client.job.deleteMany({
        where: { status: 'queued', type: 'inbox.process' },
      });
    await started()
      .get(PrismaService)
      .client.job.updateMany({
        where: { type: { in: ['print.submit', 'print.refresh_status'] }, status: 'queued' },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
  }, 120_000);

  afterEach(async () => {
    script.submitStatus = 201;
    script.submitBody = 4242;
    script.states = [];
    script.posts = [];
    script.stateGets = 0;
    if (app) {
      await app.get(PrismaService).client.job.updateMany({
        where: { type: { in: ['print.submit', 'print.refresh_status'] }, status: 'queued' },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
    }
  });

  afterAll(async () => {
    if (app && companyA && adminUserId) {
      await revokeKeys(companyA, adminUserId);
      await app.get(PrismaService).client.job.updateMany({
        where: { type: { in: ['print.submit', 'print.refresh_status'] }, status: 'queued' },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
    }
    if (bare) {
      await bare.close();
      bare = undefined;
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
    restoreEnv('PRINTNODE_BASE_URL', savedEnv.PRINTNODE_BASE_URL);
    restoreEnv('OUTBOUND_ALLOW_LOOPBACK_FOR_TESTS', savedEnv.OUTBOUND_ALLOW_LOOPBACK_FOR_TESTS);
    restoreEnv('APP_MASTER_KEYS', savedEnv.APP_MASTER_KEYS);
    restoreEnv('APP_MASTER_KEY_ACTIVE', savedEnv.APP_MASTER_KEY_ACTIVE);
  });

  it('submits a gift message once and reports done without calling it printed', async () => {
    const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA);
    const correlationId = cid('gift');
    const created = await requestPrint(fulfil, companyA, order.id, correlationId, zebraId);
    expect(created.status).toBe('queued');
    expect(created.provider).toBe('printnode');
    expect(created.simulationLabel).toBeNull();
    const printJobId = stringField(created, 'id');

    await drainOnce();
    expect(script.posts).toHaveLength(1);
    const post = script.posts[0];
    expect(post?.idempotencyKey).toBe(`pj_${printJobId}`);
    expect(record(post?.body).printerId).toBe(1001);
    expect(record(post?.body).contentType).toBe('pdf_base64');
    expect(record(post?.body).source).toBe('business-platform');
    expect(record(post?.body).expireAfter).toBe(86400);
    expect(record(post?.body).options).toEqual({ copies: 1, paper: 'A6' });
    expect(typeof record(post?.body).content).toBe('string');

    script.states = [jobState('sent_to_client', '2026-10-23T12:00:00.000Z')];
    await releaseRefresh(printJobId);
    const delivered = await loadPrint(fulfil, companyA, printJobId);
    expect(delivered.status).toBe('delivered_to_printer');
    expect(delivered.provider).toBe('printnode');

    script.states = [
      jobState('sent_to_client', '2026-10-23T12:00:00.000Z'),
      jobState('done', '2026-10-23T12:05:00.000Z'),
    ];
    await releaseRefresh(printJobId);
    const done = await loadPrint(fulfil, companyA, printJobId);
    expect(done.status).toBe('done_reported');
    expect(done.status).not.toBe('confirmed_printed');
    expect(script.posts).toHaveLength(1);

    const events = await auditEvents(app, correlationId, companyA);
    for (const action of [
      'print_job.requested',
      'print_job.submitting',
      'print_job.submitted',
      'print_job.delivered_to_printer',
      'print_job.done_reported',
    ]) {
      const event = events.find((row) => row.action === action);
      expect(event?.outcome, action).toBe('success');
      expect(detailField(event?.details, 'provider'), action).toBe('printnode');
    }
  });

  it('fails a printer error and accepts a new first print', async () => {
    const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA);
    const created = await requestPrint(fulfil, companyA, order.id, cid('jam'), zebraId);
    const printJobId = stringField(created, 'id');
    script.states = [jobState('error', '2026-10-23T12:00:00.000Z', 'paper jam')];
    await drainOnce();
    await releaseRefresh(printJobId);
    const failed = await loadPrint(fulfil, companyA, printJobId);
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toBe('printer_error: paper jam');

    const again = await requestPrint(fulfil, companyA, order.id, cid('jam-again'), zebraId);
    expect(again.status).toBe('queued');
    expect(stringField(again, 'id')).not.toBe(printJobId);
  });

  it('keeps a 409 submit uncertain and does not send it again', async () => {
    script.submitStatus = 409;
    script.submitBody = { message: 'conflict' };
    const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA);
    const created = await requestPrint(fulfil, companyA, order.id, cid('collision'), zebraId);
    const printJobId = stringField(created, 'id');
    await drainOnce();
    const uncertain = await loadPrint(fulfil, companyA, printJobId);
    expect(uncertain.status).toBe('uncertain');
    expect(uncertain.lastError).toBe('idempotency_collision');
    expect(script.posts).toHaveLength(1);
    await drainOnce();
    expect(script.posts).toHaveLength(1);
    expect((await loadPrint(fulfil, companyA, printJobId)).status).toBe('uncertain');
  });

  it('stops a refresh older than 26 hours without calling PrintNode or changing status', async () => {
    const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA);
    const created = await requestPrint(fulfil, companyA, order.id, cid('aged'), zebraId);
    const printJobId = stringField(created, 'id');
    await drainOnce();
    const submitted = await loadPrint(fulfil, companyA, printJobId);
    expect(submitted.status).toBe('submitted');
    if ((await queuedRefreshCount(printJobId)) === 0) {
      await enqueueAgedRefresh(companyA, printJobId, 'aged-first');
    }

    await withCompany(
      companyA,
      (tx) =>
        tx.$executeRaw`
        UPDATE print_job
        SET submitted_at = clock_timestamp() - interval '27 hours'
        WHERE company_id = ${companyA}::uuid AND id = ${printJobId}::uuid
      `,
    );
    script.states = [jobState('expired', '2026-10-23T12:00:00.000Z')];
    script.stateGets = 0;
    const before = await loadPrint(fulfil, companyA, printJobId);

    await releaseRefresh(printJobId);
    expect(script.stateGets).toBe(0);
    const once = await loadPrint(fulfil, companyA, printJobId);
    expect(once.status).toBe(before.status);
    expect(once.providerState).toBe(before.providerState);
    expect(once.lastError).toBe(before.lastError);
    expect(await refreshStoppedEvents(companyA, printJobId)).toEqual([
      { outcome: 'success', provider: 'printnode' },
    ]);

    await enqueueAgedRefresh(companyA, printJobId, 'aged-again');
    await drainOnce();
    expect(script.stateGets).toBe(0);
    const twice = await loadPrint(fulfil, companyA, printJobId);
    expect(twice.status).toBe(before.status);
    expect(twice.providerState).toBe(before.providerState);
    expect(twice.lastError).toBe(before.lastError);
    expect(await refreshStoppedEvents(companyA, printJobId)).toEqual([
      { outcome: 'success', provider: 'printnode' },
    ]);
    const jobs = await refreshJobs(printJobId);
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    expect(jobs.every((job) => job.status === 'succeeded')).toBe(true);
  });

  it('fails a submit when the key cannot be decrypted and does not call PrintNode', async () => {
    const stored = await withCompany(companyA, (tx) =>
      tx.integrationCredential.findFirstOrThrow({
        where: { companyId: companyA, provider: 'printnode', label: 'api_key', revokedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, ciphertext: true },
      }),
    );
    const postsBefore = script.posts.length;
    await withCompany(
      companyA,
      (tx) =>
        tx.integrationCredential.update({
          where: { id: stored.id },
          data: { ciphertext: Buffer.from('not-a-seal') },
        }),
      adminUserId,
    );
    try {
      const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA);
      const created = await requestPrint(fulfil, companyA, order.id, cid('decrypt'), zebraId);
      await drainOnce();
      const failed = await loadPrint(fulfil, companyA, stringField(created, 'id'));
      expect(failed.status).toBe('failed');
      expect(failed.lastError).toBe('credential_unavailable');
      expect(script.posts).toHaveLength(postsBefore);
    } finally {
      await withCompany(
        companyA,
        (tx) =>
          tx.integrationCredential.update({
            where: { id: stored.id },
            data: { ciphertext: Buffer.from(stored.ciphertext) },
          }),
        adminUserId,
      );
    }
  });

  it('does not construct the mock provider in production or uat', async () => {
    expect(started().get(MOCK_PRINT_PROVIDER)).toBeInstanceOf(MockPrintProvider);
    const signedIn = await request(started().getHttpServer() as App)
      .post('/api/auth/dev/login')
      .send({ email: 'admin.a@example.test' });
    expect(signedIn.status, text(signedIn)).toBe(200);
    const xsrf = cookieValue(cookieHeader(signedIn, 'XSRF-TOKEN'), 'XSRF-TOKEN');
    const sessionCookie = cookieValue(cookieHeader(signedIn, 'bp_session'), 'bp_session');
    const base = started().get<AppConfig>(APP_CONFIG);

    for (const appEnv of ['production', 'uat'] as const) {
      let application: INestApplication | undefined;
      try {
        application = await bootApp((builder) => {
          builder.overrideProvider(APP_CONFIG).useValue({
            ...base,
            appEnv,
            outboundAllowLoopbackForTests: false,
            printNodeBaseUrl: null,
          });
        });
        expect(application.get(MOCK_PRINT_PROVIDER)).toBeNull();
        expect(application.get(PrintProviderRegistry).available()).toEqual(['printnode']);
        const refused = await request(application.getHttpServer() as App)
          .post(`/api/c/${companyA}/printers/discover`)
          .set('Cookie', `bp_session=${sessionCookie}`)
          .set('X-XSRF-TOKEN', xsrf)
          .set('X-Correlation-Id', cid(`mock-${appEnv}`))
          .send({ provider: 'mock' });
        expect(refused.status, text(refused)).toBe(400);
        expect(record(record(refused.body).error).code).toBe('print_provider_unavailable');
      } finally {
        await application?.close();
      }
    }
  }, 120_000);

  it('fails a PrintNode submit when the key is gone and refuses discovery without a mock', async () => {
    await revokeKeys(companyA, adminUserId);
    const before = script.posts.length;
    const order = await makeOrder(companyA, shopifyStoreA, shopifyConnectionA);
    const created = await requestPrint(fulfil, companyA, order.id, cid('no-key'), zebraId);
    await drainOnce();
    const failed = await loadPrint(fulfil, companyA, stringField(created, 'id'));
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toBe('not_configured');
    expect(script.posts).toHaveLength(before);

    const mockBefore = await printerCount(companyA, 'mock');
    const nodeBefore = await printerCount(companyA, 'printnode');
    bare = await bootBare(mockRoot, origin);
    const adminBare = await login(bare, 'admin.a@example.test');
    const missing = await send(
      adminBare,
      'post',
      `/api/c/${companyA}/printers/discover`,
      cid('no-provider'),
      {},
    );
    expect(missing.status, text(missing)).toBe(409);
    expect(record(record(missing.body).error).code).toBe('print_provider_not_configured');
    const denied = await auditEvents(bare, cid('no-provider'), companyA);
    const discovered = denied.find((event) => event.action === 'printer.discovered');
    expect(discovered?.outcome).toBe('failure');
    expect(detailField(discovered?.details, 'reason')).toBe('print_provider_not_configured');

    const refused = await send(
      adminBare,
      'post',
      `/api/c/${companyA}/printers/discover`,
      cid('no-mock'),
      { provider: 'mock' },
    );
    expect(refused.status, text(refused)).toBe(400);
    expect(record(record(refused.body).error).code).toBe('print_provider_unavailable');
    expect(await printerCount(companyA, 'mock')).toBe(mockBefore);
    expect(await printerCount(companyA, 'printnode')).toBe(nodeBefore);
    await bare.close();
    bare = undefined;
  }, 120_000);

  async function makeOrder(
    companyId: string,
    storeId: string,
    connectionId: string,
  ): Promise<{ id: string }> {
    sequence += 1;
    const id = await withCompany(
      companyId,
      async (tx) => {
        const order = await tx.salesOrder.create({
          data: {
            companyId,
            storeId,
            connectionId,
            externalId: `r1d-${runId}-${String(sequence)}`,
            externalNumber: `#R1D-${runId}-${String(sequence)}`,
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
            giftMessage: GIFT,
            recipient: {
              firstName: 'Maria',
              lastName: 'Demo',
              address1: '1 Demo Street',
              city: 'Nicosia',
              zip: '1000',
              countryCodeV2: 'CY',
            },
            version: 1,
            lines: {
              create: [
                {
                  sku: 'NUTS',
                  title: 'Mixed nuts',
                  quantity: '1.0000',
                  unitPrice: '1.0000',
                  total: '1.00',
                },
              ],
            },
          },
          select: { id: true },
        });
        return order.id;
      },
      adminUserId,
    );
    return { id };
  }
});

function jobState(
  state: string,
  createTimestamp: string,
  message?: string,
): Record<string, unknown> {
  return {
    printJobId: 4242,
    state,
    createTimestamp,
    ...(message !== undefined ? { message } : {}),
  };
}

async function printerCount(companyId: string, provider: 'mock' | 'printnode'): Promise<number> {
  return withCompany(companyId, (tx) => tx.printer.count({ where: { companyId, provider } }));
}

async function revokeKeys(companyId: string, actor: string): Promise<void> {
  await withCompany(
    companyId,
    (tx) =>
      tx.integrationCredential.updateMany({
        where: { companyId, provider: 'printnode', label: 'api_key', revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    actor,
  );
}

function withCompany<T>(
  companyId: string,
  fn: (tx: TenantTransaction) => Promise<T>,
  actor = 'printnode-test',
): Promise<T> {
  return new TenantDb(started().get(PrismaService).client).run(
    { companyId, actor, correlationId: cid('db') },
    fn,
  );
}

async function drainOnce(): Promise<void> {
  await started().get(JobRunner).drainOnce();
}

async function releaseRefresh(printJobId: string): Promise<void> {
  await started().get(PrismaService).client.$executeRaw`
    UPDATE job
    SET run_after = clock_timestamp()
    WHERE type = 'print.refresh_status'
      AND status = 'queued'
      AND payload->>'printJobId' = ${printJobId}
  `;
  await drainOnce();
}

async function enqueueAgedRefresh(
  companyId: string,
  printJobId: string,
  suffix: string,
): Promise<void> {
  await started()
    .get(PrismaService)
    .client.job.create({
      data: {
        companyId,
        type: 'print.refresh_status',
        payload: { printJobId, refresh: 1 },
        status: 'queued',
        attempts: 0,
        maxAttempts: 5,
        runAfter: new Date(),
        timeoutMs: 15_000,
        correlationId: cid(suffix),
        idempotencyKey: `print.refresh:${printJobId}:${suffix}`,
      },
    });
}

async function queuedRefreshCount(printJobId: string): Promise<number> {
  const rows = await started().get(PrismaService).client.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM job
    WHERE type = 'print.refresh_status'
      AND status = 'queued'
      AND payload->>'printJobId' = ${printJobId}
  `;
  return rows[0]?.count ?? 0;
}

async function refreshJobs(printJobId: string): Promise<{ status: string }[]> {
  return started().get(PrismaService).client.$queryRaw<{ status: string }[]>`
    SELECT status::text AS status
    FROM job
    WHERE type = 'print.refresh_status'
      AND payload->>'printJobId' = ${printJobId}
  `;
}

async function refreshStoppedEvents(
  companyId: string,
  printJobId: string,
): Promise<{ outcome: string; provider: string | undefined }[]> {
  const prisma = started().get(PrismaService);
  const rows = await prisma.client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform_scope', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.company_id', ${companyId}, true)`;
    return tx.auditEvent.findMany({
      where: {
        companyId,
        action: 'print_job.refresh_stopped',
        objectType: 'print_job',
        objectId: printJobId,
      },
      orderBy: { occurredAt: 'asc' },
    });
  });
  return rows.map((row) => ({
    outcome: row.outcome,
    provider: detailField(row.details, 'provider'),
  }));
}

async function requestPrint(
  session: Session,
  companyId: string,
  orderId: string,
  correlationId: string,
  printerId: string,
): Promise<Record<string, unknown>> {
  const response = await send(
    session,
    'post',
    `/api/c/${companyId}/print-requests`,
    correlationId,
    {
      documentType: 'gift_message',
      sourceType: 'order',
      sourceId: orderId,
      printerId,
    },
  );
  expect(response.status, text(response)).toBe(200);
  return record(record(response.body).printJob);
}

async function loadPrint(
  session: Session,
  companyId: string,
  id: string,
): Promise<Record<string, unknown>> {
  const response = await send(session, 'get', `/api/c/${companyId}/print-jobs/${id}`);
  expect(response.status, text(response)).toBe(200);
  return record(record(response.body).printJob);
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

async function auditEvents(
  application: INestApplication | undefined,
  correlationId: string,
  companyId: string,
) {
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

function cid(name: string): string {
  return `r1d-${name}-${runId}`.slice(0, 64);
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

async function bootApp(overrides?: (builder: ReturnType<typeof Test.createTestingModule>) => void) {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LOG_STREAM)
    .useValue(stream);
  overrides?.(builder);
  const moduleRef = await builder.compile();
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

async function bootBare(root: string, baseUrl: string): Promise<INestApplication> {
  const registry = createPrintProviderRegistry({
    appEnv: 'production',
    mock: new MockPrintProvider(root),
    printnode: new PrintNodeProvider({
      fetch: createSafeFetch({ appEnv: 'test', allowLoopbackForTests: true }),
      apiKeyFor: () => Promise.reject(new ProviderRejected('not_configured')),
      baseUrl,
    }),
  });
  return bootApp((builder) => {
    builder.overrideProvider(PrintProviderRegistry).useValue(registry);
  });
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

function restoreEnv(
  name:
    | 'PRINTNODE_BASE_URL'
    | 'OUTBOUND_ALLOW_LOOPBACK_FOR_TESTS'
    | 'APP_MASTER_KEYS'
    | 'APP_MASTER_KEY_ACTIVE',
  value: string | undefined,
): void {
  if (value === undefined) {
    switch (name) {
      case 'PRINTNODE_BASE_URL':
        delete process.env.PRINTNODE_BASE_URL;
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
    }
  }
  process.env[name] = value;
}

function startFake(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void handleFake(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });
  return new Promise((resolveListen, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('fake PrintNode did not bind'));
        return;
      }
      resolveListen({
        origin: `http://127.0.0.1:${String(address.port)}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => {
              if (error) {
                fail(error);
                return;
              }
              done();
            });
          }),
      });
    });
  });
}

async function handleFake(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/printers') {
    json(res, 200, PRINTERS);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/printjobs') {
    const raw = await readBody(req);
    let body: unknown = raw;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      body = raw;
    }
    const header = req.headers['x-idempotency-key'];
    script.posts.push({
      idempotencyKey: typeof header === 'string' ? header : '',
      body,
    });
    json(res, script.submitStatus, script.submitBody);
    return;
  }
  if (req.method === 'GET' && /^\/printjobs\/[^/]+\/states$/.test(url.pathname)) {
    script.stateGets += 1;
    json(res, 200, script.states);
    return;
  }
  json(res, 404, { message: 'missing' });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}
