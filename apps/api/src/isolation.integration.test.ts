import { type INestApplication } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
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
import { LOG_STREAM } from './logging/logging.module';

/**
 * One sweep over the routes the Nest app actually registered.
 * A company route that is neither exercised here nor listed in EXEMPTIONS fails.
 * Exemptions are only for routes with no object id beyond :companyId.
 * Claim is not a separate route: assigning yourself is POST orders/:id/assign.
 */

const COMPANY_A = 'Demo Company A Ltd (fictional)';
const COMPANY_B = 'Demo Company B Ltd (fictional)';
const VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const runId = randomUUID().slice(0, 8);

const EXEMPTIONS: { route: string; reason: string }[] = [
  { route: 'GET /api/c/:companyId/context', reason: 'Caller summary. No object id.' },
  { route: 'GET /api/c/:companyId/members', reason: 'Member list. No object id.' },
  { route: 'POST /api/c/:companyId/invitations', reason: 'Creates an invitation. No existing object id.' },
  { route: 'GET /api/c/:companyId/roles', reason: 'Role list. No object id.' },
  { route: 'GET /api/c/:companyId/audit-events', reason: 'Audit list. No object id.' },
  { route: 'GET /api/c/:companyId/service-identities', reason: 'Token list. No object id.' },
  { route: 'POST /api/c/:companyId/service-identities', reason: 'Creates a token. No existing object id.' },
  { route: 'GET /api/c/:companyId/clients', reason: 'Client list. No object id.' },
  {
    route: 'POST /api/c/:companyId/clients/duplicate-check',
    reason: 'excludeClientId is an exclusion filter. A foreign id is not loaded and does not 404.',
  },
  { route: 'GET /api/c/:companyId/tax-codes', reason: 'Tax-code list. No object id.' },
  { route: 'POST /api/c/:companyId/tax-codes', reason: 'Creates a tax code. No existing object id.' },
  { route: 'GET /api/c/:companyId/invoice-series', reason: 'Series list. No object id.' },
  { route: 'POST /api/c/:companyId/invoice-series', reason: 'Creates a series. No existing object id.' },
  { route: 'GET /api/c/:companyId/bank-accounts', reason: 'Bank-account list. No object id.' },
  { route: 'POST /api/c/:companyId/bank-accounts', reason: 'Creates a bank account. No existing object id.' },
  { route: 'GET /api/c/:companyId/products', reason: 'Product list. No object id.' },
  { route: 'GET /api/c/:companyId/invoices', reason: 'Invoice list. No object id.' },
  { route: 'GET /api/c/:companyId/orders', reason: 'Order list. No object id in the path or body.' },
  { route: 'GET /api/c/:companyId/gift-message-templates', reason: 'Template list. No object id.' },
  { route: 'GET /api/c/:companyId/print-jobs', reason: 'Print-job list. No object id in the path or body.' },
  { route: 'GET /api/c/:companyId/printers', reason: 'Printer list. No printer id route.' },
  { route: 'GET /api/c/:companyId/brands', reason: 'Brand list. No object id.' },
  { route: 'POST /api/c/:companyId/brands', reason: 'Creates a brand. No existing object id.' },
  { route: 'GET /api/c/:companyId/locations', reason: 'Location list. No object id.' },
  { route: 'POST /api/c/:companyId/locations', reason: 'Creates a location. No existing object id.' },
  { route: 'GET /api/c/:companyId/stores', reason: 'Store list. No object id.' },
  { route: 'GET /api/c/:companyId/printer-mappings', reason: 'Printer-mapping list. No object id.' },
  { route: 'GET /api/c/:companyId/automation/switches', reason: 'Switch list. No object id.' },
  { route: 'GET /api/c/:companyId/automation/jobs', reason: 'Job list. No job id route.' },
  {
    route: 'GET /api/automation/v1/c/:companyId/ping',
    reason: 'No object id. A staff session is not accepted on this route.',
  },
  {
    route: 'POST /api/automation/v1/c/:companyId/store-sync',
    reason: 'No object id. A staff session is not accepted on this route. Company mismatch is 404.',
  },
  {
    route: 'GET /api/c/:companyId/print-accounts/printnode',
    reason: 'PrintNode account for this company. No object id.',
  },
  {
    route: 'PUT /api/c/:companyId/print-accounts/printnode',
    reason: 'Stores this company\'s PrintNode key. No object id.',
  },
  {
    route: 'POST /api/c/:companyId/print-accounts/printnode/test',
    reason: 'Tests this company\'s PrintNode key. No object id.',
  },
  {
    route: 'GET /api/c/:companyId/integrations/health',
    reason: 'Health for this company. No object id. Counts come from this company only.',
  },
];

type Agent = ReturnType<typeof request.agent>;
type Session = { agent: Agent; xsrf: string };
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Snap = () => Promise<string>;
type SweepCase = {
  name: string;
  route: string;
  /** Company the denial is written against. */
  auditCompany: string;
  snap: Snap;
  call: (correlationId: string) => Promise<request.Response>;
};

type ExpressRoute = { path?: string; methods?: Record<string, boolean> };
type ExpressLayer = { route?: ExpressRoute; handle?: { stack?: ExpressLayer[] }; path?: string };

