import { NestFactory } from '@nestjs/core';
import { TenantDb } from '@bp/db';
import { shopifyFixturesDirectory } from '@bp/integrations';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AppModule } from './app.module';
import { loadRootEnv } from './config/load-env';
import { PrismaService } from './database/prisma.service';
import { JobRunner } from './automation/jobs/job-runner';
import {
  PRESTASHOP_MILESTONE_EXTERNAL_ID,
  PRESTASHOP_MILESTONE_NUMBER,
  parseDemoArgs,
} from './demo-import-args';

/**
 * Posts the mock Shopify fixtures through the running API, then drains the job queue.
 * The service token is stored under var/ and is never printed.
 *
 * The Shopify connection id is read from the database. There is no store-connection
 * list endpoint yet.
 */
const ROOT = resolve(__dirname, '../../..');
const TOKEN_FILE = process.env.DEMO_TOKEN_FILE ?? join(ROOT, 'var', 'demo-service-identities.json');
const COMPANIES = {
  A: {
    legalName: 'Demo Company A Ltd (fictional)',
    email: 'admin.a@example.test',
    storeName: 'Nutbox Demo Shopify',
    fixtures: [
      'order-1001-paid-greek-gift.json',
      'order-1001-updated-later.json',
      'order-1001-updated-earlier.json',
      'order-1002-pending-international.json',
      'order-1003-emoji-gift.json',
    ],
  },
  B: {
    legalName: 'Demo Company B Ltd (fictional)',
    email: 'admin.b@example.test',
    storeName: 'Olive Grove Demo Shopify',
    fixtures: ['order-2001-company-b.json'],
  },
} as const;

type CompanyKey = keyof typeof COMPANIES;
type TokenFile = Partial<Record<CompanyKey, { companyId: string; token: string }>>;
type Jar = Map<string, string>;

const entry = process.argv[1] ?? '';
if (entry.endsWith('demo-import-fixtures.ts') || entry.endsWith('demo-import-fixtures.js')) {
  loadRootEnv();
  main()
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(safe(error));
      process.exit(1);
    });
}

async function main(): Promise<void> {
  const args = parseDemoArgs(process.argv.slice(2));
  const key = args.company;
  const spec = COMPANIES[key];
  const base = apiOrigin();
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
    abortOnError: false,
    logger: ['error'],
  });
  try {
    const jar: Jar = new Map();
    const me = await api(base, jar, 'POST', '/api/auth/dev/login', { email: spec.email });
    if (me.status !== 200) {
      throw new Error(`dev login failed (${String(me.status)})`);
    }
    const profile = await api(base, jar, 'GET', '/api/me');
    if (profile.status !== 200) {
      throw new Error(`session lookup failed (${String(profile.status)})`);
    }
    const companyId = companyIdFromMe(profile.body, spec.legalName);
    const connectionId = await shopifyConnectionId(app.get(PrismaService), companyId, spec.storeName);
    const token = await serviceToken(base, jar, key, companyId);
    const before = await orderCount(app.get(PrismaService), companyId);
    let accepted = 0;
    let duplicate = 0;
    for (const fileName of spec.fixtures) {
      const payload = readPayload(fileName);
      const updatedAt = payload.updatedAt;
      if (typeof updatedAt !== 'string') {
        throw new Error(`${fileName} has no updatedAt`);
      }
      const topic = fileName.includes('updated') ? 'orders/updated' : 'orders/create';
      const response = await api(
        base,
        new Map(),
        'POST',
        `/api/automation/v1/c/${companyId}/store-connections/${connectionId}/events`,
        {
          eventId: `demo:${key}:${fileName}`,
          topic,
          occurredAt: updatedAt,
          payload,
        },
        { authorization: `Bearer ${token}` },
      );
      if (response.status !== 202) {
        throw new Error(`${fileName} was not accepted (${String(response.status)})`);
      }
      const status = recordField(response.body, 'status');
      if (status === 'accepted') {
        accepted += 1;
      } else if (status === 'duplicate') {
        duplicate += 1;
      } else {
        throw new Error(`${fileName} returned an unexpected status`);
      }
    }
    if (args.prestashopOrder) {
      await ensurePrestashopOrder(app.get(PrismaService), companyId);
      console.log(`prestashop order ${PRESTASHOP_MILESTONE_NUMBER}`);
    }
    const drained = await app.get(JobRunner).drainOnce();
    const orders = await listOrders(app.get(PrismaService), companyId);
    console.log(`company ${key} (${spec.legalName})`);
    console.log(`events ${String(spec.fixtures.length)}: accepted ${String(accepted)}, duplicate ${String(duplicate)}`);
    console.log(`worker processed ${String(drained.processed)}`);
    console.log(`orders ${String(before)} -> ${String(orders.length)}`);
    for (const order of orders) {
      const review = order.reviewReason ? ` review=${order.reviewReason}` : '';
      const attention = order.attentionReasons.length > 0 ? ` attention=${order.attentionReasons.join(',')}` : '';
      console.log(
        `  ${order.externalNumber} v${String(order.version)} ${order.fulfilmentStatus} ${order.paymentStatus}${review}${attention}`,
      );
    }
  } finally {
    await app.close();
  }
}

