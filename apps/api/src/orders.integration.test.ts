import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { shopifyFixturesDirectory } from '@bp/integrations';
import { Logger } from 'nestjs-pino';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertDatabaseNameIsTest,
  assertEnvConnectionsTargetTestDatabase,
  assertTestDatabaseUrls,
} from '../../../tools/test-db-guard.mjs';
import { AppModule } from './app.module';
import { InboxProcessor } from './automation/inbox.processor';
import { InboxService } from './automation/inbox.service';
import { type ClaimedJob, JobRunner } from './automation/jobs/job-runner';
import { correlationStorage } from './correlation/correlation';
import { PrismaService } from './database/prisma.service';
import { PRESTASHOP_MILESTONE_EXTERNAL_ID } from './demo-import-args';
import { ensurePrestashopOrder, PRESTASHOP_GIFT } from './demo-prestashop-order';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { LOG_STREAM } from './logging/logging.module';

const COMPANY_A = 'Demo Company A Ltd (fictional)';
const COMPANY_B = 'Demo Company B Ltd (fictional)';
const GREEK_GIFT = 'Χρόνια πολλά, Μαρία!\n\nΜε αγάπη, \nΓιώργος & Ελένη — «καλή χρονιά»';
const runId = randomUUID().slice(0, 8);

type Agent = ReturnType<typeof request.agent>;
type Session = { agent: Agent; xsrf: string };
type Method = 'get' | 'post' | 'delete';
type Topic = 'orders/create' | 'orders/updated';

let app: INestApplication | undefined;

const paidFixture = loadFixture('order-1001-paid-greek-gift.json');
const laterFixture = loadFixture('order-1001-updated-later.json');
const earlierFixture = loadFixture('order-1001-updated-earlier.json');
const pendingFixture = loadFixture('order-1002-pending-international.json');
const emojiFixture = loadFixture('order-1003-emoji-gift.json');
const companyBFixture = loadFixture('order-2001-company-b.json');