let app: INestApplication | undefined;
let storageRoot = '';
let mockRoot = '';
let adminUserId = '';

describe('company isolation sweep', () => {
  let companyA = '';
  let companyB = '';
  let adminA: Session;
  let adminB: Session;

  beforeAll(async () => {
    const refusal = assertTestDatabaseUrls();
    if (refusal) {
      throw new Error(refusal);
    }
    await assertEnvConnectionsTargetTestDatabase();
    seedDatabase();
    storageRoot = mkdtempSync(join(tmpdir(), 'bp-iso-store-'));
    mockRoot = mkdtempSync(join(tmpdir(), 'bp-iso-print-'));
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
    adminUserId = (await prisma.client.userAccount.findFirstOrThrow({ where: { email: 'admin.a@example.test' } })).id;
    adminA = await login(app, 'admin.a@example.test');
    adminB = await login(app, 'admin.b@example.test');
  }, 120_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (storageRoot) {
      rmSync(storageRoot, { recursive: true, force: true });
    }
    if (mockRoot) {
      rmSync(mockRoot, { recursive: true, force: true });
    }
  });

  it('returns 404 when admin.b sends company A object ids to every company-scoped route', async () => {
    const fx = await loadFixtures(adminA, adminB, companyA, companyB);
    const cases = sweepCases(adminB, fx);
    const discovered = companyRoutes(started());
    const swept = new Set(cases.map((item) => item.route));
    const exempt = new Map(EXEMPTIONS.map((item) => [item.route, item.reason]));
    const missing = discovered.filter((route) => !swept.has(route) && !exempt.has(route));
    const extraSweep = [...swept].filter((route) => !discovered.includes(route)).sort();
    const extraExempt = [...exempt.keys()].filter((route) => !discovered.includes(route)).sort();
    const illegalExempt = [...exempt.keys()].filter((route) => objectParams(route).length > 0).sort();
    expect({ missing, extraSweep, extraExempt, illegalExempt }).toEqual({
      missing: [],
      extraSweep: [],
      extraExempt: [],
      illegalExempt: [],
    });
    expect(cases.map((item) => item.route).filter((route) => exempt.has(route))).toEqual([]);

    for (const item of cases) {
      const before = await item.snap();
      const correlationId = cid(item.name);
      const response = await item.call(correlationId);
      expect(response.status, `${item.name} ${text(response)}`).toBe(404);
      const events = await auditEvents(item.auditCompany, correlationId);
      const denial = events.find((event) => event.action === 'authorization.denied');
      expect(denial, `${item.name} audit`).toEqual(
        expect.objectContaining({
          action: 'authorization.denied',
          outcome: 'denied',
          correlationId,
        }),
      );
      expect(detailReason(denial?.details), item.name).not.toBe('');
      expect(await item.snap(), item.name).toBe(before);
    }
  }, 120_000);
});

type Fixtures = {
  companyA: string;
  companyB: string;
  adminBUserId: string;
  clientA: string;
  contactA: string;
  addressA: string;
  clientB: string;
  productA: string;
  taxA: string;
  seriesA: string;
  bankA: string;
  companyBVersion: number;
  invoiceA: string;
  orderA: string;
  printA: string;
  fileA: string;
  templateA: string;
  membershipA: string;
  identityA: string;
  locationA: string;
  brandA: string;
  storeA: string;
  printerA: string;
  connectionA: string;
  tokenB: string;
};