const PRESTASHOP_STORE = 'Nutbox Demo PrestaShop';
const PRESTASHOP_GIFT = 'Δοκιμαστικό μήνυμα.\nΜόνο για τον έλεγχο απομόνωσης.';

async function ensurePrestashopOrder(prisma: PrismaService, companyId: string): Promise<void> {
  await new TenantDb(prisma.client).run(
    { companyId, actor: 'demo-import', correlationId: 'demo-import-prestashop' },
    async (tx) => {
      const existing = await tx.salesOrder.findFirst({
        where: { companyId, externalId: PRESTASHOP_MILESTONE_EXTERNAL_ID },
        select: { id: true },
      });
      if (existing) {
        return;
      }
      const store = await tx.store.findFirst({
        where: { companyId, name: PRESTASHOP_STORE, platform: 'prestashop' },
      });
      if (!store) {
        throw new Error(`store ${PRESTASHOP_STORE} was not found`);
      }
      const connection = await tx.storeConnection.findFirst({
        where: { companyId, storeId: store.id, status: 'active', mode: 'mock' },
      });
      if (!connection) {
        throw new Error(`mock connection for ${PRESTASHOP_STORE} was not found`);
      }
      await tx.salesOrder.create({
        data: {
          companyId,
          storeId: store.id,
          connectionId: connection.id,
          externalId: PRESTASHOP_MILESTONE_EXTERNAL_ID,
          externalNumber: PRESTASHOP_MILESTONE_NUMBER,
          sourcePlatform: 'prestashop',
          sourceStatus: { displayFulfillmentStatus: null, cancelledAt: null },
          sourceCreatedAt: new Date('2026-03-02T10:00:00.000Z'),
          sourceUpdatedAt: new Date('2026-03-02T10:00:00.000Z'),
          paymentStatus: 'paid',
          fulfilmentStatus: 'new',
          integrationStatus: 'synced',
          deliveryMethod: 'courier_cy',
          currency: 'EUR',
          subtotal: '12.00',
          shippingTotal: '0.00',
          taxTotal: '2.28',
          total: '14.28',
          version: 1,
          giftMessage: PRESTASHOP_GIFT,
          customer: {
            displayName: 'Presta Milestone (fictional)',
            email: 'presta.milestone@example.test',
            phone: null,
            id: null,
          },
          lines: {
            create: [
              {
                companyId,
                title: 'Fictional PrestaShop tin',
                quantity: '1.0000',
                unitPrice: '12.0000',
                total: '12.00',
              },
            ],
          },
        },
      });
    },
  );
}

async function shopifyConnectionId(prisma: PrismaService, companyId: string, storeName: string): Promise<string> {
  return new TenantDb(prisma.client).run(
    { companyId, actor: 'demo-import', correlationId: 'demo-import-connection' },
    async (tx) => {
      const store = await tx.store.findFirst({ where: { companyId, name: storeName, platform: 'shopify' } });
      if (!store) {
        throw new Error(`store ${storeName} was not found`);
      }
      const connection = await tx.storeConnection.findFirst({
        where: { companyId, storeId: store.id, status: 'active', mode: 'mock' },
      });
      if (!connection) {
        throw new Error(`mock connection for ${storeName} was not found`);
      }
      return connection.id;
    },
  );
}