describe('orders import and API', () => {
  let companyA = '';
  let companyB = '';
  let adminUserId = '';
  let fulfilUserId = '';
  let marketingUserId = '';
  let shopifyA = '';
  let shopifyB = '';
  let shopifyStoreA = '';
  let prestaStoreA = '';
  let prestaOrderId = '';
  let tokenA = '';
  let identityA = '';
  let tokenB = '';
  let adminA: Session;
  let adminB: Session;
  let fulfil: Session;
  let order1001 = '';

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
    const databases = await prisma.client.$queryRaw<{ current_database: string; current_user: string }[]>`
      SELECT current_database() AS current_database, current_user AS current_user
    `;
    assertDatabaseNameIsTest(databases[0]?.current_database, 'DATABASE_URL');
    expect(databases[0]?.current_user).toBe('bp_app');
    companyA = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_A } })).id;
    companyB = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_B } })).id;
    adminUserId = (await prisma.client.userAccount.findFirstOrThrow({ where: { email: 'admin.a@example.test' } })).id;
    fulfilUserId = (await prisma.client.userAccount.findFirstOrThrow({ where: { email: 'fulfil.a@example.test' } })).id;
    marketingUserId = (
      await prisma.client.userAccount.findFirstOrThrow({ where: { email: 'marketing.a@example.test' } })
    ).id;
    adminA = await login(app, 'admin.a@example.test');
    adminB = await login(app, 'admin.b@example.test');
    fulfil = await login(app, 'fulfil.a@example.test');
    await clearOrders(companyA);
    await clearOrders(companyB);
    const connected = await withCompany(companyA, async (tx) => {
      const shopify = await tx.store.findFirstOrThrow({ where: { companyId: companyA, name: 'Nutbox Demo Shopify' } });
      const presta = await tx.store.findFirstOrThrow({
        where: { companyId: companyA, name: 'Nutbox Demo PrestaShop' },
      });
      const shopifyConnection = await tx.storeConnection.findFirstOrThrow({
        where: { companyId: companyA, storeId: shopify.id, status: 'active', mode: 'mock' },
      });
      const prestaConnection = await tx.storeConnection.findFirstOrThrow({
        where: { companyId: companyA, storeId: presta.id, status: 'active', mode: 'mock' },
      });
      const created = await tx.salesOrder.create({
        data: {
          companyId: companyA,
          storeId: presta.id,
          connectionId: prestaConnection.id,
          externalId: `presta-${runId}`,
          externalNumber: '#PRESTA',
          sourcePlatform: 'prestashop',
          sourceStatus: { displayFulfillmentStatus: null, cancelledAt: null },
          sourceCreatedAt: new Date('2026-01-15T12:00:00.000Z'),
          sourceUpdatedAt: new Date('2026-01-15T12:00:00.000Z'),
          paymentStatus: 'paid',
          fulfilmentStatus: 'new',
          integrationStatus: 'synced',
          deliveryMethod: 'courier_cy',
          currency: 'EUR',
          subtotal: '1.00',
          shippingTotal: '0.00',
          taxTotal: '0.00',
          total: '1.00',
          version: 1,
          customer: { displayName: 'Presta Demo', email: 'presta.order@example.test', phone: null, id: null },
        },
      });
      return {
        shopifyStoreId: shopify.id,
        prestaStoreId: presta.id,
        shopifyConnectionId: shopifyConnection.id,
        prestaOrderId: created.id,
      };
    });
    shopifyStoreA = connected.shopifyStoreId;
    prestaStoreA = connected.prestaStoreId;
    shopifyA = connected.shopifyConnectionId;
    prestaOrderId = connected.prestaOrderId;
    shopifyB = await withCompany(companyB, async (tx) => {
      const store = await tx.store.findFirstOrThrow({
        where: { companyId: companyB, name: 'Olive Grove Demo Shopify' },
      });
      const connection = await tx.storeConnection.findFirstOrThrow({
        where: { companyId: companyB, storeId: store.id, status: 'active', mode: 'mock' },
      });
      return connection.id;
    });
    const createdA = await createToken(adminA, companyA, 'A');
    tokenA = createdA.token;
    identityA = createdA.id;
    tokenB = (await createToken(adminB, companyB, 'B')).token;
    expect(Buffer.from(giftFrom(paidFixture), 'utf8').equals(Buffer.from(GREEK_GIFT, 'utf8'))).toBe(true);
  }, 120_000);

  beforeEach(async () => {
    if (!app || companyA.length === 0) {
      return;
    }
    await app.get(PrismaService).client.job.deleteMany({
      where: { companyId: { in: [companyA, companyB] }, type: 'inbox.process' },
    });
  });

  afterAll(async () => {
    if (app) {
      app.get(InboxService).hooks = null;
      app.get(InboxProcessor).hooks = null;
      await app.close();
    }
  });

  it('imports a fixture once, counts a duplicate, and keeps the gift message bytes', async () => {
    const eventId = `c2a-${runId}-1001`;
    const correlationId = cid('import-1001');
    const first = await postEvent(tokenA, companyA, shopifyA, eventId, 'orders/create', paidFixture, correlationId);
    expect(first.status, text(first.response)).toBe(202);
    expect(record(bodyOf(first.response)).status).toBe('accepted');
    const inboxId = stringField(record(bodyOf(first.response)), 'inboxId');
    const second = await postEvent(tokenA, companyA, shopifyA, eventId, 'orders/create', paidFixture, cid('import-1001-dup'));
    expect(second.status, text(second.response)).toBe(202);
    expect(record(bodyOf(second.response))).toEqual({ inboxId, status: 'duplicate' });
    const duplicateAudit = await auditEvents(app, cid('import-1001-dup'), companyA);
    expect(duplicateAudit).toEqual([
      expect.objectContaining({
        action: 'inbox.duplicate',
        outcome: 'success',
        actorType: 'service',
        actorId: identityA,
        correlationId: cid('import-1001-dup'),
        objectType: 'integration_inbox',
        objectId: inboxId,
      }),
    ]);
    expect((await inbox(companyA, inboxId)).duplicateCount).toBe(1);
    expect(await jobCount(inboxId)).toBe(1);
    expect(await drain()).toBe(1);
    const order = await orderByNumber(adminA, companyA, '#1001');
    order1001 = stringField(order, 'id');
    expect(order.version).toBe(1);
    expect(order.paymentStatus).toBe('paid');
    expect(order.fulfilmentStatus).toBe('new');
    expect(order.deliveryMethod).toBe('courier_cy');
    expect(order.total).toBe('43.00');
    expect(record(order.recipient).phone).toBe('+35799001001');
    expect(order.customerNote).toBe('Παρακαλώ μετά τις 17:00.');
    const gift = stringField(order, 'giftMessage');
    expect(Buffer.from(gift, 'utf8').equals(Buffer.from(GREEK_GIFT, 'utf8'))).toBe(true);
    expect(arrayOf(order.lines)).toHaveLength(3);
    expect(record(order.printJobs)).toEqual({
      invoice: null,
      packing_slip: null,
      gift_message: null,
      shipping_label: null,
    });
    const imported = await auditEvents(app, correlationId, companyA);
    expect(imported.map((event) => event.action)).toEqual(['order.imported']);
    expect(imported[0]).toEqual(expect.objectContaining({ outcome: 'success', correlationId, objectId: order1001 }));
    const again = await postEvent(tokenA, companyA, shopifyA, eventId, 'orders/create', paidFixture, cid('import-1001-again'));
    expect(again.status).toBe(202);
    expect(record(bodyOf(again.response)).status).toBe('duplicate');
    expect((await inbox(companyA, inboxId)).duplicateCount).toBe(2);
    expect((await orderByNumber(adminA, companyA, '#1001')).version).toBe(1);
  });

  it('applies a newer source update and leaves a stale one untouched', async () => {
    const laterId = cid('import-1001-later');
    const later = await postEvent(tokenA, companyA, shopifyA, `c2a-${runId}-1001-later`, 'orders/updated', laterFixture, laterId);
    expect(later.status, text(later.response)).toBe(202);
    expect(await drain()).toBe(1);
    const updated = await orderByNumber(fulfil, companyA, '#1001');
    expect(updated.version).toBe(2);
    expect(record(updated.recipient).phone).toBe('+35799001002');
    expect(Buffer.from(stringField(updated, 'giftMessage'), 'utf8').equals(Buffer.from(GREEK_GIFT, 'utf8'))).toBe(true);
    expect((await auditEvents(app, laterId, companyA)).map((event) => event.action)).toEqual(['order.source_updated']);
    const before = stringField(updated, 'sourceUpdatedAt');
    const staleId = cid('import-1001-stale');
    const stale = await postEvent(
      tokenA,
      companyA,
      shopifyA,
      `c2a-${runId}-1001-earlier`,
      'orders/updated',
      earlierFixture,
      staleId,
    );
    expect(stale.status, text(stale.response)).toBe(202);
    const staleInbox = stringField(record(bodyOf(stale.response)), 'inboxId');
    expect(await drain()).toBe(1);
    expect((await inbox(companyA, staleInbox)).status).toBe('stale');
    const untouched = await orderByNumber(adminA, companyA, '#1001');
    expect(untouched.version).toBe(2);
    expect(record(untouched.recipient).phone).toBe('+35799001002');
    expect(untouched.sourceUpdatedAt).toBe(before);
    const staleAudit = await auditEvents(app, staleId, companyA);
    expect(staleAudit).toEqual([
      expect.objectContaining({
        action: 'inbox.stale',
        outcome: 'success',
        actorType: 'service',
        actorId: identityA,
        correlationId: staleId,
        objectType: 'integration_inbox',
        objectId: staleInbox,
      }),
    ]);
  });

  it('imports the other fixtures and isolates companies, stores and service identities', async () => {
    expect((await postEvent(tokenA, companyA, shopifyA, `c2a-${runId}-1002`, 'orders/create', pendingFixture)).status).toBe(202);
    expect((await postEvent(tokenA, companyA, shopifyA, `c2a-${runId}-1003`, 'orders/create', emojiFixture)).status).toBe(202);
    expect((await postEvent(tokenB, companyB, shopifyB, `c2a-${runId}-2001`, 'orders/create', companyBFixture)).status).toBe(202);
    expect(await drain()).toBe(3);
    const emoji = await orderByNumber(adminA, companyA, '#1003');
    expect(emoji.fulfilmentStatus).toBe('review_required');
    expect(emoji.reviewReason).toBe('unsupported_glyphs');
    const pending = await orderByNumber(adminA, companyA, '#1002');
    expect(pending.paymentStatus).toBe('pending');
    expect(pending.deliveryMethod).toBe('post_international');

    const fulfilList = await send(fulfil, 'get', `/api/c/${companyA}/orders?pageSize=100`);
    expect(fulfilList.status, text(fulfilList)).toBe(200);
    const fulfilOrders = ordersOf(fulfilList);
    expect(fulfilOrders.map((order) => order.storeId)).toEqual(fulfilOrders.map(() => shopifyStoreA));
    expect(names(fulfilOrders)).toEqual(['#1003', '#1002', '#1001']);
    const fulfilPresta = await send(fulfil, 'get', `/api/c/${companyA}/orders/${prestaOrderId}`, cid('fulfil-presta'));
    expect(fulfilPresta.status).toBe(404);
    expect(detailReason((await auditEvents(app, cid('fulfil-presta'), companyA))[0]?.details)).toBe('out_of_scope');
    const fulfilPrestaList = await send(fulfil, 'get', `/api/c/${companyA}/orders?storeId=${prestaStoreA}`);
    expect(fulfilPrestaList.status).toBe(200);
    expect(record(bodyOf(fulfilPrestaList)).total).toBe(0);
    const invoices = await send(fulfil, 'get', `/api/c/${companyA}/invoices`, cid('fulfil-invoices'));
    expect(invoices.status).toBe(403);
    expect(detailReason((await auditEvents(app, cid('fulfil-invoices'), companyA))[0]?.details)).toBe('permission_missing');
    const invoiceId = await send(fulfil, 'get', `/api/c/${companyA}/invoices/${order1001}`, cid('fulfil-invoice-id'));
    expect(invoiceId.status).toBe(403);
    expect(detailReason((await auditEvents(app, cid('fulfil-invoice-id'), companyA))[0]?.details)).toBe(
      'permission_missing',
    );

    const crossList = await send(adminB, 'get', `/api/c/${companyA}/orders`, cid('cross-list'));
    expect(crossList.status).toBe(404);
    expect(detailReason((await auditEvents(app, cid('cross-list'), companyA))[0]?.details)).toBe('not_a_member');
    for (const path of [
      `/api/c/${companyA}/orders/${order1001}`,
      `/api/c/${companyA}/orders/${order1001}/activity`,
    ]) {
      const denied = await send(adminB, 'get', path, cid('cross-get'));
      expect(denied.status, path).toBe(404);
    }
    expect(detailReason((await auditEvents(app, cid('cross-get'), companyA))[0]?.details)).toBe('not_a_member');
    const crossNote = await send(adminB, 'post', `/api/c/${companyA}/orders/${order1001}/notes`, cid('cross-note'), {
      body: 'hidden',
    });
    expect(crossNote.status).toBe(404);
    expect(detailReason((await auditEvents(app, cid('cross-note'), companyA))[0]?.details)).toBe('not_a_member');
    const crossTransition = await send(
      adminB,
      'post',
      `/api/c/${companyA}/orders/${order1001}/transitions`,
      cid('cross-transition'),
      { to: 'preparing', expectedVersion: 2 },
    );
    expect(crossTransition.status).toBe(404);
    expect(detailReason((await auditEvents(app, cid('cross-transition'), companyA))[0]?.details)).toBe('not_a_member');
    const companyBList = await send(adminB, 'get', `/api/c/${companyB}/orders?pageSize=100`);
    expect(names(ordersOf(companyBList))).toEqual(['#2001']);
    expect(names(ordersOf(await send(adminA, 'get', `/api/c/${companyA}/orders?pageSize=100`)))).toContain('#PRESTA');
    expect(names(ordersOf(await send(adminA, 'get', `/api/c/${companyA}/orders?pageSize=100`)))).not.toContain('#2001');

    const missing = await send(adminA, 'get', `/api/c/${companyA}/orders/${randomUUID()}`, cid('missing-order'));
    expect(missing.status).toBe(404);
    expect(detailReason((await auditEvents(app, cid('missing-order'), companyA))[0]?.details)).toBe('out_of_scope');
    const malformed = await send(adminA, 'get', `/api/c/${companyA}/orders/not-a-uuid`, cid('bad-order-id'));
    expect(malformed.status).toBe(404);
    expect(detailReason((await auditEvents(app, cid('bad-order-id'), companyA))[0]?.details)).toBe('out_of_scope');

    const otherConnection = await postEvent(
      tokenA,
      companyB,
      shopifyB,
      `c2a-${runId}-cross-connection`,
      'orders/create',
      companyBFixture,
      cid('token-on-b'),
    );
    expect(otherConnection.status).toBe(404);
    expect(detailReason((await auditEvents(app, cid('token-on-b'), companyB))[0]?.details)).toBe('service_company_mismatch');
    const wrongConnection = await postEvent(
      tokenA,
      companyA,
      shopifyB,
      `c2a-${runId}-wrong-connection`,
      'orders/create',
      paidFixture,
      cid('token-wrong-connection'),
    );
    expect(wrongConnection.status).toBe(404);
    expect(detailReason((await auditEvents(app, cid('token-wrong-connection'), companyA))[0]?.details)).toBe(
      'connection_not_found',
    );
    const badConnection = await postEvent(
      tokenA,
      companyA,
      'not-a-uuid',
      `c2a-${runId}-bad-connection`,
      'orders/create',
      paidFixture,
      cid('bad-connection'),
    );
    expect(badConnection.status).toBe(404);
    expect(detailReason((await auditEvents(app, cid('bad-connection'), companyA))[0]?.details)).toBe('connection_not_found');
    const badBody = await request(httpServer())
      .post(`/api/automation/v1/c/${companyA}/store-connections/${shopifyA}/events`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Correlation-Id', cid('bad-body'))
      .send({ eventId: '', topic: 'orders/create', occurredAt: '2026-03-01T00:00:00.000Z', payload: {} });
    expect(badBody.status).toBe(400);
    expect(await auditEvents(app, cid('bad-body'), companyA)).toEqual([]);

    const identities = await send(adminB, 'get', `/api/c/${companyB}/service-identities`);
    expect(identities.status).toBe(200);
    expect(idsOf(record(bodyOf(identities)).identities)).not.toContain(identityA);
    const hiddenIdentities = await send(adminB, 'get', `/api/c/${companyA}/service-identities`, cid('cross-identities'));
    expect(hiddenIdentities.status).toBe(404);
    expect(detailReason((await auditEvents(app, cid('cross-identities'), companyA))[0]?.details)).toBe('not_a_member');
    const revoke = await send(adminB, 'delete', `/api/c/${companyB}/service-identities/${identityA}`, cid('cross-revoke'));
    expect(revoke.status).toBe(404);
    expect(detailReason((await auditEvents(app, cid('cross-revoke'), companyB))[0]?.details)).toBe(
      'service_identity_not_found',
    );
  });

  it('filters, sorts and pages the orders fulfil.a can see', async () => {
    const listed = await send(fulfil, 'get', `/api/c/${companyA}/orders?q=${encodeURIComponent('Γιώργος')}`);
    expect(names(ordersOf(listed))).toEqual(['#1001']);
    const email = await send(
      fulfil,
      'get',
      `/api/c/${companyA}/orders?q=${encodeURIComponent('giorgos.dimitriou.order@example.test')}`,
    );
    expect(names(ordersOf(email))).toEqual(['#1001']);
    const literalPercent = await send(fulfil, 'get', `/api/c/${companyA}/orders?q=${encodeURIComponent('%')}`);
    expect(record(bodyOf(literalPercent)).total).toBe(0);
    const statuses = await send(
      fulfil,
      'get',
      `/api/c/${companyA}/orders?fulfilmentStatus[]=new&fulfilmentStatus[]=review_required&paymentStatus[]=paid`,
    );
    expect(names(ordersOf(statuses)).sort()).toEqual(['#1001', '#1003']);
    const pendingOnly = await send(fulfil, 'get', `/api/c/${companyA}/orders?paymentStatus=pending`);
    expect(names(ordersOf(pendingOnly))).toEqual(['#1002']);
    const shopifyOnly = await send(fulfil, 'get', `/api/c/${companyA}/orders?storeId=${shopifyStoreA}&pageSize=100`);
    expect(names(ordersOf(shopifyOnly))).toEqual(['#1003', '#1002', '#1001']);
    const unassigned = await send(fulfil, 'get', `/api/c/${companyA}/orders?assigned=none&pageSize=100`);
    expect(names(ordersOf(unassigned))).toEqual(['#1003', '#1002', '#1001']);
    const mine = await send(fulfil, 'get', `/api/c/${companyA}/orders?assigned=me`);
    expect(record(bodyOf(mine)).total).toBe(0);
    const day = await send(fulfil, 'get', `/api/c/${companyA}/orders?from=2026-03-01&to=2026-03-01`);
    expect(names(ordersOf(day))).toEqual(['#1001']);
    const sorted = await send(fulfil, 'get', `/api/c/${companyA}/orders?sort=externalNumber&pageSize=100`);
    expect(names(ordersOf(sorted))).toEqual(['#1001', '#1002', '#1003']);
    const page = await send(fulfil, 'get', `/api/c/${companyA}/orders?page=2&pageSize=1`);
    expect(names(ordersOf(page))).toEqual(['#1002']);
    expect(record(bodyOf(page)).total).toBe(3);
    const badPage = await send(fulfil, 'get', `/api/c/${companyA}/orders?pageSize=101`, cid('bad-page'));
    expect(badPage.status).toBe(400);
    expect(await auditEvents(app, cid('bad-page'), companyA)).toEqual([]);
    const badSort = await send(fulfil, 'get', `/api/c/${companyA}/orders?sort=drop`);
    expect(badSort.status).toBe(400);
    const badDate = await send(fulfil, 'get', `/api/c/${companyA}/orders?from=2026-13-40`);
    expect(badDate.status).toBe(400);
    const badStore = await send(fulfil, 'get', `/api/c/${companyA}/orders?storeId=not-a-uuid`);
    expect(badStore.status).toBe(400);
  });

  it('moves a paid order to ready and rejects an unsettled ready and a stale version', async () => {
    const detail = await send(fulfil, 'get', `/api/c/${companyA}/orders/${order1001}`);
    expect(detail.status, text(detail)).toBe(200);
    const before = orderOf(detail);
    expect(transitionTargets(before).sort()).toEqual(['preparing', 'review_required']);
    const preparingId = cid('to-preparing');
    const preparing = await transition(fulfil, companyA, order1001, 'preparing', 2, preparingId);
    expect(preparing.status, text(preparing)).toBe(200);
    expect(orderOf(preparing).fulfilmentStatus).toBe('preparing');
    expect(orderOf(preparing).version).toBe(3);
    expect(detailField((await auditEvents(app, preparingId, companyA))[0]?.details, 'from')).toBe('new');
    expect(detailField((await auditEvents(app, preparingId, companyA))[0]?.details, 'to')).toBe('preparing');
    const readyId = cid('to-ready');
    const ready = await transition(fulfil, companyA, order1001, 'ready', 3, readyId);
    expect(ready.status, text(ready)).toBe(200);
    expect(orderOf(ready).fulfilmentStatus).toBe('ready');
    expect(transitionTargets(orderOf(ready))).toContain('handed_to_courier');
    const stale = await transition(fulfil, companyA, order1001, 'preparing', 2, cid('stale-version'));
    expect(stale.status).toBe(409);
    expect(errorCode(bodyOf(stale))).toBe('conflict');
    const staleAudit = await auditEvents(app, cid('stale-version'), companyA);
    expect(staleAudit[0]).toEqual(expect.objectContaining({ action: 'order.transition', outcome: 'failure' }));
    expect(detailReason(staleAudit[0]?.details)).toBe('version_conflict');
    const cancel = await transition(fulfil, companyA, order1001, 'cancelled', 4, cid('fulfil-cancel'));
    expect(cancel.status).toBe(403);
    expect(detailReason((await auditEvents(app, cid('fulfil-cancel'), companyA))[0]?.details)).toBe('permission_missing');

    const pending = await orderByNumber(adminA, companyA, '#1002');
    const towardReady = await transition(adminA, companyA, stringField(pending, 'id'), 'preparing', 1, cid('pending-prep'));
    expect(towardReady.status, text(towardReady)).toBe(200);
    const blocked = await transition(adminA, companyA, stringField(pending, 'id'), 'ready', 2, cid('pending-ready'));
    expect(blocked.status).toBe(422);
    expect(errorCode(bodyOf(blocked))).toBe('payment_not_settled');
    const blockedAudit = await auditEvents(app, cid('pending-ready'), companyA);
    expect(blockedAudit[0]).toEqual(expect.objectContaining({ action: 'order.transition', outcome: 'failure' }));
    expect(detailReason(blockedAudit[0]?.details)).toBe('payment_not_settled');
    expect((await orderByNumber(adminA, companyA, '#1002')).fulfilmentStatus).toBe('preparing');
  });

  it('lets exactly one of two concurrent transitions succeed', async () => {
    const created = await importClone(paidFixture, {
      id: `gid://shopify/Order/race-tx-${runId}`,
      name: '#RACE-TX',
      updatedAt: '2026-04-10T10:00:00.000Z',
    });
    const id = stringField(created, 'id');
    const [left, right] = await Promise.all([
      transition(adminA, companyA, id, 'preparing', 1, cid('race-left')),
      transition(adminA, companyA, id, 'preparing', 1, cid('race-right')),
    ]);
    const statuses = [left.status, right.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = left.status === 200 ? left : right;
    const loser = left.status === 200 ? right : left;
    expect(orderOf(winner).version).toBe(2);
    expect(orderOf(winner).fulfilmentStatus).toBe('preparing');
    expect(errorCode(bodyOf(loser))).toBe('conflict');
    expect((await orderByNumber(adminA, companyA, '#RACE-TX')).version).toBe(2);
    const loserAudit = await auditEvents(app, left.status === 409 ? cid('race-left') : cid('race-right'), companyA);
    expect(detailReason(loserAudit[0]?.details)).toBe('version_conflict');
  });

  it('stores a note and an assignment, and shows import, transitions and notes in activity', async () => {
    const noteBody = 'Καλημέρα,\n  με το κενό. ';
    const noted = await send(fulfil, 'post', `/api/c/${companyA}/orders/${order1001}/notes`, cid('note'), {
      body: noteBody,
    });
    expect(noted.status, text(noted)).toBe(200);
    const note = record(record(bodyOf(noted)).note);
    expect(note.body).toBe(noteBody);
    expect(Buffer.from(stringField(note, 'body'), 'utf8').equals(Buffer.from(noteBody, 'utf8'))).toBe(true);
    expect((await auditEvents(app, cid('note'), companyA))[0]?.action).toBe('order.note_added');
    expect(orderOf(noted).version).toBe(4);

    const claimed = await send(fulfil, 'post', `/api/c/${companyA}/orders/${order1001}/assign`, cid('claim'), {
      userId: fulfilUserId,
      expectedVersion: 4,
    });
    expect(claimed.status, text(claimed)).toBe(200);
    expect(orderOf(claimed).assignedToUserId).toBe(fulfilUserId);
    expect(orderOf(claimed).version).toBe(5);
    expect((await auditEvents(app, cid('claim'), companyA))[0]?.action).toBe('order.claimed');
    const forbiddenAssign = await send(fulfil, 'post', `/api/c/${companyA}/orders/${order1001}/assign`, cid('assign-no'), {
      userId: adminUserId,
      expectedVersion: 5,
    });
    expect(forbiddenAssign.status).toBe(403);
    expect(detailReason((await auditEvents(app, cid('assign-no'), companyA))[0]?.details)).toBe('permission_missing');
    const marketing = await send(adminA, 'post', `/api/c/${companyA}/orders/${order1001}/assign`, cid('assign-mkt'), {
      userId: marketingUserId,
      expectedVersion: 5,
    });
    expect(marketing.status).toBe(422);
    expect(errorCode(bodyOf(marketing))).toBe('assignee_not_allowed');
    const assigned = await send(adminA, 'post', `/api/c/${companyA}/orders/${order1001}/assign`, cid('assign'), {
      userId: fulfilUserId,
      expectedVersion: 5,
    });
    expect(assigned.status, text(assigned)).toBe(200);
    expect((await auditEvents(app, cid('assign'), companyA))[0]?.action).toBe('order.assigned');
    const mine = await send(fulfil, 'get', `/api/c/${companyA}/orders?assigned=me&pageSize=100`);
    expect(names(ordersOf(mine))).toContain('#1001');

    const activity = await send(fulfil, 'get', `/api/c/${companyA}/orders/${order1001}/activity`);
    expect(activity.status, text(activity)).toBe(200);
    const events = arrayOf(record(bodyOf(activity)).events).map((event) => record(event));
    const actions = events.map((event) => stringField(event, 'action'));
    expect(actions).toEqual(expect.arrayContaining(['order.imported', 'order.source_updated', 'order.transition', 'order.note_added']));
    const times = events.map((event) => stringField(event, 'occurredAt'));
    for (let index = 1; index < times.length; index += 1) {
      const previous = times[index - 1];
      const current = times[index];
      if (previous === undefined || current === undefined) {
        throw new Error('activity time is missing');
      }
      expect(previous >= current).toBe(true);
    }
    expect(events.every((event) => stringField(event, 'correlationId').length >= 8)).toBe(true);
  });

  it('keeps T3 when the create, T2 and T3 events arrive in every order', async () => {
    const stamps = [
      { key: 'T1', updatedAt: '2026-04-01T10:00:00.000Z', phone: '+35799001101' },
      { key: 'T2', updatedAt: '2026-04-02T10:00:00.000Z', phone: '+35799001102' },
      { key: 'T3', updatedAt: '2026-04-03T10:00:00.000Z', phone: '+35799001103' },
    ] as const;
    let permutation = 0;
    for (const arrival of permutations(stamps.map((stamp) => stamp.key))) {
      permutation += 1;
      const externalId = `gid://shopify/Order/race-${runId}-${String(permutation)}`;
      const inboxIds = new Map<string, string>();
      for (const stamp of stamps) {
        const payload = cloneOrder(paidFixture);
        payload.id = externalId;
        payload.name = `#R${String(permutation)}`;
        payload.updatedAt = stamp.updatedAt;
        setPhone(payload, stamp.phone);
        const posted = await postEvent(
          tokenA,
          companyA,
          shopifyA,
          `race-${runId}-${String(permutation)}-${stamp.key}`,
          'orders/create',
          payload,
        );
        expect(posted.status, text(posted.response)).toBe(202);
        inboxIds.set(stamp.key, stringField(record(bodyOf(posted.response)), 'inboxId'));
      }
      const order = arrival.map((key) => {
        const inboxId = inboxIds.get(key);
        if (!inboxId) {
          throw new Error(`missing ${key}`);
        }
        return inboxId;
      });
      await processInArrivalOrder(order);
      const saved = await withCompany(companyA, (tx) =>
        tx.salesOrder.findMany({ where: { companyId: companyA, externalId } }),
      );
      expect(saved).toHaveLength(1);
      const row = saved[0];
      if (!row) {
        throw new Error('race order missing');
      }
      expect(record(row.recipient).phone).toBe('+35799001103');
      const rows = await withCompany(companyA, (tx) =>
        tx.integrationInbox.findMany({ where: { companyId: companyA, externalObjectId: externalId } }),
      );
      expect(rows.map((item) => item.status).every((status) => status === 'processed' || status === 'stale')).toBe(true);
      const newest = rows.find((item) => item.externalEventId.endsWith('-T3'));
      expect(newest?.status).toBe('processed');
      const processed = rows.filter((item) => item.status === 'processed').length;
      expect(row.version).toBe(processed);
      expect(await drain()).toBe(3);
    }
  }, 60_000);

  it('keeps cancelled_at_source when the cancellation and the create arrive in either order', async () => {
    const keys = ['create', 'cancel'] as const;
    let permutation = 0;
    for (const arrival of permutations([...keys])) {
      permutation += 1;
      const externalId = `gid://shopify/Order/cancel-race-${runId}-${String(permutation)}`;
      const name = `#CX${String(permutation)}`;
      const inboxIds = new Map<string, string>();
      for (const key of keys) {
        const payload = cloneOrder(paidFixture);
        payload.id = externalId;
        payload.name = name;
        if (key === 'create') {
          payload.updatedAt = '2026-05-01T10:00:00.000Z';
          payload.cancelledAt = null;
        } else {
          payload.updatedAt = '2026-05-02T10:00:00.000Z';
          payload.cancelledAt = '2026-05-02T09:00:00.000Z';
        }
        const posted = await postEvent(
          tokenA,
          companyA,
          shopifyA,
          `cancel-race-${runId}-${String(permutation)}-${key}`,
          'orders/create',
          payload,
        );
        expect(posted.status, text(posted.response)).toBe(202);
        inboxIds.set(key, stringField(record(bodyOf(posted.response)), 'inboxId'));
      }
      const order = arrival.map((key) => {
        const inboxId = inboxIds.get(key);
        if (!inboxId) {
          throw new Error(`missing ${key}`);
        }
        return inboxId;
      });
      await processInArrivalOrder(order);
      const saved = await withCompany(companyA, (tx) =>
        tx.salesOrder.findMany({ where: { companyId: companyA, externalId } }),
      );
      expect(saved).toHaveLength(1);
      const row = saved[0];
      if (!row) {
        throw new Error('cancellation race order missing');
      }
      expect(row.fulfilmentStatus).toBe('review_required');
      expect(row.reviewReason).toBe('cancelled_at_source');
      const rows = await withCompany(companyA, (tx) =>
        tx.integrationInbox.findMany({ where: { companyId: companyA, externalObjectId: externalId } }),
      );
      expect(rows.find((item) => item.externalEventId.endsWith('-cancel'))?.status).toBe('processed');
      expect(await drain()).toBe(2);
    }
  });

  it('audits a failed import in the same transaction as the inbox row', async () => {
    const correlationId = cid('import-bad');
    const payload = {
      id: `gid://shopify/Order/bad-${runId}`,
      updatedAt: '2026-06-01T10:00:00.000Z',
    };
    const posted = await postEvent(
      tokenA,
      companyA,
      shopifyA,
      `c2a-${runId}-bad`,
      'orders/create',
      payload,
      correlationId,
    );
    expect(posted.status, text(posted.response)).toBe(202);
    const inboxId = stringField(record(bodyOf(posted.response)), 'inboxId');
    expect(await drain()).toBe(1);
    expect((await inbox(companyA, inboxId)).status).toBe('failed');
    const events = await auditEvents(app, correlationId, companyA);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'inbox.failed',
        outcome: 'failure',
        actorType: 'service',
        actorId: identityA,
        correlationId,
        objectType: 'integration_inbox',
        objectId: inboxId,
      }),
    ]);
  });

  it('rolls the inbox row back when the job insert fails, so redelivery is accepted', async () => {
    const eventId = `c2a-${runId}-atomic`;
    const payload = cloneOrder(paidFixture);
    payload.id = `gid://shopify/Order/atomic-${runId}`;
    payload.name = '#ATOMIC';
    const inboxService = started().get(InboxService);
    inboxService.hooks = {
      afterInboxInsert: () => Promise.reject(new Error('injected enqueue failure')),
    };
    try {
      const failed = await postEvent(tokenA, companyA, shopifyA, eventId, 'orders/create', payload, cid('atomic-fail'));
      expect(failed.status).toBe(500);
    } finally {
      inboxService.hooks = null;
    }
    const leftover = await withCompany(companyA, (tx) =>
      tx.integrationInbox.count({ where: { companyId: companyA, externalEventId: eventId } }),
    );
    expect(leftover).toBe(0);
    const again = await postEvent(tokenA, companyA, shopifyA, eventId, 'orders/create', payload, cid('atomic-retry'));
    expect(again.status, text(again.response)).toBe(202);
    expect(record(bodyOf(again.response)).status).toBe('accepted');
    expect(await drain()).toBe(1);
    expect((await orderByNumber(adminA, companyA, '#ATOMIC')).externalId).toBe(`gid://shopify/Order/atomic-${runId}`);
  });

  it('leaves a completed or cancelled order closed and appends attention reasons', async () => {
    const completed = await importClone(paidFixture, {
      id: `gid://shopify/Order/done-${runId}`,
      name: '#DONE',
      updatedAt: '2026-04-11T10:00:00.000Z',
      shippingCode: 'collection',
    });
    let version = versionOf(completed);
    const completedId = stringField(completed, 'id');
    for (const to of ['preparing', 'ready', 'completed'] as const) {
      const moved = await transition(adminA, companyA, completedId, to, version);
      expect(moved.status, `${to} ${text(moved)}`).toBe(200);
      version = versionOf(orderOf(moved));
    }
    const cancelPayload = cloneOrder(paidFixture);
    cancelPayload.id = `gid://shopify/Order/done-${runId}`;
    cancelPayload.name = '#DONE';
    cancelPayload.updatedAt = '2026-04-12T10:00:00.000Z';
    cancelPayload.cancelledAt = '2026-04-12T09:00:00.000Z';
    setShippingCode(cancelPayload, 'collection');
    expect((await postEvent(tokenA, companyA, shopifyA, `c2a-${runId}-done-cancel`, 'orders/updated', cancelPayload)).status).toBe(
      202,
    );
    expect(await drain()).toBe(1);
    const closed = await orderByNumber(adminA, companyA, '#DONE');
    expect(closed.fulfilmentStatus).toBe('completed');
    expect(stringList(closed.attentionReasons)).toContain('cancelled_at_source');

    const cancelled = await importClone(paidFixture, {
      id: `gid://shopify/Order/stop-${runId}`,
      name: '#STOP',
      updatedAt: '2026-04-13T10:00:00.000Z',
    });
    const stopId = stringField(cancelled, 'id');
    const stopped = await transition(adminA, companyA, stopId, 'cancelled', versionOf(cancelled));
    expect(stopped.status, text(stopped)).toBe(200);
    await withCompany(companyA, async (tx) => {
      const printer = await tx.printer.findFirstOrThrow({
        where: { companyId: companyA, externalPrinterId: 'mock-laserjet-online' },
      });
      await tx.printJob.create({
        data: {
          companyId: companyA,
          printerId: printer.id,
          documentType: 'gift_message',
          sourceType: 'order',
          sourceId: stopId,
          sourceVersion: versionOf(orderOf(stopped)),
          copies: 1,
          paperSize: 'A6',
          status: 'submitted',
          isReprint: false,
          idempotencyKey: `gift-${stopId}`,
          requestedById: adminUserId,
          correlationId: cid('gift-print'),
        },
      });
    });
    const changed = cloneOrder(paidFixture);
    changed.id = `gid://shopify/Order/stop-${runId}`;
    changed.name = '#STOP';
    changed.updatedAt = '2026-04-14T10:00:00.000Z';
    setGift(changed, 'A different fictional gift.');
    expect((await postEvent(tokenA, companyA, shopifyA, `c2a-${runId}-stop-gift`, 'orders/updated', changed)).status).toBe(202);
    expect(await drain()).toBe(1);
    const stoppedOrder = await orderByNumber(adminA, companyA, '#STOP');
    expect(stoppedOrder.fulfilmentStatus).toBe('cancelled');
    expect(stringList(stoppedOrder.attentionReasons)).toContain('gift_message_changed_after_print');

    const open = await importClone(paidFixture, {
      id: `gid://shopify/Order/open-${runId}`,
      name: '#OPEN',
      updatedAt: '2026-04-15T10:00:00.000Z',
    });
    await withCompany(companyA, async (tx) => {
      const printer = await tx.printer.findFirstOrThrow({
        where: { companyId: companyA, externalPrinterId: 'mock-laserjet-online' },
      });
      await tx.printJob.create({
        data: {
          companyId: companyA,
          printerId: printer.id,
          documentType: 'gift_message',
          sourceType: 'order',
          sourceId: stringField(open, 'id'),
          sourceVersion: versionOf(open),
          copies: 1,
          paperSize: 'A6',
          status: 'submitted',
          isReprint: false,
          idempotencyKey: `gift-${stringField(open, 'id')}`,
          requestedById: adminUserId,
          correlationId: cid('open-print'),
        },
      });
    });
    const review = cloneOrder(paidFixture);
    review.id = `gid://shopify/Order/open-${runId}`;
    review.name = '#OPEN';
    review.updatedAt = '2026-04-16T10:00:00.000Z';
    setGift(review, 'Printed, then changed.');
    expect((await postEvent(tokenA, companyA, shopifyA, `c2a-${runId}-open-gift`, 'orders/updated', review)).status).toBe(202);
    expect(await drain()).toBe(1);
    const flagged = await orderByNumber(adminA, companyA, '#OPEN');
    expect(flagged.fulfilmentStatus).toBe('review_required');
    expect(flagged.reviewReason).toBe('gift_message_changed_after_print');

    const unknown = cloneOrder(paidFixture);
    unknown.id = `gid://shopify/Order/unknown-${runId}`;
    unknown.name = '#UNKNOWN';
    unknown.updatedAt = '2026-04-17T10:00:00.000Z';
    setShippingCode(unknown, 'teleport');
    expect((await postEvent(tokenA, companyA, shopifyA, `c2a-${runId}-unknown`, 'orders/create', unknown)).status).toBe(202);
    expect(await drain()).toBe(1);
    const unknownOrder = await orderByNumber(adminA, companyA, '#UNKNOWN');
    expect(unknownOrder.fulfilmentStatus).toBe('review_required');
    expect(unknownOrder.deliveryMethod).toBe('unknown');
    expect(unknownOrder.reviewReason).toBe('unknown_delivery');

    const sourceCancel = await importClone(paidFixture, {
      id: `gid://shopify/Order/src-cancel-${runId}`,
      name: '#SRC-CANCEL',
      updatedAt: '2026-04-18T10:00:00.000Z',
    });
    const sourcePayload = cloneOrder(paidFixture);
    sourcePayload.id = `gid://shopify/Order/src-cancel-${runId}`;
    sourcePayload.name = '#SRC-CANCEL';
    sourcePayload.updatedAt = '2026-04-19T10:00:00.000Z';
    sourcePayload.cancelledAt = '2026-04-19T09:00:00.000Z';
    expect((await postEvent(tokenA, companyA, shopifyA, `c2a-${runId}-src-cancel`, 'orders/updated', sourcePayload)).status).toBe(
      202,
    );
    expect(await drain()).toBe(1);
    const reviewed = await orderByNumber(adminA, companyA, '#SRC-CANCEL');
    expect(reviewed.fulfilmentStatus).toBe('review_required');
    expect(reviewed.reviewReason).toBe('cancelled_at_source');
    expect(sourceCancel.fulfilmentStatus).toBe('new');
  });

  it('rejects order date filters outside 2000-01-01 to 2999-12-31', async () => {
    for (const query of ['from=1999-12-31', 'to=3000-01-01', 'to=9999-12-31']) {
      const response = await send(adminA, 'get', `/api/c/${companyA}/orders?${query}`);
      expect(response.status, `${query} ${text(response)}`).toBe(400);
    }
    const edges = await send(adminA, 'get', `/api/c/${companyA}/orders?from=2000-01-01&to=2999-12-31`);
    expect(edges.status, text(edges)).toBe(200);
  });

  it('lets a user with order.assign but not order.claim assign and clear', async () => {
    const assigner = await installStaff(`assigner.${runId}@example.test`, [
      { permissions: ['order.view', 'order.assign'], scopeType: 'company', scopeId: null },
    ]);
    const current = await orderByNumber(adminA, companyA, '#1001');
    const version = versionOf(current);
    const assigned = await send(assigner.session, 'post', `/api/c/${companyA}/orders/${order1001}/assign`, cid('assign-only'), {
      userId: fulfilUserId,
      expectedVersion: version,
    });
    expect(assigned.status, text(assigned)).toBe(200);
    expect(orderOf(assigned).assignedToUserId).toBe(fulfilUserId);
    expect((await auditEvents(app, cid('assign-only'), companyA))[0]?.action).toBe('order.assigned');
    const cleared = await send(assigner.session, 'post', `/api/c/${companyA}/orders/${order1001}/assign`, cid('assign-clear'), {
      userId: null,
      expectedVersion: version + 1,
    });
    expect(cleared.status, text(cleared)).toBe(200);
    expect(orderOf(cleared).assignedToUserId).toBeNull();
    const self = await send(assigner.session, 'post', `/api/c/${companyA}/orders/${order1001}/assign`, cid('assign-self'), {
      userId: assigner.userId,
      expectedVersion: version + 2,
    });
    expect(self.status, text(self)).toBe(200);
    expect(orderOf(self).assignedToUserId).toBe(assigner.userId);
    expect((await auditEvents(app, cid('assign-self'), companyA))[0]?.action).toBe('order.claimed');
  });

  it('returns 404 when a secondary order permission misses the store scope', async () => {
    const scoped = await installStaff(`scoped.${runId}@example.test`, [
      { permissions: ['order.view', 'order.transition', 'order.claim'], scopeType: 'company', scopeId: null },
      { permissions: ['order.cancel', 'order.assign'], scopeType: 'store', scopeId: shopifyStoreA },
    ]);
    const cancel = await transition(scoped.session, companyA, prestaOrderId, 'cancelled', 1, cid('cancel-scope'));
    expect(cancel.status, text(cancel)).toBe(404);
    expect(detailReason((await auditEvents(app, cid('cancel-scope'), companyA))[0]?.details)).toBe('out_of_scope');
    const assign = await send(scoped.session, 'post', `/api/c/${companyA}/orders/${prestaOrderId}/assign`, cid('assign-scope'), {
      userId: adminUserId,
      expectedVersion: 1,
    });
    expect(assign.status, text(assign)).toBe(404);
    expect(detailReason((await auditEvents(app, cid('assign-scope'), companyA))[0]?.details)).toBe('out_of_scope');
    const presta = await orderByNumber(adminA, companyA, '#PRESTA');
    expect(presta.fulfilmentStatus).toBe('new');
    expect(presta.assignedToUserId).toBeNull();
    const staleCancel = await transition(scoped.session, companyA, prestaOrderId, 'cancelled', 0, cid('cancel-stale-scope'));
    expect(staleCancel.status, text(staleCancel)).toBe(404);
    expect(detailReason((await auditEvents(app, cid('cancel-stale-scope'), companyA))[0]?.details)).toBe('out_of_scope');
    const staleAssign = await send(
      scoped.session,
      'post',
      `/api/c/${companyA}/orders/${prestaOrderId}/assign`,
      cid('assign-stale-scope'),
      { userId: adminUserId, expectedVersion: 0 },
    );
    expect(staleAssign.status, text(staleAssign)).toBe(404);
    expect(detailReason((await auditEvents(app, cid('assign-stale-scope'), companyA))[0]?.details)).toBe('out_of_scope');
    await withCompany(companyA, async (tx) => {
      await tx.salesOrder.updateMany({
        where: { id: prestaOrderId, companyId: companyA },
        data: { fulfilmentStatus: 'completed' },
      });
    });
    try {
      const invalidCancel = await transition(
        scoped.session,
        companyA,
        prestaOrderId,
        'cancelled',
        1,
        cid('cancel-invalid-scope'),
      );
      expect(invalidCancel.status, text(invalidCancel)).toBe(404);
      expect(detailReason((await auditEvents(app, cid('cancel-invalid-scope'), companyA))[0]?.details)).toBe('out_of_scope');
    } finally {
      await withCompany(companyA, async (tx) => {
        await tx.salesOrder.updateMany({
          where: { id: prestaOrderId, companyId: companyA },
          data: { fulfilmentStatus: 'new' },
        });
      });
    }
    expect((await orderByNumber(adminA, companyA, '#PRESTA')).fulfilmentStatus).toBe('new');
  });

  it('lets a location-scoped fulfil user list and transition that location only', async () => {
    const placed = await withCompany(companyA, async (tx) => {
      const shopify = await tx.store.findFirstOrThrow({ where: { id: shopifyStoreA, companyId: companyA } });
      const location = await tx.location.create({
        data: {
          companyId: companyA,
          name: `Other demo location ${runId}`,
          address: { line1: 'Fictional street' },
          timezone: 'Asia/Nicosia',
        },
      });
      const store = await tx.store.create({
        data: {
          companyId: companyA,
          brandId: shopify.brandId,
          locationId: location.id,
          platform: 'manual',
          name: `Other demo store ${runId}`,
          status: 'active',
        },
      });
      const connection = await tx.storeConnection.create({
        data: { companyId: companyA, storeId: store.id, mode: 'mock', status: 'active', readOnly: true },
      });
      const order = await tx.salesOrder.create({
        data: {
          companyId: companyA,
          storeId: store.id,
          connectionId: connection.id,
          externalId: `other-${runId}`,
          externalNumber: '#OTHER-LOC',
          sourcePlatform: 'manual',
          sourceStatus: { displayFulfillmentStatus: null, cancelledAt: null },
          sourceCreatedAt: new Date('2026-02-01T10:00:00.000Z'),
          sourceUpdatedAt: new Date('2026-02-01T10:00:00.000Z'),
          paymentStatus: 'paid',
          fulfilmentStatus: 'new',
          integrationStatus: 'synced',
          deliveryMethod: 'courier_cy',
          currency: 'EUR',
          subtotal: '2.00',
          shippingTotal: '0.00',
          taxTotal: '0.00',
          total: '2.00',
          version: 1,
          customer: { displayName: 'Other Location', email: 'other.location@example.test', phone: null, id: null },
        },
      });
      const own = await tx.salesOrder.create({
        data: {
          companyId: companyA,
          storeId: shopify.id,
          connectionId: shopifyA,
          externalId: `loc-own-${runId}`,
          externalNumber: '#LOC-OWN',
          sourcePlatform: 'shopify',
          sourceStatus: { displayFulfillmentStatus: null, cancelledAt: null },
          sourceCreatedAt: new Date('2026-02-02T10:00:00.000Z'),
          sourceUpdatedAt: new Date('2026-02-02T10:00:00.000Z'),
          paymentStatus: 'paid',
          fulfilmentStatus: 'new',
          integrationStatus: 'synced',
          deliveryMethod: 'courier_cy',
          currency: 'EUR',
          subtotal: '3.00',
          shippingTotal: '0.00',
          taxTotal: '0.00',
          total: '3.00',
          version: 1,
          customer: { displayName: 'Same Location', email: 'same.location@example.test', phone: null, id: null },
        },
      });
      return {
        locationId: shopify.locationId,
        otherLocationId: location.id,
        otherOrderId: order.id,
        ownOrderId: own.id,
      };
    });
    const role = await started().get(PrismaService).client.role.findUniqueOrThrow({
      where: { companyId_key: { companyId: companyA, key: 'FS' } },
    });
    const locationUser = await installStaff(`location.${runId}@example.test`, [
      { roleId: role.id, scopeType: 'location', scopeId: placed.locationId },
    ]);
    const listed = await send(locationUser.session, 'get', `/api/c/${companyA}/orders?pageSize=100`);
    expect(listed.status, text(listed)).toBe(200);
    const listedOrders = ordersOf(listed);
    expect(record(bodyOf(listed)).total).toBe(listedOrders.length);
    const numbers = names(listedOrders);
    expect(numbers).toContain('#1002');
    expect(numbers).toContain('#LOC-OWN');
    expect(numbers).not.toContain('#OTHER-LOC');
    const moved = await transition(
      locationUser.session,
      companyA,
      placed.ownOrderId,
      'preparing',
      1,
      cid('loc-transition'),
    );
    expect(moved.status, text(moved)).toBe(200);
    expect(orderOf(moved).fulfilmentStatus).toBe('preparing');
    const hidden = await send(
      locationUser.session,
      'get',
      `/api/c/${companyA}/orders/${placed.otherOrderId}`,
      cid('loc-other'),
    );
    expect(hidden.status).toBe(404);
    expect(detailReason((await auditEvents(app, cid('loc-other'), companyA))[0]?.details)).toBe('out_of_scope');
    const hiddenMove = await transition(
      locationUser.session,
      companyA,
      placed.otherOrderId,
      'preparing',
      1,
      cid('loc-other-tx'),
    );
    expect(hiddenMove.status).toBe(404);
    expect(detailReason((await auditEvents(app, cid('loc-other-tx'), companyA))[0]?.details)).toBe('out_of_scope');
    const outsider = await installStaff(`outside-loc.${runId}@example.test`, [
      { roleId: role.id, scopeType: 'location', scopeId: placed.otherLocationId },
    ]);
    const refused = await send(adminA, 'post', `/api/c/${companyA}/orders/${placed.ownOrderId}/assign`, cid('loc-assign'), {
      userId: outsider.userId,
      expectedVersion: 2,
    });
    expect(refused.status, text(refused)).toBe(422);
    expect(errorCode(bodyOf(refused))).toBe('assignee_not_allowed');
  });

  async function importClone(
    base: Record<string, unknown>,
    input: { id: string; name: string; updatedAt: string; shippingCode?: string },
  ): Promise<Record<string, unknown>> {
    const payload = cloneOrder(base);
    payload.id = input.id;
    payload.name = input.name;
    payload.updatedAt = input.updatedAt;
    if (input.shippingCode) {
      setShippingCode(payload, input.shippingCode);
    }
    const posted = await postEvent(tokenA, companyA, shopifyA, `c2a-${runId}-${input.name}`, 'orders/create', payload);
    expect(posted.status, text(posted.response)).toBe(202);
    expect(await drain()).toBe(1);
    return orderByNumber(adminA, companyA, input.name);
  }

  async function clearOrders(companyId: string): Promise<void> {
    await withCompany(companyId, async (tx) => {
      const linked = await tx.invoice.findMany({
        where: { companyId, sourceOrderId: { not: null } },
        select: { sourceOrderId: true },
      });
      const keep = linked.flatMap((row) => (row.sourceOrderId ? [row.sourceOrderId] : []));
      const orders = await tx.salesOrder.findMany({
        where: { companyId, ...(keep.length > 0 ? { id: { notIn: keep } } : {}) },
        select: { id: true },
      });
      const ids = orders.map((order) => order.id);
      if (ids.length > 0) {
        await tx.printJob.deleteMany({ where: { companyId, sourceId: { in: ids }, reprintOfId: { not: null } } });
        await tx.printJob.deleteMany({ where: { companyId, sourceId: { in: ids } } });
        await tx.orderNote.deleteMany({ where: { companyId, orderId: { in: ids } } });
        await tx.salesOrderLine.deleteMany({ where: { companyId, orderId: { in: ids } } });
        await tx.salesOrder.deleteMany({ where: { companyId, id: { in: ids } } });
      }
      await tx.integrationInbox.deleteMany({ where: { companyId } });
    });
    await started().get(PrismaService).client.job.deleteMany({ where: { companyId, type: 'inbox.process' } });
  }

  async function installStaff(
    email: string,
    assignments: readonly (
      | { permissions: string[]; scopeType: 'company' | 'store' | 'location'; scopeId: string | null }
      | { roleId: string; scopeType: 'company' | 'store' | 'location'; scopeId: string | null }
    )[],
  ): Promise<{ userId: string; session: Session }> {
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
    for (const assignment of assignments) {
      const roleId =
        'roleId' in assignment
          ? assignment.roleId
          : (
              await client.role.create({
                data: {
                  companyId: companyA,
                  key: `custom-${randomUUID().slice(0, 8)}`,
                  name: email,
                  permissions: { create: assignment.permissions.map((permission) => ({ permission })) },
                },
              })
            ).id;
      await client.membershipRole.create({
        data: {
          membershipId: membership.id,
          roleId,
          scopeType: assignment.scopeType,
          scopeId: assignment.scopeId,
          grantedById: adminUserId,
        },
      });
    }
    return { userId: user.id, session: await login(started(), email) };
  }

  it('shows member display names and hides another company', async () => {
    const current = await orderByNumber(adminA, companyA, '#1001');
    const assigned = await send(adminA, 'post', `/api/c/${companyA}/orders/${order1001}/assign`, cid('names-assign'), {
      userId: fulfilUserId,
      expectedVersion: versionOf(current),
    });
    expect(assigned.status, text(assigned)).toBe(200);
    expect(record(orderOf(assigned).assignedTo)).toEqual({
      userId: fulfilUserId,
      displayName: 'Fulfilment A (fictional)',
    });

    const listed = await send(adminA, 'get', `/api/c/${companyA}/orders?q=${encodeURIComponent('#1001')}&pageSize=25`);
    expect(listed.status, text(listed)).toBe(200);
    const row = ordersOf(listed).find((order) => order.externalNumber === '#1001');
    if (!row) {
      throw new Error('#1001 is missing from the list');
    }
    expect(row.assignedToUserId).toBe(fulfilUserId);
    expect(record(row.assignedTo)).toEqual({ userId: fulfilUserId, displayName: 'Fulfilment A (fictional)' });

    const detail = await send(adminA, 'get', `/api/c/${companyA}/orders/${order1001}`);
    expect(detail.status, text(detail)).toBe(200);
    const notes = arrayOf(orderOf(detail).notes).map((note) => record(note));
    expect(notes.some((note) => note.authorDisplayName === 'Fulfilment A (fictional)')).toBe(true);
    expect(record(orderOf(detail).assignedTo).displayName).toBe('Fulfilment A (fictional)');

    const otherCompany = await send(adminB, 'get', `/api/c/${companyB}/orders/${order1001}`, cid('names-other'));
    expect(otherCompany.status).toBe(404);
    expect(errorCode(bodyOf(otherCompany))).toBe('not_found');
  });

  it('limits order filters to the stores in the caller scope', async () => {
    const fulfilFilters = await send(fulfil, 'get', `/api/c/${companyA}/order-filters`);
    expect(fulfilFilters.status, text(fulfilFilters)).toBe(200);
    expect(storeNames(fulfilFilters)).toEqual(['Nutbox Demo Shopify']);

    const adminFilters = await send(adminA, 'get', `/api/c/${companyA}/order-filters`);
    expect(adminFilters.status, text(adminFilters)).toBe(200);
    const adminStores = storeNames(adminFilters);
    expect(adminStores).toContain('Nutbox Demo Shopify');
    expect(adminStores).toContain('Nutbox Demo PrestaShop');
    expect(adminStores).not.toContain('Olive Grove Demo Shopify');

    const companyBFilters = await send(adminB, 'get', `/api/c/${companyB}/order-filters`);
    expect(storeNames(companyBFilters)).toContain('Olive Grove Demo Shopify');
    expect(storeNames(companyBFilters)).not.toContain('Nutbox Demo Shopify');
    expect(storeNames(companyBFilters)).not.toContain('Nutbox Demo PrestaShop');
  });

  it('lists assignees who can work the order store and refuses order.claim alone', async () => {
    const shopify = await send(adminA, 'get', `/api/c/${companyA}/orders/${order1001}/assignees`);
    expect(shopify.status, text(shopify)).toBe(200);
    const shopifyNames = assigneeNames(shopify);
    expect(shopifyNames).toContain('Fulfilment A (fictional)');
    expect(shopifyNames).toContain('Admin A (fictional)');
    expect(shopifyNames).not.toContain('Suspended A (fictional)');

    const presta = await send(adminA, 'get', `/api/c/${companyA}/orders/${prestaOrderId}/assignees`);
    expect(presta.status, text(presta)).toBe(200);
    const prestaNames = assigneeNames(presta);
    expect(prestaNames).not.toContain('Fulfilment A (fictional)');
    expect(prestaNames).toContain('Admin A (fictional)');
    expect(prestaNames).not.toContain('Suspended A (fictional)');

    const claimOnly = await send(fulfil, 'get', `/api/c/${companyA}/orders/${order1001}/assignees`, cid('assignees-claim'));
    expect(claimOnly.status).toBe(403);
    expect(detailReason((await auditEvents(app, cid('assignees-claim'), companyA))[0]?.details)).toBe('permission_missing');
  });

  it('omits a member who can transition a store but cannot view it', async () => {
    const mover = await installStaff(`transition-only.${runId}@example.test`, [
      { permissions: ['order.transition'], scopeType: 'store', scopeId: shopifyStoreA },
    ]);
    const listed = await send(adminA, 'get', `/api/c/${companyA}/orders/${order1001}/assignees`);
    expect(listed.status, text(listed)).toBe(200);
    expect(assigneeNames(listed)).not.toContain(`transition-only.${runId}@example.test`);
    expect(assigneeNames(listed)).toContain('Fulfilment A (fictional)');
    const current = await orderByNumber(adminA, companyA, '#1001');
    const assigned = await send(adminA, 'post', `/api/c/${companyA}/orders/${order1001}/assign`, cid('assignee-no-view'), {
      userId: mover.userId,
      expectedVersion: versionOf(current),
    });
    expect(assigned.status, text(assigned)).toBe(422);
    expect(errorCode(bodyOf(assigned))).toBe('assignee_not_allowed');
  });

  it('reports can from the order store when view is company-wide', async () => {
    const viewer = await installStaff(`store-claim.${runId}@example.test`, [
      { permissions: ['order.view'], scopeType: 'company', scopeId: null },
      { permissions: ['order.claim', 'print.submit'], scopeType: 'store', scopeId: shopifyStoreA },
    ]);
    const shopify = await send(viewer.session, 'get', `/api/c/${companyA}/orders/${order1001}`);
    expect(shopify.status, text(shopify)).toBe(200);
    expect(record(orderOf(shopify).can)).toMatchObject({ claim: true, printSubmit: true, assign: false });
    const presta = await send(viewer.session, 'get', `/api/c/${companyA}/orders/${prestaOrderId}`);
    expect(presta.status, text(presta)).toBe(200);
    expect(record(orderOf(presta).can)).toMatchObject({ claim: false, printSubmit: false });

    const claimIn = await send(viewer.session, 'post', `/api/c/${companyA}/orders/${order1001}/assign`, cid('can-claim-in'), {
      userId: viewer.userId,
      expectedVersion: versionOf(orderOf(shopify)),
    });
    expect(claimIn.status, text(claimIn)).toBe(200);
    const claimOut = await send(
      viewer.session,
      'post',
      `/api/c/${companyA}/orders/${prestaOrderId}/assign`,
      cid('can-claim-out'),
      { userId: viewer.userId, expectedVersion: versionOf(orderOf(presta)) },
    );
    expect(claimOut.status, text(claimOut)).toBe(404);
    expect(errorCode(bodyOf(claimOut))).toBe('not_found');

    const printOut = await send(
      viewer.session,
      'post',
      `/api/c/${companyA}/print-requests`,
      cid('can-print-out'),
      { documentType: 'packing_slip', sourceType: 'order', sourceId: prestaOrderId },
    );
    expect(printOut.status, text(printOut)).toBe(404);
    const printIn = await send(
      viewer.session,
      'post',
      `/api/c/${companyA}/print-requests`,
      cid('can-print-in'),
      { documentType: 'packing_slip', sourceType: 'order', sourceId: order1001 },
    );
    expect(printIn.status, text(printIn)).not.toBe(404);
    expect(printIn.status, text(printIn)).not.toBe(403);
  });

  it('creates the milestone PrestaShop order once, with its line in company A', async () => {
    try {
      const prisma = started().get(PrismaService);
      await ensurePrestashopOrder(prisma, companyA);
      await ensurePrestashopOrder(prisma, companyA);
      const orders = await withCompany(companyA, (tx) =>
        tx.salesOrder.findMany({
          where: { companyId: companyA, externalId: PRESTASHOP_MILESTONE_EXTERNAL_ID },
        }),
      );
      expect(orders).toHaveLength(1);
      const order = orders[0];
      if (!order) {
        throw new Error('milestone order is missing');
      }
      expect(order.externalNumber).toBe('#P-1001');
      expect(order.sourcePlatform).toBe('prestashop');
      expect(order.giftMessage).toBe(PRESTASHOP_GIFT);
      const lines = await withCompany(companyA, (tx) =>
        tx.salesOrderLine.findMany({
          where: { companyId: companyA, orderId: order.id },
        }),
      );
      expect(lines).toHaveLength(1);
      const line = lines[0];
      if (!line) {
        throw new Error('milestone line is missing');
      }
      expect(line.companyId).toBe(companyA);
      expect(line.orderId).toBe(order.id);
    } finally {
      await clearOrders(companyA);
    }
  });

  function withCompany<T>(companyId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return new TenantDb(started().get(PrismaService).client).run(
      { companyId, actor: adminUserId, correlationId: `c2a-db-${runId}` },
      fn,
    );
  }

  async function processInArrivalOrder(inboxIds: readonly string[]): Promise<void> {
    const processor = started().get(InboxProcessor);
    const arrived = deferred();
    let seen = 0;
    const permits = new Map(inboxIds.map((inboxId) => [inboxId, deferred()]));
    processor.hooks = {
      beforeAdvisoryLock: (inboxId) => {
        seen += 1;
        if (seen === inboxIds.length) {
          arrived.resolve();
        }
        const permit = permits.get(inboxId);
        if (!permit) {
          return Promise.reject(new Error(`unexpected inbox ${inboxId}`));
        }
        return permit.promise;
      },
      afterAdvisoryLock: (inboxId) => {
        const index = inboxIds.indexOf(inboxId);
        const following = inboxIds[index + 1];
        if (following) {
          permits.get(following)?.resolve();
        }
        return Promise.resolve();
      },
    };
    const runs = inboxIds.map(async (inboxId) => {
      const queued = await started()
        .get(PrismaService)
        .client.job.findFirstOrThrow({ where: { idempotencyKey: `inbox:${inboxId}` } });
      const claimed: ClaimedJob = {
        id: queued.id,
        companyId: queued.companyId,
        type: queued.type,
        payload: queued.payload,
        attempts: queued.attempts,
        maxAttempts: queued.maxAttempts,
        correlationId: queued.correlationId,
        timeoutMs: queued.timeoutMs ?? 30_000,
        lockedBy: 'test',
        deadline: new Date(Date.now() + 60_000),
      };
      const companyId = queued.companyId;
      if (!companyId) {
        throw new Error('job has no company');
      }
      await correlationStorage.run({ correlationId: queued.correlationId }, () =>
        new TenantDb(started().get(PrismaService).client).run(
          { companyId, actor: identityA, correlationId: queued.correlationId },
          (tx) => processor.run(claimed, tx, new AbortController().signal),
          { timeoutMs: 20_000 },
        ),
      );
    });
    try {
      await Promise.race([
        arrived.promise,
        delayReject(10_000, 'imports did not reach the advisory lock'),
      ]);
      const first = inboxIds[0];
      if (!first) {
        throw new Error('arrival order is empty');
      }
      permits.get(first)?.resolve();
      await Promise.all(runs);
    } finally {
      for (const permit of permits.values()) {
        permit.resolve();
      }
      processor.hooks = null;
      await Promise.allSettled(runs);
    }
  }
});