async function loadFixtures(adminA: Session, adminB: Session, companyA: string, companyB: string): Promise<Fixtures> {
  const adminBUserId = (
    await started().get(PrismaService).client.userAccount.findFirstOrThrow({ where: { email: 'admin.b@example.test' } })
  ).id;
  const createdA = await send(adminA, 'post', `/api/c/${companyA}/clients`, cid('fix-client-a'), {
    kind: 'organisation',
    displayName: `Iso client A ${runId}`,
    contacts: [{ name: 'Ada Iso', isPrimary: true }],
    addresses: [{ kind: 'billing', line1: '1 Iso Road', city: 'Nicosia', countryCode: 'CY', isDefault: true }],
  });
  const clientBody = record(record(expectOk(createdA, 'client A')).client);
  const clientA = stringField(clientBody, 'id');
  const contactA = stringField(record(arrayOf(clientBody.contacts)[0]), 'id');
  const addressA = stringField(record(arrayOf(clientBody.addresses)[0]), 'id');
  const createdB = await send(adminB, 'post', `/api/c/${companyB}/clients`, cid('fix-client-b'), {
    kind: 'organisation',
    displayName: `Iso client B ${runId}`,
    contacts: [{ name: 'Bea Iso', isPrimary: true }],
    addresses: [{ kind: 'billing', line1: '2 Iso Road', city: 'Limassol', countryCode: 'CY', isDefault: true }],
  });
  const clientB = stringField(record(record(expectOk(createdB, 'client B')).client), 'id');
  const taxA = await inCompany(companyA, (tx) =>
    tx.taxCode.findFirstOrThrow({ where: { companyId: companyA, code: 'STD19' }, select: { id: true } }),
  );
  const product = await send(adminA, 'post', `/api/c/${companyA}/products`, cid('fix-product'), {
    sku: `ISO-${runId}`,
    name: `Iso product ${runId}`,
    kind: 'product',
    unit: 'ea',
    unitPrice: '1.0000',
    pricesIncludeTax: false,
    taxCodeId: taxA.id,
  });
  const productA = stringField(record(record(expectOk(product, 'product')).product), 'id');
  const invoice = await send(adminA, 'post', `/api/c/${companyA}/invoices`, cid('fix-invoice'), {
    clientId: clientA,
    pricesIncludeTax: false,
    lines: [line(taxA.id)],
  });
  const invoiceA = stringField(record(record(expectOk(invoice, 'invoice')).invoice), 'id');
  const store = await inCompany(companyA, (tx) =>
    tx.store.findFirstOrThrow({ where: { companyId: companyA, name: 'Nutbox Demo Shopify' }, select: { id: true } }),
  );
  const connection = await inCompany(companyA, (tx) =>
    tx.storeConnection.findFirstOrThrow({
      where: { companyId: companyA, storeId: store.id, status: 'active', mode: 'mock' },
      select: { id: true },
    }),
  );
  const orderA = await inCompany(companyA, async (tx) => {
    const order = await tx.salesOrder.create({
      data: {
        companyId: companyA,
        storeId: store.id,
        connectionId: connection.id,
        externalId: `iso-${runId}`,
        externalNumber: `#ISO-${runId}`,
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
        giftMessage: 'Hello gift',
        recipient: { firstName: 'Ada', lastName: 'Iso' },
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
  });
  const printed = await send(adminA, 'post', `/api/c/${companyA}/print-requests`, cid('fix-print'), {
    documentType: 'gift_message',
    sourceType: 'order',
    sourceId: orderA,
  });
  const printJob = record(record(expectOk(printed, 'print')).printJob);
  const template = await inCompany(companyA, (tx) =>
    tx.giftMessageTemplate.findFirstOrThrow({
      where: { companyId: companyA, isDefault: true },
      select: { id: true },
    }),
  );
  const membership = await inCompany(companyA, (tx) =>
    tx.membership.findFirstOrThrow({
      where: { companyId: companyA, userId: adminUserId },
      select: { id: true },
    }),
  );
  const identity = await send(adminA, 'post', `/api/c/${companyA}/service-identities`, cid('fix-token-a'), {
    name: `iso-a-${runId}`,
    purpose: 'isolation sweep',
    permissions: ['store.events.ingest'],
  });
  const identityBody = expectOk(identity, 'identity A');
  const tokenBResponse = await send(adminB, 'post', `/api/c/${companyB}/service-identities`, cid('fix-token-b'), {
    name: `iso-b-${runId}`,
    purpose: 'isolation sweep',
    permissions: ['store.events.ingest'],
  });
  const printer = await inCompany(companyA, (tx) =>
    tx.printer.findFirstOrThrow({
      where: { companyId: companyA, externalPrinterId: 'mock-laserjet-online' },
      select: { id: true, locationId: true },
    }),
  );
  const seriesA = await inCompany(companyA, (tx) =>
    tx.invoiceSeries.findFirstOrThrow({ where: { companyId: companyA, code: 'INV' }, select: { id: true } }),
  );
  const bank = await send(adminA, 'post', `/api/c/${companyA}/bank-accounts`, cid('fix-bank'), {
    bankName: `Iso bank ${runId}`,
    accountHolder: 'Demo Company A Ltd (fictional)',
    iban: 'CY17 0020 0128 0000 0012 0052 7600',
  });
  const companyBRow = await inCompany(companyB, (tx) =>
    tx.company.findUniqueOrThrow({ where: { id: companyB }, select: { version: true } }),
  );
  return {
    companyA,
    companyB,
    adminBUserId,
    seriesA: seriesA.id,
    bankA: stringField(record(record(expectOk(bank, 'bank account')).bankAccount), 'id'),
    companyBVersion: companyBRow.version,
    clientA,
    contactA,
    addressA,
    clientB,
    productA,
    taxA: taxA.id,
    invoiceA,
    orderA,
    printA: stringField(printJob, 'id'),
    fileA: stringField(printJob, 'fileId'),
    templateA: template.id,
    membershipA: membership.id,
    identityA: stringField(record(identityBody.identity), 'id'),
    locationA: printer.locationId,
    brandA: (
      await inCompany(companyA, (tx) =>
        tx.brand.findFirstOrThrow({
          where: { companyId: companyA, name: 'Nutbox (demo)' },
          select: { id: true },
        }),
      )
    ).id,
    storeA: store.id,
    printerA: printer.id,
    connectionA: connection.id,
    tokenB: stringField(expectOk(tokenBResponse, 'identity B'), 'token'),
  };
}

function sweepCases(adminB: Session, fx: Fixtures): SweepCase[] {
  const onB = (name: string, route: string, method: Method, url: string, snap: Snap, body?: unknown): SweepCase => ({
    name,
    route,
    auditCompany: fx.companyB,
    snap,
    call: (correlationId) => send(adminB, method, url, correlationId, body),
  });
  const b = (suffix: string): string => `/api/c/${fx.companyB}${suffix}`;
  const lineBody = [line(fx.taxA)];
  return [
    onB('member-get', 'GET /api/c/:companyId/members/:membershipId', 'get', b(`/members/${fx.membershipA}`), () =>
      membershipSnap(fx),
    ),
    onB(
      'member-patch',
      'PATCH /api/c/:companyId/members/:membershipId',
      'patch',
      b(`/members/${fx.membershipA}`),
      () => membershipSnap(fx),
      { status: 'suspended' },
    ),
    onB(
      'member-revoke',
      'POST /api/c/:companyId/members/:membershipId/revoke-sessions',
      'post',
      b(`/members/${fx.membershipA}/revoke-sessions`),
      () => membershipSnap(fx, true),
    ),
    onB('client-get', 'GET /api/c/:companyId/clients/:id', 'get', b(`/clients/${fx.clientA}`), () => clientSnap(fx)),
    onB(
      'client-patch',
      'PATCH /api/c/:companyId/clients/:id',
      'patch',
      b(`/clients/${fx.clientA}`),
      () => clientSnap(fx),
      { expectedVersion: 0, displayName: 'Stolen name' },
    ),
    onB(
      'client-post-contact',
      'POST /api/c/:companyId/clients',
      'post',
      b('/clients'),
      () => contactSnap(fx),
      {
        kind: 'organisation',
        displayName: `Stolen contact ${runId}`,
        contacts: [{ id: fx.contactA, name: 'Stolen', isPrimary: true }],
      },
    ),
    onB(
      'client-post-address',
      'POST /api/c/:companyId/clients',
      'post',
      b('/clients'),
      () => addressSnap(fx),
      {
        kind: 'organisation',
        displayName: `Stolen address ${runId}`,
        addresses: [
          {
            id: fx.addressA,
            kind: 'billing',
            line1: 'Stolen road',
            city: 'Limassol',
            countryCode: 'CY',
            isDefault: true,
          },
        ],
      },
    ),
    onB(
      'contact-patch',
      'PATCH /api/c/:companyId/clients/:id',
      'patch',
      b(`/clients/${fx.clientB}`),
      () => contactSnap(fx),
      { expectedVersion: 0, contacts: [{ id: fx.contactA, name: 'Stolen', isPrimary: true }] },
    ),
    onB(
      'address-patch',
      'PATCH /api/c/:companyId/clients/:id',
      'patch',
      b(`/clients/${fx.clientB}`),
      () => addressSnap(fx),
      {
        expectedVersion: 0,
        addresses: [
          {
            id: fx.addressA,
            kind: 'billing',
            line1: 'Stolen road',
            city: 'Limassol',
            countryCode: 'CY',
            isDefault: true,
          },
        ],
      },
    ),
    onB(
      'product-post',
      'POST /api/c/:companyId/products',
      'post',
      b('/products'),
      () => taxSnap(fx),
      {
        name: 'Stolen product',
        kind: 'product',
        unit: 'ea',
        unitPrice: '1.0000',
        pricesIncludeTax: false,
        taxCodeId: fx.taxA,
      },
    ),
    onB(
      'product-patch',
      'PATCH /api/c/:companyId/products/:id',
      'patch',
      b(`/products/${fx.productA}`),
      () => productSnap(fx),
      { name: 'Stolen product' },
    ),
    onB(
      'invoice-preview',
      'POST /api/c/:companyId/invoices/preview-totals',
      'post',
      b('/invoices/preview-totals'),
      () => taxSnap(fx),
      { pricesIncludeTax: false, lines: lineBody },
    ),
    onB(
      'invoice-post',
      'POST /api/c/:companyId/invoices',
      'post',
      b('/invoices'),
      () => invoiceCreateSnap(fx),
      { clientId: fx.clientA, pricesIncludeTax: false, lines: lineBody },
    ),
    onB('invoice-get', 'GET /api/c/:companyId/invoices/:id', 'get', b(`/invoices/${fx.invoiceA}`), () =>
      invoiceSnap(fx),
    ),
    onB('invoice-pdf', 'GET /api/c/:companyId/invoices/:id/pdf', 'get', b(`/invoices/${fx.invoiceA}/pdf`), () =>
      invoiceSnap(fx),
    ),
    onB(
      'credit-note-create',
      'POST /api/c/:companyId/invoices/:id/credit-notes',
      'post',
      b(`/invoices/${fx.invoiceA}/credit-notes`),
      () => invoiceSnap(fx),
      { reason: 'stolen', full: true },
    ),
    onB(
      'credit-note-patch',
      'PATCH /api/c/:companyId/credit-notes/:id',
      'patch',
      b(`/credit-notes/${fx.invoiceA}`),
      () => invoiceSnap(fx),
      { expectedVersion: 0, reason: 'stolen' },
    ),
    onB(
      'quote-convert',
      'POST /api/c/:companyId/quotes/:id/convert',
      'post',
      b(`/quotes/${fx.invoiceA}/convert`),
      () => invoiceSnap(fx),
      {},
    ),
    onB(
      'invoice-delivery',
      'POST /api/c/:companyId/invoices/:id/deliveries',
      'post',
      b(`/invoices/${fx.invoiceA}/deliveries`),
      () => invoiceSnap(fx),
      { method: 'other', deliveredOn: '2026-10-28' },
    ),
    onB(
      'invoice-issue',
      'POST /api/c/:companyId/invoices/:id/issue',
      'post',
      b(`/invoices/${fx.invoiceA}/issue`),
      () => invoiceSnap(fx),
      { expectedVersion: 0 },
    ),
    onB(
      'invoice-patch',
      'PATCH /api/c/:companyId/invoices/:id',
      'patch',
      b(`/invoices/${fx.invoiceA}`),
      () => invoiceSnap(fx),
      { expectedVersion: 0, reference: 'stolen' },
    ),
    onB('order-get', 'GET /api/c/:companyId/orders/:id', 'get', b(`/orders/${fx.orderA}`), () => orderSnap(fx)),
    onB(
      'order-assignees',
      'GET /api/c/:companyId/orders/:id/assignees',
      'get',
      b(`/orders/${fx.orderA}/assignees`),
      () => orderSnap(fx),
    ),
    onB('order-activity', 'GET /api/c/:companyId/orders/:id/activity', 'get', b(`/orders/${fx.orderA}/activity`), () =>
      orderSnap(fx),
    ),
    onB(
      'order-transition',
      'POST /api/c/:companyId/orders/:id/transitions',
      'post',
      b(`/orders/${fx.orderA}/transitions`),
      () => orderSnap(fx),
      { to: 'preparing', expectedVersion: 1 },
    ),
    onB(
      'order-note',
      'POST /api/c/:companyId/orders/:id/notes',
      'post',
      b(`/orders/${fx.orderA}/notes`),
      () => orderSnap(fx),
      { body: 'stolen note' },
    ),
    onB(
      'order-assign',
      'POST /api/c/:companyId/orders/:id/assign',
      'post',
      b(`/orders/${fx.orderA}/assign`),
      () => orderSnap(fx),
      { userId: fx.adminBUserId, expectedVersion: 1 },
    ),
    onB(
      'packing-slip',
      'GET /api/c/:companyId/orders/:id/documents/packing-slip.pdf',
      'get',
      b(`/orders/${fx.orderA}/documents/packing-slip.pdf`),
      () => orderSnap(fx),
    ),
    onB(
      'gift-pdf',
      'GET /api/c/:companyId/orders/:id/documents/gift-message.pdf',
      'get',
      b(`/orders/${fx.orderA}/documents/gift-message.pdf`),
      () => orderSnap(fx),
    ),
    onB('file-get', 'GET /api/c/:companyId/files/:id', 'get', b(`/files/${fx.fileA}`), () => fileSnap(fx)),
    onB(
      'template-patch',
      'PATCH /api/c/:companyId/gift-message-templates/:id',
      'patch',
      b(`/gift-message-templates/${fx.templateA}`),
      () => templateSnap(fx),
      { name: 'Stolen template' },
    ),
    onB(
      'template-preview',
      'POST /api/c/:companyId/gift-message-templates/:id/preview',
      'post',
      b(`/gift-message-templates/${fx.templateA}/preview`),
      () => templateSnap(fx),
      { text: 'Hello' },
    ),
    onB(
      'print-request',
      'POST /api/c/:companyId/print-requests',
      'post',
      b('/print-requests'),
      () => orderSnap(fx),
      { documentType: 'gift_message', sourceType: 'order', sourceId: fx.orderA },
    ),
    onB('print-get', 'GET /api/c/:companyId/print-jobs/:id', 'get', b(`/print-jobs/${fx.printA}`), () =>
      printSnap(fx),
    ),
    onB(
      'print-confirm',
      'POST /api/c/:companyId/print-jobs/:id/confirm',
      'post',
      b(`/print-jobs/${fx.printA}/confirm`),
      () => printSnap(fx),
      { outcome: 'printed' },
    ),
    onB(
      'print-release',
      'POST /api/c/:companyId/print-jobs/:id/release',
      'post',
      b(`/print-jobs/${fx.printA}/release`),
      () => printSnap(fx),
    ),
    onB(
      'print-cancel',
      'POST /api/c/:companyId/print-jobs/:id/cancel',
      'post',
      b(`/print-jobs/${fx.printA}/cancel`),
      () => printSnap(fx),
    ),
    onB(
      'printer-discover',
      'POST /api/c/:companyId/printers/discover',
      'post',
      b('/printers/discover'),
      () => printerSnap(fx),
      { locationId: fx.locationA },
    ),
    onB(
      'printer-mapping',
      'PUT /api/c/:companyId/printer-mappings',
      'put',
      b('/printer-mappings'),
      () => mappingSnap(fx),
      {
        locationId: fx.locationA,
        documentType: 'gift_message',
        printerId: fx.printerA,
        paperSize: 'A6',
        copies: 1,
      },
    ),
    {
      name: 'order-filters',
      route: 'GET /api/c/:companyId/order-filters',
      auditCompany: fx.companyA,
      snap: () => storeSnap(fx),
      call: (correlationId) => send(adminB, 'get', `/api/c/${fx.companyA}/order-filters`, correlationId),
    },
    {
      name: 'switch-put',
      route: 'PUT /api/c/:companyId/automation/switches/:key',
      auditCompany: fx.companyA,
      snap: () => switchSnap(fx),
      call: (correlationId) =>
        send(adminB, 'put', `/api/c/${fx.companyA}/automation/switches/printing`, correlationId, {
          enabled: false,
          reason: 'isolation sweep must not apply',
        }),
    },
    onB(
      'service-identity-delete',
      'DELETE /api/c/:companyId/service-identities/:id',
      'delete',
      b(`/service-identities/${fx.identityA}`),
      () => identitySnap(fx),
    ),
    onB(
      'tax-code-patch',
      'PATCH /api/c/:companyId/tax-codes/:id',
      'patch',
      b(`/tax-codes/${fx.taxA}`),
      () => financeSnap(fx),
      { expectedVersion: 0, name: 'Stolen tax code' },
    ),
    onB(
      'series-patch',
      'PATCH /api/c/:companyId/invoice-series/:id',
      'patch',
      b(`/invoice-series/${fx.seriesA}`),
      () => financeSnap(fx),
      { expectedVersion: 0, prefix: 'STOLEN-' },
    ),
    onB(
      'bank-account-patch',
      'PATCH /api/c/:companyId/bank-accounts/:id',
      'patch',
      b(`/bank-accounts/${fx.bankA}`),
      () => financeSnap(fx),
      { expectedVersion: 0, bankName: 'Stolen bank' },
    ),
    onB(
      'company-patch-default-series',
      'PATCH /api/c/:companyId/company',
      'patch',
      b('/company'),
      () => financeSnap(fx),
      { expectedVersion: fx.companyBVersion, defaultInvoiceSeriesId: fx.seriesA },
    ),
    onB(
      'brand-patch',
      'PATCH /api/c/:companyId/brands/:id',
      'patch',
      b(`/brands/${fx.brandA}`),
      () => setupSnap(fx),
      { name: 'Stolen brand' },
    ),
    onB(
      'location-patch',
      'PATCH /api/c/:companyId/locations/:id',
      'patch',
      b(`/locations/${fx.locationA}`),
      () => setupSnap(fx),
      { name: 'Stolen location' },
    ),
    onB('store-get', 'GET /api/c/:companyId/stores/:id', 'get', b(`/stores/${fx.storeA}`), () => setupSnap(fx)),
    onB(
      'store-post',
      'POST /api/c/:companyId/stores',
      'post',
      b('/stores'),
      () => setupSnap(fx),
      {
        name: `Stolen store ${runId}`,
        platform: 'prestashop',
        brandId: fx.brandA,
        locationId: fx.locationA,
      },
    ),
    onB(
      'store-patch',
      'PATCH /api/c/:companyId/stores/:id',
      'patch',
      b(`/stores/${fx.storeA}`),
      () => setupSnap(fx),
      { name: 'Stolen store' },
    ),
    onB(
      'prestashop-get',
      'GET /api/c/:companyId/stores/:storeId/prestashop-connection',
      'get',
      b(`/stores/${fx.storeA}/prestashop-connection`),
      () => prestashopSnap(fx),
    ),
    onB(
      'prestashop-put',
      'PUT /api/c/:companyId/stores/:storeId/prestashop-connection',
      'put',
      b(`/stores/${fx.storeA}/prestashop-connection`),
      () => prestashopSnap(fx),
      {
        baseUrl: 'https://shop.example.test',
        timezone: 'Asia/Nicosia',
        firstImportFrom: '2026-01-01 00:00:00',
      },
    ),
    onB(
      'prestashop-test',
      'POST /api/c/:companyId/stores/:storeId/prestashop-connection/test',
      'post',
      b(`/stores/${fx.storeA}/prestashop-connection/test`),
      () => prestashopSnap(fx),
      {},
    ),
    onB(
      'prestashop-states',
      'GET /api/c/:companyId/stores/:storeId/prestashop-connection/order-states',
      'get',
      b(`/stores/${fx.storeA}/prestashop-connection/order-states`),
      () => prestashopSnap(fx),
    ),
    onB(
      'prestashop-carriers',
      'GET /api/c/:companyId/stores/:storeId/prestashop-connection/carriers',
      'get',
      b(`/stores/${fx.storeA}/prestashop-connection/carriers`),
      () => prestashopSnap(fx),
    ),
    onB(
      'prestashop-maps',
      'PUT /api/c/:companyId/stores/:storeId/prestashop-connection/maps',
      'put',
      b(`/stores/${fx.storeA}/prestashop-connection/maps`),
      () => prestashopSnap(fx),
      { stateMap: {}, carrierMap: {} },
    ),
    onB(
      'prestashop-activate',
      'POST /api/c/:companyId/stores/:storeId/prestashop-connection/activate',
      'post',
      b(`/stores/${fx.storeA}/prestashop-connection/activate`),
      () => prestashopSnap(fx),
      {},
    ),
    onB(
      'prestashop-pause',
      'POST /api/c/:companyId/stores/:storeId/prestashop-connection/pause',
      'post',
      b(`/stores/${fx.storeA}/prestashop-connection/pause`),
      () => prestashopSnap(fx),
      {},
    ),
    {
      name: 'store-event',
      route: 'POST /api/automation/v1/c/:companyId/store-connections/:connectionId/events',
      auditCompany: fx.companyB,
      snap: () => connectionSnap(fx),
      call: (correlationId) =>
        request(started().getHttpServer() as App)
          .post(`/api/automation/v1/c/${fx.companyB}/store-connections/${fx.connectionA}/events`)
          .set('Authorization', `Bearer ${fx.tokenB}`)
          .set('X-Correlation-Id', correlationId)
          .send({
            eventId: `iso-event-${runId}`,
            topic: 'orders/updated',
            occurredAt: '2026-10-21T12:00:00.000Z',
            payload: { id: 'not-used', updatedAt: '2026-10-21T12:00:00.000Z' },
          }),
    },
  ];
}

function line(taxCodeId: string) {
  return {
    position: 1,
    description: 'Line',
    quantity: '1',
    unit: 'ea',
    unitPrice: '1.0000',
    discountPercent: '0',
    taxCodeId,
  };
}

function companyRoutes(application: INestApplication): string[] {
  const server = application.getHttpAdapter().getInstance() as { router?: { stack?: ExpressLayer[] } };
  const stack = server.router?.stack;
  if (!stack) {
    throw new Error('the Nest HTTP router has no stack');
  }
  const found: string[] = [];
  walk(stack, '', found);
  return [...new Set(found)].filter((route) => route.includes('/c/:companyId')).sort();
}

function walk(stack: ExpressLayer[], prefix: string, found: string[]): void {
  for (const layer of stack) {
    const route = layer.route;
    if (route?.methods && typeof route.path === 'string') {
      const path = normalisePath(`${prefix}${route.path}`);
      for (const [method, enabled] of Object.entries(route.methods)) {
        if (!enabled) {
          continue;
        }
        const verb = method.toUpperCase();
        if (!VERBS.has(verb)) {
          continue;
        }
        found.push(`${verb} ${path}`);
      }
      continue;
    }
    const nested = layer.handle?.stack;
    if (nested) {
      const mount = typeof layer.path === 'string' ? layer.path : '';
      walk(nested, `${prefix}${mount}`, found);
    }
  }
}

function normalisePath(path: string): string {
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  const collapsed = withSlash.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
}

function objectParams(route: string): string[] {
  const path = route.slice(route.indexOf(' ') + 1);
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)]
    .map((match) => match[1] ?? '')
    .filter((name) => name !== 'companyId');
}

function clientSnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT version::text, display_name
      FROM client
      WHERE id = ${fx.clientA}::uuid
    `,
  );
}

function contactSnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT c.version::text AS client_version, ct.name
      FROM client_contact ct
      JOIN client c ON c.id = ct.client_id
      WHERE ct.id = ${fx.contactA}::uuid
    `,
  );
}

function addressSnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT c.version::text AS client_version, a.line1
      FROM client_address a
      JOIN client c ON c.id = a.client_id
      WHERE a.id = ${fx.addressA}::uuid
    `,
  );
}

function productSnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT name, unit_price::text
      FROM product
      WHERE id = ${fx.productA}::uuid
    `,
  );
}

function taxSnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT
        (SELECT rate_percent::text FROM tax_code WHERE id = ${fx.taxA}::uuid) AS rate,
        (SELECT count(*)::int FROM product WHERE company_id = ${fx.companyA}::uuid) AS products
    `,
  );
}

function financeSnap(fx: Fixtures): Promise<string> {
  return Promise.all([
    rows(
      fx.companyA,
      (tx) => tx.$queryRaw`
        SELECT
          (SELECT version::text || ':' || name || ':' || rate_percent::text FROM tax_code WHERE id = ${fx.taxA}::uuid) AS tax,
          (SELECT version::text || ':' || prefix || ':' || active::text FROM invoice_series WHERE id = ${fx.seriesA}::uuid) AS series,
          (SELECT version::text || ':' || bank_name FROM company_bank_account WHERE id = ${fx.bankA}::uuid) AS bank
      `,
    ),
    rows(
      fx.companyB,
      (tx) => tx.$queryRaw`
        SELECT version::text, default_invoice_series_id::text AS series
        FROM company
        WHERE id = ${fx.companyB}::uuid
      `,
    ),
  ]).then((parts) => JSON.stringify(parts));
}

function invoiceSnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT version::text, status::text, total::text, reference
      FROM invoice
      WHERE id = ${fx.invoiceA}::uuid
    `,
  );
}

function invoiceCreateSnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT
        (SELECT version::text FROM client WHERE id = ${fx.clientA}::uuid) AS client_version,
        (SELECT count(*)::int FROM invoice WHERE company_id = ${fx.companyA}::uuid) AS invoices
    `,
  );
}

function setupSnap(fx: Fixtures): Promise<string> {
  return Promise.all([
    rows(
      fx.companyA,
      (tx) => tx.$queryRaw`
        SELECT name, archived_at::text AS archived_at
        FROM brand
        WHERE id = ${fx.brandA}::uuid
      `,
    ),
    rows(
      fx.companyA,
      (tx) => tx.$queryRaw`
        SELECT name, archived_at::text AS archived_at
        FROM location
        WHERE id = ${fx.locationA}::uuid
      `,
    ),
    rows(
      fx.companyA,
      (tx) => tx.$queryRaw`
        SELECT name, platform::text, status
        FROM store
        WHERE id = ${fx.storeA}::uuid
      `,
    ),
    rows(
      fx.companyB,
      (tx) => tx.$queryRaw`
        SELECT count(*)::int AS stores
        FROM store
        WHERE company_id = ${fx.companyB}::uuid
      `,
    ),
  ]).then((parts) => JSON.stringify(parts));
}

function storeSnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT id::text, name, platform::text
      FROM store
      WHERE company_id = ${fx.companyA}::uuid
      ORDER BY id
    `,
  );
}

function orderSnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT version::text,
             fulfilment_status::text,
             assigned_to_user_id::text,
             gift_message,
             (SELECT count(*)::int FROM order_note WHERE order_id = sales_order.id) AS notes,
             (SELECT count(*)::int FROM print_job WHERE source_id = sales_order.id) AS prints
      FROM sales_order
      WHERE id = ${fx.orderA}::uuid
    `,
  );
}

function printSnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT status::text, last_error
      FROM print_job
      WHERE id = ${fx.printA}::uuid
    `,
  );
}

function fileSnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT sha256, size_bytes::text
      FROM stored_file
      WHERE id = ${fx.fileA}::uuid
    `,
  );
}

function templateSnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT name, is_default
      FROM gift_message_template
      WHERE id = ${fx.templateA}::uuid
    `,
  );
}

function printerSnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT id::text, name, location_id::text, last_seen_at::text
      FROM printer
      WHERE company_id = ${fx.companyA}::uuid
      ORDER BY id
    `,
  );
}

function mappingSnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT id::text, location_id::text, document_type::text, printer_id::text, paper_size, copies::text
      FROM printer_mapping
      WHERE company_id = ${fx.companyA}::uuid
      ORDER BY id
    `,
  );
}

function switchSnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT enabled::text, reason, updated_at::text
      FROM automation_switch
      WHERE company_id = ${fx.companyA}::uuid AND key = 'printing'
    `,
  );
}

function identitySnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT status::text, revoked_at::text
      FROM service_identity
      WHERE id = ${fx.identityA}::uuid
    `,
  );
}

function prestashopSnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT
        (SELECT count(*)::int FROM store_connection WHERE store_id = ${fx.storeA}::uuid) AS connections,
        (
          SELECT count(*)::int FROM integration_credential
          WHERE company_id = ${fx.companyA}::uuid AND provider = 'prestashop'
        ) AS credentials
    `,
  );
}

function connectionSnap(fx: Fixtures): Promise<string> {
  return rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT
        (SELECT status::text FROM store_connection WHERE id = ${fx.connectionA}::uuid) AS status,
        (SELECT count(*)::int FROM integration_inbox WHERE connection_id = ${fx.connectionA}::uuid) AS inbox
    `,
  );
}

async function membershipSnap(fx: Fixtures, sessions = false): Promise<string> {
  const status = await rows(
    fx.companyA,
    (tx) => tx.$queryRaw`
      SELECT status::text
      FROM membership
      WHERE id = ${fx.membershipA}::uuid
    `,
  );
  if (!sessions) {
    return status;
  }
  const open = await started().get(PrismaService).client.userSession.count({
    where: { userId: adminUserId, revokedAt: null },
  });
  return JSON.stringify({ status, open });
}

function rows(companyId: string, query: (tx: TenantTransaction) => Promise<unknown>): Promise<string> {
  return inCompany(companyId, query).then((value) => JSON.stringify(value));
}