async function serviceToken(base: string, jar: Jar, key: CompanyKey, companyId: string): Promise<string> {
  const stored = readTokenFile();
  const existing = stored[key];
  if (existing && existing.companyId === companyId) {
    const ping = await api(base, new Map(), 'GET', `/api/automation/v1/c/${companyId}/ping`, undefined, {
      authorization: `Bearer ${existing.token}`,
    });
    if (ping.status === 200) {
      return existing.token;
    }
  }
  const created = await api(base, jar, 'POST', `/api/c/${companyId}/service-identities`, {
    name: `demo-import-${key}`,
    purpose: 'fixture import',
    permissions: ['store.events.ingest'],
  });
  if (created.status !== 200) {
    throw new Error(`service identity was not created (${String(created.status)})`);
  }
  const token = recordField(created.body, 'token');
  if (!token.startsWith('bps_')) {
    throw new Error('service identity did not return a token');
  }
  stored[key] = { companyId, token };
  writeTokenFile(stored);
  return token;
}

function readTokenFile(): TokenFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    if (!isRecord(parsed)) {
      throw new Error('token file is unreadable');
    }
    const file: TokenFile = {};
    for (const key of ['A', 'B'] as const) {
      const entry = parsed[key];
      if (entry === undefined) {
        continue;
      }
      if (!isRecord(entry) || typeof entry.companyId !== 'string' || typeof entry.token !== 'string') {
        throw new Error('token file is unreadable');
      }
      file[key] = { companyId: entry.companyId, token: entry.token };
    }
    return file;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return {};
    }
    throw new Error('token file is unreadable');
  }
}

function apiOrigin(): string {
  const configured = process.env.DEMO_API_ORIGIN;
  if (configured && configured.length > 0) {
    return configured.replace(/\/$/, '');
  }
  return `http://127.0.0.1:${process.env.PORT ?? '3000'}`;
}

function writeTokenFile(file: TokenFile): void {
  mkdirSync(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_FILE, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
}

async function orderCount(prisma: PrismaService, companyId: string): Promise<number> {
  return new TenantDb(prisma.client).run(
    { companyId, actor: 'demo-import', correlationId: 'demo-import-count' },
    (tx) => tx.salesOrder.count({ where: { companyId } }),
  );
}

async function listOrders(prisma: PrismaService, companyId: string) {
  return new TenantDb(prisma.client).run(
    { companyId, actor: 'demo-import', correlationId: 'demo-import-list' },
    (tx) =>
      tx.salesOrder.findMany({
        where: { companyId },
        orderBy: [{ externalNumber: 'asc' }, { id: 'asc' }],
        select: {
          externalNumber: true,
          version: true,
          fulfilmentStatus: true,
          paymentStatus: true,
          reviewReason: true,
          attentionReasons: true,
        },
      }),
  );
}

function readPayload(fileName: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(shopifyFixturesDirectory(), fileName), 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${fileName} is not an object`);
  }
  return parsed;
}

type ApiResult = { status: number; body: unknown };

async function api(
  base: string,
  jar: Jar,
  method: 'GET' | 'POST',
  path: string,
  payload?: unknown,
  extra?: { authorization?: string },
): Promise<ApiResult> {
  const headers = new Headers();
  if (jar.size > 0) {
    headers.set('cookie', [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '));
  }
  const xsrf = jar.get('XSRF-TOKEN');
  if (xsrf && method !== 'GET') {
    headers.set('x-xsrf-token', xsrf);
  }
  if (extra?.authorization) {
    headers.set('authorization', extra.authorization);
  }
  if (payload !== undefined) {
    headers.set('content-type', 'application/json');
  }
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  } catch (error) {
    if (error instanceof Error && /ECONNREFUSED|fetch failed/i.test(error.message)) {
      throw new Error(`API is not accepting connections at ${base}`);
    }
    throw error;
  }
  storeCookies(jar, response);
  const text = await response.text();
  let body: unknown = {};
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = {};
    }
  }
  return { status: response.status, body };
}

function storeCookies(jar: Jar, response: Response): void {
  const lines = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const line of lines) {
    const pair = line.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) {
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }
}

function companyIdFromMe(body: unknown, legalName: string): string {
  if (!isRecord(body) || !Array.isArray(body.companies)) {
    throw new Error('session did not include companies');
  }
  for (const company of body.companies) {
    if (isRecord(company) && company.legalName === legalName && typeof company.id === 'string') {
      return company.id;
    }
  }
  throw new Error(`company ${legalName} is not in this session`);
}

function recordField(body: unknown, key: string): string {
  if (!isRecord(body) || typeof body[key] !== 'string') {
    throw new Error('response field is missing');
  }
  return body[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safe(error: unknown): string {
  const message = error instanceof Error ? error.message : 'demo import failed';
  return message.replace(/bps_[A-Za-z0-9_-]+/g, 'bps_[redacted]');
}