function loadFixture(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(shopifyFixturesDirectory(), name), 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${name} is not an object`);
  }
  return parsed;
}

function giftFrom(payload: Record<string, unknown>): string {
  if (!isUnknownArray(payload.customAttributes)) {
    throw new Error('customAttributes missing');
  }
  for (const entry of payload.customAttributes) {
    if (isRecord(entry) && entry.key === 'Gift Message' && typeof entry.value === 'string') {
      return entry.value;
    }
  }
  throw new Error('gift message missing');
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

function setShippingCode(payload: Record<string, unknown>, code: string): void {
  if (!isRecord(payload.shippingLine)) {
    throw new Error('shippingLine missing');
  }
  payload.shippingLine.code = code;
}

function setGift(payload: Record<string, unknown>, gift: string): void {
  if (!isUnknownArray(payload.customAttributes)) {
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

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length === 0) {
    return [[]];
  }
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function delayReject(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(message));
    }, ms);
  });
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

async function login(application: INestApplication, email: string): Promise<Session> {
  const agent = request.agent(application.getHttpServer() as App);
  const response = await agent.post('/api/auth/dev/login').send({ email });
  expect(response.status, text(response)).toBe(200);
  return { agent, xsrf: cookieValue(cookieHeader(response, 'XSRF-TOKEN'), 'XSRF-TOKEN') };
}

async function createToken(
  session: Session,
  companyId: string,
  label: string,
): Promise<{ id: string; token: string }> {
  const response = await send(session, 'post', `/api/c/${companyId}/service-identities`, cid(`token-${label}`), {
    name: `orders-${label}-${runId}`,
    purpose: 'store events',
    permissions: ['store.events.ingest'],
  });
  expect(response.status, text(response)).toBe(200);
  const body = record(bodyOf(response));
  return { id: stringField(record(body.identity), 'id'), token: stringField(body, 'token') };
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

function httpServer(): App {
  return started().getHttpServer() as App;
}

async function postEvent(
  token: string,
  companyId: string,
  connectionId: string,
  eventId: string,
  topic: Topic,
  payload: Record<string, unknown>,
  correlationId?: string,
) {
  const updatedAt = payload.updatedAt;
  if (typeof updatedAt !== 'string') {
    throw new Error('updatedAt missing');
  }
  const call = request(httpServer())
    .post(`/api/automation/v1/c/${companyId}/store-connections/${connectionId}/events`)
    .set('Authorization', `Bearer ${token}`)
    .send({ eventId, topic, occurredAt: updatedAt, payload });
  if (correlationId) {
    call.set('X-Correlation-Id', correlationId);
  }
  const response = await call;
  return { status: response.status, response };
}

async function drain(): Promise<number> {
  const result = await started().get(JobRunner).drainOnce();
  return result.processed;
}

async function inbox(companyId: string, inboxId: string) {
  return new TenantDb(started().get(PrismaService).client).run(
    { companyId, actor: 'orders-test', correlationId: `c2a-read-${runId}` },
    (tx) => tx.integrationInbox.findFirstOrThrow({ where: { id: inboxId, companyId } }),
  );
}

async function jobCount(inboxId: string): Promise<number> {
  return started().get(PrismaService).client.job.count({ where: { idempotencyKey: `inbox:${inboxId}` } });
}

async function orderByNumber(session: Session, companyId: string, externalNumber: string): Promise<Record<string, unknown>> {
  const listed = await send(session, 'get', `/api/c/${companyId}/orders?q=${encodeURIComponent(externalNumber)}&pageSize=100`);
  expect(listed.status, text(listed)).toBe(200);
  const found = ordersOf(listed).find((order) => order.externalNumber === externalNumber);
  if (!found) {
    throw new Error(`order ${externalNumber} was not listed`);
  }
  const detail = await send(session, 'get', `/api/c/${companyId}/orders/${stringField(found, 'id')}`);
  expect(detail.status, text(detail)).toBe(200);
  return orderOf(detail);
}

function transition(
  session: Session,
  companyId: string,
  id: string,
  to: string,
  expectedVersion: number,
  correlationId?: string,
) {
  return send(session, 'post', `/api/c/${companyId}/orders/${id}/transitions`, correlationId, { to, expectedVersion });
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

function cid(name: string): string {
  return `c2a-${name}-${runId}`.slice(0, 64);
}

function orderOf(response: request.Response): Record<string, unknown> {
  return record(record(bodyOf(response)).order);
}

function storeNames(response: request.Response): string[] {
  return arrayOf(record(bodyOf(response)).stores).map((store) => stringField(record(store), 'name'));
}

function assigneeNames(response: request.Response): string[] {
  return arrayOf(record(bodyOf(response)).users).map((user) => stringField(record(user), 'displayName'));
}

function ordersOf(response: request.Response): Record<string, unknown>[] {
  return arrayOf(record(bodyOf(response)).orders).map((item) => record(item));
}

function names(orders: readonly Record<string, unknown>[]): string[] {
  return orders.map((order) => stringField(order, 'externalNumber'));
}

function transitionTargets(order: Record<string, unknown>): string[] {
  return arrayOf(order.allowedTransitions).map((item) => stringField(record(item), 'to'));
}

function versionOf(order: Record<string, unknown>): number {
  if (typeof order.version !== 'number') {
    throw new Error('version is missing');
  }
  return order.version;
}

function bodyOf(response: request.Response): unknown {
  return response.body as unknown;
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
  if (!isUnknownArray(value)) {
    throw new Error('expected an array');
  }
  return value;
}

function stringList(value: unknown): string[] {
  if (!isUnknownArray(value)) {
    throw new Error('expected strings');
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error('expected strings');
    }
    result.push(item);
  }
  return result;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') {
    throw new Error(`${key} is missing`);
  }
  return field;
}

function idsOf(value: unknown): string[] {
  return arrayOf(value).map((item) => stringField(record(item), 'id'));
}

function errorCode(body: unknown): string | undefined {
  const code = record(record(body).error).code;
  return typeof code === 'string' ? code : undefined;
}

function detailReason(details: unknown): string | undefined {
  return detailField(details, 'reason');
}

function detailField(details: unknown, key: string): string | undefined {
  if (!isRecord(details)) {
    return undefined;
  }
  const value = details[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
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