function inCompany<T>(companyId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return new TenantDb(started().get(PrismaService).client).run(
    { companyId, actor: adminUserId || 'isolation-test', correlationId: `iso-db-${runId}` },
    fn,
  );
}

function expectOk(response: request.Response, label: string): Record<string, unknown> {
  expect(response.status, `${label} ${text(response)}`).toBe(200);
  return record(response.body);
}

async function auditEvents(companyId: string, correlationId: string) {
  const prisma = started().get(PrismaService);
  return prisma.client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform_scope', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.company_id', ${companyId}, true)`;
    return tx.auditEvent.findMany({ where: { correlationId }, orderBy: { occurredAt: 'asc' } });
  });
}

function detailReason(details: unknown): string {
  if (!isRecord(details)) {
    return '';
  }
  return typeof details.reason === 'string' ? details.reason : '';
}

function cid(name: string): string {
  return `iso-${name}-${runId}`.slice(0, 64);
}

function send(session: Session, method: Method, url: string, correlationId: string, payload?: unknown) {
  const call = session.agent[method](url).set('X-XSRF-TOKEN', session.xsrf).set('X-Correlation-Id', correlationId);
  if (payload !== undefined) {
    call.send(payload as object);
  }
  return call;
}

async function login(application: INestApplication, email: string): Promise<Session> {
  const agent = request.agent(application.getHttpServer() as App);
  const response = await agent.post('/api/auth/dev/login').send({ email });
  expect(response.status, text(response)).toBe(200);
  return { agent, xsrf: cookieValue(cookieHeader(response, 'XSRF-TOKEN'), 'XSRF-TOKEN') };
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

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`${key} is missing`);
  }
  return field;
}

function arrayOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('expected an array');
  }
  return value;
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
