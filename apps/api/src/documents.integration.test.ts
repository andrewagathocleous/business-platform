import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { LocalFsStorage, storageKey } from '@bp/integrations';
import { Logger } from 'nestjs-pino';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
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
import { CompanyAutomationService } from './automation/company-automation.service';
import { PrismaService } from './database/prisma.service';
import { DocumentService } from './documents/document.service';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { LOG_STREAM } from './logging/logging.module';

const COMPANY_A = 'Demo Company A Ltd (fictional)';
const COMPANY_B = 'Demo Company B Ltd (fictional)';
const GREEK_GIFT = 'Χρόνια πολλά, Μαρία!\n\nΜε αγάπη, \nΓιώργος & Ελένη — «καλή χρονιά»';
const WIDTH_PT = (148 * 72) / 25.4;
const HEIGHT_PT = (105 * 72) / 25.4;
const FORBIDDEN_PRICES = [
  '8.5000',
  '8.50',
  '17.00',
  '18.00',
  '18.0000',
  '3.00',
  '3.0000',
  '4.50',
  '17.34',
  '91.25',
  '113.09',
  'EUR',
];
const runId = randomUUID().slice(0, 8);

type Agent = ReturnType<typeof request.agent>;
type Session = { agent: Agent; xsrf: string };
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

let app: INestApplication | undefined;
let storageRoot = '';
const logChunks: string[] = [];

describe('documents, files and company switches', () => {
  let companyA = '';
  let companyB = '';
  let adminUserId = '';
  let adminA: Session;
  let adminB: Session;
  let fulfil: Session;
  let shopifyOrderId = '';
  let prestaOrderId = '';
  let orderNumber = '';
  let packingFileId = '';
  let invoiceFileId = '';
  let testPrintFileId = '';
  let packingBytes = Buffer.alloc(0);
  let invoiceBytes = Buffer.alloc(0);
  let testPrintBytes = Buffer.alloc(0);
  let jobA = '';
  let templateId = '';
  let templateName = '';
  let storage: LocalFsStorage;

  beforeAll(async () => {
    const refusal = assertTestDatabaseUrls();
    if (refusal) {
      throw new Error(refusal);
    }
    await assertEnvConnectionsTargetTestDatabase();
    seedDatabase();
    storageRoot = mkdtempSync(join(tmpdir(), 'bp-c2b1-'));
    process.env.STORAGE_ROOT = storageRoot;
    process.env.APP_ENV = 'test';
    process.env.AUTH_DEV_LOGIN_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECURE = 'false';
    process.env.CSRF_SECRET = 'integration-test-csrf-secret';
    process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED = 'false';
    delete process.env.THROTTLE_ENABLED_IN_TEST;
    storage = new LocalFsStorage(storageRoot);
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
    companyB = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_B } }))
      .id;
    adminUserId = (
      await prisma.client.userAccount.findFirstOrThrow({ where: { email: 'admin.a@example.test' } })
    ).id;
    adminA = await login(app, 'admin.a@example.test');
    adminB = await login(app, 'admin.b@example.test');
    fulfil = await login(app, 'fulfil.a@example.test');
    const created = await withCompany(companyA, async (tx) => {
      const shopify = await tx.store.findFirstOrThrow({
        where: { companyId: companyA, name: 'Nutbox Demo Shopify' },
      });
      const presta = await tx.store.findFirstOrThrow({
        where: { companyId: companyA, name: 'Nutbox Demo PrestaShop' },
      });
      const shopifyConnection = await tx.storeConnection.findFirstOrThrow({
        where: { companyId: companyA, storeId: shopify.id, status: 'active', mode: 'mock' },
      });
      const prestaConnection = await tx.storeConnection.findFirstOrThrow({
        where: { companyId: companyA, storeId: presta.id, status: 'active', mode: 'mock' },
      });
      const shopifyOrder = await tx.salesOrder.create({
        data: {
          companyId: companyA,
          storeId: shopify.id,
          connectionId: shopifyConnection.id,
          externalId: `c2b1-shopify-${runId}`,
          externalNumber: `#C2B1-${runId}`,
          sourcePlatform: 'shopify',
          sourceStatus: {},
          paymentStatus: 'paid',
          fulfilmentStatus: 'new',
          integrationStatus: 'synced',
          deliveryMethod: 'courier_cy',
          currency: 'EUR',
          subtotal: '91.25',
          shippingTotal: '4.50',
          taxTotal: '17.34',
          total: '113.09',
          giftMessage: GREEK_GIFT,
          recipient: {
            firstName: 'Μαρία',
            lastName: 'Παπαδοπούλου',
            address1: '1 Demo Street',
            address2: 'Διαμέρισμα 2',
            city: 'Λευκωσία',
            zip: '1000',
            countryCodeV2: 'CY',
            phone: '+35799001001',
          },
          version: 1,
          lines: {
            create: [
              {
                sku: 'NUTS',
                title: 'Mixed nuts',
                variantTitle: '250 g',
                quantity: '2.0000',
                unitPrice: '8.5000',
                total: '17.00',
              },
              {
                sku: 'GIFTBOX',
                title: 'Gift box',
                variantTitle: null,
                quantity: '1.0000',
                unitPrice: '18.0000',
                total: '18.00',
              },
              {
                sku: 'WRAP',
                title: 'Gift wrapping',
                variantTitle: null,
                quantity: '1.0000',
                unitPrice: '3.0000',
                total: '3.00',
              },
            ],
          },
        },
        select: { id: true, externalNumber: true },
      });
      const prestaOrder = await tx.salesOrder.create({
        data: {
          companyId: companyA,
          storeId: presta.id,
          connectionId: prestaConnection.id,
          externalId: `c2b1-presta-${runId}`,
          externalNumber: `#C2B1-PRESTA-${runId}`,
          sourcePlatform: 'prestashop',
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
          version: 1,
        },
        select: { id: true },
      });
      return {
        shopifyOrderId: shopifyOrder.id,
        prestaOrderId: prestaOrder.id,
        orderNumber: shopifyOrder.externalNumber,
      };
    });
    shopifyOrderId = created.shopifyOrderId;
    prestaOrderId = created.prestaOrderId;
    orderNumber = created.orderNumber;
    const stamped = new Date();
    packingBytes = Buffer.from(`%PDF-1.4 packing ${runId}`);
    invoiceBytes = Buffer.from(`%PDF-1.4 invoice ${runId}`);
    testPrintBytes = Buffer.from(`%PDF-1.4 test-print ${runId}`);
    packingFileId = randomUUID();
    invoiceFileId = randomUUID();
    testPrintFileId = randomUUID();
    await storage.put(
      storageKey({ companyId: companyA, kind: 'packing_slip', id: packingFileId, at: stamped }),
      packingBytes,
    );
    await storage.put(
      storageKey({ companyId: companyA, kind: 'invoice_pdf', id: invoiceFileId, at: stamped }),
      invoiceBytes,
    );
    await storage.put(
      storageKey({ companyId: companyA, kind: 'test_print', id: testPrintFileId, at: stamped }),
      testPrintBytes,
    );
    await withCompany(companyA, async (tx) => {
      await tx.storedFile.create({
        data: storedFile(
          companyA,
          packingFileId,
          'packing_slip',
          adminUserId,
          stamped,
          packingBytes,
          'order',
          shopifyOrderId,
        ),
      });
      await tx.storedFile.create({
        data: storedFile(
          companyA,
          invoiceFileId,
          'invoice_pdf',
          adminUserId,
          stamped,
          invoiceBytes,
          null,
          null,
        ),
      });
      await tx.storedFile.create({
        data: storedFile(
          companyA,
          testPrintFileId,
          'test_print',
          adminUserId,
          stamped,
          testPrintBytes,
          null,
          null,
        ),
      });
    });
    const secret = `c2b1-customer-secret-${runId}`;
    const job = await prisma.client.job.create({
      data: {
        companyId: companyA,
        type: 'c2b1.probe',
        payload: { secret },
        status: 'succeeded',
        finishedAt: new Date(),
        correlationId: cid('job-row'),
        idempotencyKey: `c2b1-${runId}`,
      },
      select: { id: true },
    });
    jobA = job.id;
    const templates = await send(adminA, 'get', `/api/c/${companyA}/gift-message-templates`);
    expect(templates.status, text(templates)).toBe(200);
    const card = record(arrayOf(record(bodyOf(templates)).templates)[0]);
    templateId = stringField(card, 'id');
    templateName = stringField(card, 'name');
    expect(card.pageWidthMm).toBe('148.00');
    expect(card.pageHeightMm).toBe('105.00');
    expect(card.isDefault).toBe(true);
  }, 120_000);

  afterAll(async () => {
    if (app && companyA.length > 0) {
      await app.get(PrismaService).client.automationSwitch.updateMany({
        where: { companyId: companyA, key: 'printing' },
        data: { enabled: true },
      });
      await app
        .get(PrismaService)
        .client.job.deleteMany({ where: { idempotencyKey: `c2b1-${runId}` } });
      await withCompany(companyA, async (tx) => {
        if (templateId.length > 0 && templateName.length > 0) {
          await tx.giftMessageTemplate.update({
            where: { id: templateId },
            data: { name: templateName },
          });
        }
        const fileIds = [packingFileId, invoiceFileId, testPrintFileId].filter(
          (id) => id.length > 0,
        );
        if (fileIds.length > 0) {
          await tx.storedFile.deleteMany({ where: { id: { in: fileIds } } });
        }
        const orderIds = [shopifyOrderId, prestaOrderId].filter((id) => id.length > 0);
        if (orderIds.length > 0) {
          await tx.salesOrderLine.deleteMany({ where: { orderId: { in: orderIds } } });
          await tx.salesOrder.deleteMany({ where: { id: { in: orderIds } } });
        }
      });
      await app.close();
    }
    delete process.env.STORAGE_ROOT;
    if (storageRoot.length > 0) {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  it('renders the packing slip and the gift message, and hides the other store', async () => {
    const slip = await fetchPdf(
      fulfil,
      `/api/c/${companyA}/orders/${shopifyOrderId}/documents/packing-slip.pdf`,
      cid('slip'),
    );
    expect(slip.status, preview(slip)).toBe(200);
    expect(slip.headers['cache-control']).toBe('no-store');
    expect(slip.headers['content-type']).toContain('application/pdf');
    const slipBytes = bufferOf(slip);
    expect(slipBytes.subarray(0, 4).toString('utf8')).toBe('%PDF');
    const slipPage = await readPdf(slipBytes);
    const flat = slipPage.text.replace(/\s+/g, '');
    expect(flat).toContain(orderNumber);
    expect(flat).toContain('ΜαρίαΠαπαδοπούλου');
    expect(flat).toContain('Mixednuts');
    expect(flat).toContain('Giftbox');
    expect(flat).toContain('Giftwrapping');
    expect(flat).toContain('NutboxDemoShopify');
    expect(flat).toContain('Giftmessage');
    expect(flat).toContain('Yes');
    expect(slipPage.text).not.toContain('Χρόνια πολλά');
    for (const price of FORBIDDEN_PRICES) {
      expect(slipPage.text).not.toContain(price);
    }
    expect(await auditEvents(app, cid('slip'), companyA)).toEqual([]);

    const gift = await fetchPdf(
      fulfil,
      `/api/c/${companyA}/orders/${shopifyOrderId}/documents/gift-message.pdf`,
      cid('gift'),
    );
    expect(gift.status, preview(gift)).toBe(200);
    expect(gift.headers['cache-control']).toBe('no-store');
    const giftPage = await readPdf(bufferOf(gift));
    expect(giftPage.pages).toBe(1);
    expect(Math.abs(giftPage.width - WIDTH_PT)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(giftPage.height - HEIGHT_PT)).toBeLessThanOrEqual(0.5);
    const visual = giftPage.lines.map((line) => line.text.replace(/\s+/gu, ''));
    const stored = GREEK_GIFT.split('\n')
      .map((line) => line.replace(/\s+/gu, ''))
      .filter((line) => line.length > 0);
    expect(visual).toEqual(stored);
    const blankGap = (giftPage.lines[0]?.y ?? 0) - (giftPage.lines[1]?.y ?? 0);
    const normalGap = (giftPage.lines[1]?.y ?? 0) - (giftPage.lines[2]?.y ?? 0);
    expect(blankGap).toBeGreaterThanOrEqual(normalGap * 1.5);

    const badTemplate = await fetchPdf(
      fulfil,
      `/api/c/${companyA}/orders/${shopifyOrderId}/documents/gift-message.pdf?templateId=not-a-uuid`,
      cid('bad-template'),
    );
    expect(badTemplate.status).toBe(400);
    expect(await auditEvents(app, cid('bad-template'), companyA)).toEqual([]);

    await expectDenied(
      await fetchPdf(
        fulfil,
        `/api/c/${companyA}/orders/${prestaOrderId}/documents/packing-slip.pdf`,
        cid('fulfil-presta-slip'),
      ),
      404,
      cid('fulfil-presta-slip'),
      companyA,
      'out_of_scope',
    );
    await expectDenied(
      await fetchPdf(
        fulfil,
        `/api/c/${companyA}/orders/${prestaOrderId}/documents/gift-message.pdf`,
        cid('fulfil-presta-gift'),
      ),
      404,
      cid('fulfil-presta-gift'),
      companyA,
      'out_of_scope',
    );
    const missingGift = await fetchPdf(
      adminA,
      `/api/c/${companyA}/orders/${prestaOrderId}/documents/gift-message.pdf`,
      cid('gift-missing'),
    );
    await expectDenied(missingGift, 404, cid('gift-missing'), companyA, 'gift_message_missing');
  });

  it('keeps documents, files, templates, switches and jobs inside the company', async () => {
    const objectPaths = [
      ['slip', `/orders/${shopifyOrderId}/documents/packing-slip.pdf`],
      ['gift', `/orders/${shopifyOrderId}/documents/gift-message.pdf`],
      ['file', `/files/${packingFileId}`],
      ['invoice-file', `/files/${invoiceFileId}`],
    ] as const;
    for (const [name, path] of objectPaths) {
      await expectDenied(
        await fetchPdf(adminB, `/api/c/${companyA}${path}`, cid(`cross-a-${name}`)),
        404,
        cid(`cross-a-${name}`),
        companyA,
        'not_a_member',
      );
      await expectDenied(
        await fetchPdf(adminB, `/api/c/${companyB}${path}`, cid(`cross-b-${name}`)),
        404,
        cid(`cross-b-${name}`),
        companyB,
        'out_of_scope',
      );
    }
    const guessed = await fetchPdf(
      adminB,
      `/api/c/${companyB}/files/${packingFileId}`,
      cid('guessed-file'),
    );
    expect(guessed.status).toBe(404);
    expect(bufferOf(guessed).equals(packingBytes)).toBe(false);

    await expectDenied(
      await send(
        adminB,
        'patch',
        `/api/c/${companyA}/gift-message-templates/${templateId}`,
        cid('cross-template-a'),
        {
          name: 'hidden',
        },
      ),
      404,
      cid('cross-template-a'),
      companyA,
      'not_a_member',
    );
    await expectDenied(
      await send(
        adminB,
        'patch',
        `/api/c/${companyB}/gift-message-templates/${templateId}`,
        cid('cross-template-b'),
        {
          name: 'hidden',
        },
      ),
      404,
      cid('cross-template-b'),
      companyB,
      'template_not_found',
    );
    const listedB = await send(adminB, 'get', `/api/c/${companyB}/gift-message-templates`);
    expect(listedB.status, text(listedB)).toBe(200);
    expect(idsOf(record(bodyOf(listedB)).templates)).not.toContain(templateId);

    await expectDenied(
      await send(adminB, 'get', `/api/c/${companyA}/automation/switches`, cid('cross-switches')),
      404,
      cid('cross-switches'),
      companyA,
      'not_a_member',
    );
    await expectDenied(
      await send(
        adminB,
        'put',
        `/api/c/${companyA}/automation/switches/printing`,
        cid('cross-switch-put'),
        {
          enabled: false,
          reason: 'must not apply',
        },
      ),
      404,
      cid('cross-switch-put'),
      companyA,
      'not_a_member',
    );
    await expectDenied(
      await send(adminB, 'get', `/api/c/${companyA}/automation/jobs`, cid('cross-jobs')),
      404,
      cid('cross-jobs'),
      companyA,
      'not_a_member',
    );
    const jobsB = await jobIds(adminB, companyB);
    expect(jobsB).not.toContain(jobA);
    const jobsA = await jobIds(adminA, companyA);
    expect(jobsA).toContain(jobA);
    const queued = await send(
      adminA,
      'get',
      `/api/c/${companyA}/automation/jobs?status=queued&pageSize=100`,
    );
    expect(queued.status, text(queued)).toBe(200);
    expect(idsOf(record(bodyOf(queued)).jobs)).not.toContain(jobA);
    expect(JSON.stringify(bodyOf(queued))).not.toContain(`c2b1-customer-secret-${runId}`);
    const succeeded = await send(
      adminA,
      'get',
      `/api/c/${companyA}/automation/jobs?status=succeeded&pageSize=100`,
    );
    expect(idsOf(record(bodyOf(succeeded)).jobs)).toContain(jobA);
    expect(JSON.stringify(bodyOf(succeeded))).not.toContain(`c2b1-customer-secret-${runId}`);
    const badStatus = await send(
      adminA,
      'get',
      `/api/c/${companyA}/automation/jobs?status=nope`,
      cid('bad-status'),
    );
    expect(badStatus.status).toBe(400);
    expect(await auditEvents(app, cid('bad-status'), companyA)).toEqual([]);
  });

  it('streams a stored file only after the company and kind checks', async () => {
    const packing = await fetchPdf(
      fulfil,
      `/api/c/${companyA}/files/${packingFileId}`,
      cid('file-slip'),
    );
    expect(packing.status, preview(packing)).toBe(200);
    expect(packing.headers['cache-control']).toBe('no-store');
    expect(bufferOf(packing).equals(packingBytes)).toBe(true);
    await expectDenied(
      await fetchPdf(fulfil, `/api/c/${companyA}/files/${invoiceFileId}`, cid('file-invoice')),
      403,
      cid('file-invoice'),
      companyA,
      'permission_missing',
    );
    const invoice = await fetchPdf(
      adminA,
      `/api/c/${companyA}/files/${invoiceFileId}`,
      cid('file-invoice-admin'),
    );
    expect(invoice.status, preview(invoice)).toBe(200);
    expect(bufferOf(invoice).equals(invoiceBytes)).toBe(true);
    await expectDenied(
      await fetchPdf(fulfil, `/api/c/${companyA}/files/${testPrintFileId}`, cid('file-test-print')),
      404,
      cid('file-test-print'),
      companyA,
      'out_of_scope',
    );
    const testPrint = await fetchPdf(
      adminA,
      `/api/c/${companyA}/files/${testPrintFileId}`,
      cid('file-test-print-admin'),
    );
    expect(testPrint.status, preview(testPrint)).toBe(200);
    expect(bufferOf(testPrint).equals(testPrintBytes)).toBe(true);
    await expectDenied(
      await fetchPdf(adminA, `/api/c/${companyA}/files/not-a-uuid`, cid('file-bad-id')),
      404,
      cid('file-bad-id'),
      companyA,
      'out_of_scope',
    );
  });

  it('audits gift-template changes and refuses them to fulfilment', async () => {
    const renamed = `A6 card ${runId}`;
    try {
      await expectDenied(
        await send(
          fulfil,
          'patch',
          `/api/c/${companyA}/gift-message-templates/${templateId}`,
          cid('fulfil-template'),
          {
            name: renamed,
          },
        ),
        403,
        cid('fulfil-template'),
        companyA,
        'permission_missing',
      );
      const numberWidth = await send(
        adminA,
        'patch',
        `/api/c/${companyA}/gift-message-templates/${templateId}`,
        cid('template-number'),
        { pageWidthMm: 148 },
      );
      expect(numberWidth.status, text(numberWidth)).toBe(400);
      expect(await auditEvents(app, cid('template-number'), companyA)).toEqual([]);
      const updated = await send(
        adminA,
        'patch',
        `/api/c/${companyA}/gift-message-templates/${templateId}`,
        cid('template-update'),
        { name: renamed },
      );
      expect(updated.status, text(updated)).toBe(200);
      expect(stringField(record(record(bodyOf(updated)).template), 'name')).toBe(renamed);
      const events = await auditEvents(app, cid('template-update'), companyA);
      expect(events).toEqual([
        expect.objectContaining({
          action: 'gift_message_template.updated',
          outcome: 'success',
          objectType: 'gift_message_template',
          objectId: templateId,
        }),
      ]);
      await expectDenied(
        await send(
          adminA,
          'patch',
          `/api/c/${companyA}/gift-message-templates/not-a-uuid`,
          cid('template-bad-id'),
          {
            name: renamed,
          },
        ),
        404,
        cid('template-bad-id'),
        companyA,
        'not_found',
      );
    } finally {
      if (app && templateId.length > 0) {
        const restored = await send(
          adminA,
          'patch',
          `/api/c/${companyA}/gift-message-templates/${templateId}`,
          cid('template-restore'),
          {
            name: templateName,
          },
        );
        expect(restored.status, text(restored)).toBe(200);
      }
    }
  });

  it('previews sample text with a saved template and keeps it inside the company', async () => {
    const preview = (session: Session, companyId: string, body: unknown, name: string) =>
      session.agent
        .post(`/api/c/${companyId}/gift-message-templates/${templateId}/preview`)
        .set('X-XSRF-TOKEN', session.xsrf)
        .set('X-Correlation-Id', cid(name))
        .send(body as object)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer | string) => {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          });
          res.on('end', () => {
            callback(null, Buffer.concat(chunks));
          });
        });
    const fits = await preview(adminA, companyA, { text: GREEK_GIFT }, 'preview-ok');
    expect(fits.status).toBe(200);
    expect(fits.headers['content-type']).toContain('application/pdf');
    expect(fits.headers['cache-control']).toBe('no-store');
    expect(fits.headers['x-gift-fits']).toBe('true');
    expect(fits.headers['x-gift-unsupported']).toBe('0');
    expect((fits.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const overflow = await preview(adminA, companyA, { text: 'Many happy returns! '.repeat(100) }, 'preview-long');
    expect(overflow.status).toBe(200);
    expect(overflow.headers['x-gift-fits']).toBe('false');

    expect((await preview(adminA, companyA, { text: '' }, 'preview-empty')).status).toBe(400);
    expect((await preview(adminA, companyA, { text: 'x'.repeat(2001) }, 'preview-big')).status).toBe(400);
    expect((await preview(adminA, companyA, { text: 'x', extra: 1 }, 'preview-extra')).status).toBe(400);
    expect((await preview(fulfil, companyA, { text: 'x' }, 'preview-fulfil')).status).toBe(403);
    expect((await preview(adminB, companyB, { text: 'x' }, 'preview-foreign')).status).toBe(404);
  });

  it('audits company switch changes and refuses outbound.all', async () => {
    const listed = await send(adminA, 'get', `/api/c/${companyA}/automation/switches`);
    expect(listed.status, text(listed)).toBe(200);
    const switches = arrayOf(record(bodyOf(listed)).switches).map((item) => record(item));
    expect(switches.map((item) => item.key).sort()).toEqual(
      [
        'email.send',
        'invoice.issue_real',
        'marketing.send',
        'printing',
        'shipment.book',
        'social.publish',
        'store.write',
      ].sort(),
    );
    expect(switches.some((item) => item.key === 'outbound.all')).toBe(false);
    const printing = switches.find((item) => item.key === 'printing');
    const email = switches.find((item) => item.key === 'email.send');
    if (
      !printing ||
      typeof printing.enabled !== 'boolean' ||
      !email ||
      typeof email.enabled !== 'boolean'
    ) {
      throw new Error('company switches were not listed');
    }
    const printingEnabled = printing.enabled;
    const emailEnabled = email.enabled;
    try {
      const missingReason = await send(
        adminA,
        'put',
        `/api/c/${companyA}/automation/switches/printing`,
        cid('switch-reason'),
        {
          enabled: !printingEnabled,
        },
      );
      expect(missingReason.status, text(missingReason)).toBe(400);
      expect(await auditEvents(app, cid('switch-reason'), companyA)).toEqual([]);
      await expectDenied(
        await send(
          adminA,
          'put',
          `/api/c/${companyA}/automation/switches/outbound.all`,
          cid('switch-global'),
          {
            enabled: false,
            reason: 'company admin must not change the global switch',
          },
        ),
        404,
        cid('switch-global'),
        companyA,
        'switch_not_in_company',
      );
      await expectDenied(
        await send(
          fulfil,
          'put',
          `/api/c/${companyA}/automation/switches/printing`,
          cid('fulfil-switch'),
          {
            enabled: !printingEnabled,
            reason: 'fulfilment must not toggle switches',
          },
        ),
        403,
        cid('fulfil-switch'),
        companyA,
        'permission_missing',
      );
      const changed = await send(
        adminA,
        'put',
        `/api/c/${companyA}/automation/switches/printing`,
        cid('switch-update'),
        {
          enabled: !printingEnabled,
          reason: `c2b1 printing ${runId}`,
        },
      );
      expect(changed.status, text(changed)).toBe(200);
      const events = await auditEvents(app, cid('switch-update'), companyA);
      expect(events).toEqual([
        expect.objectContaining({
          action: 'automation_switch.updated',
          outcome: 'success',
          objectType: 'automation_switch',
        }),
      ]);
      const details = events[0]?.details;
      expect(detailField(details, 'key')).toBe('printing');
      expect(detailField(details, 'reason')).toBe(`c2b1 printing ${runId}`);
      expect(isRecord(details) ? details.previousEnabled : undefined).toBe(printingEnabled);
      expect(isRecord(details) ? details.enabled : undefined).toBe(!printingEnabled);
      const during = await send(adminB, 'get', `/api/c/${companyB}/automation/switches`);
      expect(during.status, text(during)).toBe(200);
      const companyBPrinting = arrayOf(record(bodyOf(during)).switches)
        .map((item) => record(item))
        .find((item) => item.key === 'printing');
      expect(companyBPrinting?.enabled).toBe(false);
      const dotted = await send(
        adminA,
        'put',
        `/api/c/${companyA}/automation/switches/email.send`,
        cid('switch-dot'),
        {
          enabled: !emailEnabled,
          reason: `c2b1 email ${runId}`,
        },
      );
      expect(dotted.status, text(dotted)).toBe(200);
      expect(
        detailField((await auditEvents(app, cid('switch-dot'), companyA))[0]?.details, 'key'),
      ).toBe('email.send');
    } finally {
      if (app) {
        const restorePrinting = await send(
          adminA,
          'put',
          `/api/c/${companyA}/automation/switches/printing`,
          cid('switch-restore'),
          {
            enabled: printingEnabled,
            reason: `c2b1 restore printing ${runId}`,
          },
        );
        expect(restorePrinting.status, text(restorePrinting)).toBe(200);
        const restoreEmail = await send(
          adminA,
          'put',
          `/api/c/${companyA}/automation/switches/email.send`,
          cid('switch-restore-email'),
          {
            enabled: emailEnabled,
            reason: `c2b1 restore email ${runId}`,
          },
        );
        expect(restoreEmail.status, text(restoreEmail)).toBe(200);
      }
    }
    const after = await send(adminA, 'get', `/api/c/${companyA}/automation/switches`);
    const restoredPrinting = arrayOf(record(bodyOf(after)).switches)
      .map((item) => record(item))
      .find((item) => item.key === 'printing');
    expect(restoredPrinting?.enabled).toBe(true);
  });

  it('returns an audited 404 when the stored bytes are gone and does not log the path', async () => {
    const id = randomUUID();
    const stamped = new Date();
    const bytes = Buffer.from(`%PDF-1.4 missing ${runId}`);
    const key = storageKey({ companyId: companyA, kind: 'packing_slip', id, at: stamped });
    await storage.put(key, bytes);
    await withCompany(companyA, (tx) =>
      tx.storedFile.create({
        data: storedFile(
          companyA,
          id,
          'packing_slip',
          adminUserId,
          stamped,
          bytes,
          'order',
          shopifyOrderId,
        ),
      }),
    );
    await rm(join(storageRoot, key));
    const mark = logText().length;
    try {
      const response = await fetchPdf(
        adminA,
        `/api/c/${companyA}/files/${id}`,
        cid('file-missing'),
      );
      await expectDenied(response, 404, cid('file-missing'), companyA, 'not_found');
      const body = bufferOf(response).toString('utf8');
      expect(body).not.toContain(storageRoot);
      expect(body).not.toContain(key);
      expect(body).not.toContain('ENOENT');
      const logged = logText().slice(mark);
      expect(logged).not.toContain(storageRoot);
      expect(logged).not.toContain(key);
      expect(logged).not.toContain('ENOENT');
    } finally {
      await withCompany(companyA, (tx) => tx.storedFile.deleteMany({ where: { id } }));
    }
  });

  it('sends nothing and audits file.integrity_failed when the stored bytes were changed', async () => {
    const id = randomUUID();
    const stamped = new Date();
    const bytes = Buffer.from(`%PDF-1.4 sealed ${runId}`);
    const key = storageKey({ companyId: companyA, kind: 'packing_slip', id, at: stamped });
    await storage.put(key, bytes);
    await withCompany(companyA, (tx) =>
      tx.storedFile.create({
        data: storedFile(
          companyA,
          id,
          'packing_slip',
          adminUserId,
          stamped,
          bytes,
          'order',
          shopifyOrderId,
        ),
      }),
    );
    // Same length, one byte changed: only the hash can tell.
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] = tampered[tampered.length - 1] === 0x30 ? 0x31 : 0x30;
    await writeFile(join(storageRoot, key), tampered);
    try {
      const correlationId = cid('file-tampered');
      const response = await fetchPdf(adminA, `/api/c/${companyA}/files/${id}`, correlationId);
      expect(response.status, preview(response)).toBe(409);
      const body = bufferOf(response).toString('utf8');
      expect(body).not.toContain('%PDF');
      expect(body).toContain('file_integrity_failed');
      const events = await auditEvents(app, correlationId, companyA);
      expect(events.map((event) => [event.action, event.outcome, event.objectId])).toEqual([
        ['file.integrity_failed', 'failure', id],
      ]);
    } finally {
      await withCompany(companyA, (tx) => tx.storedFile.deleteMany({ where: { id } }));
    }
  });

  it('refuses a packing slip or gift message without a resolvable order', async () => {
    const slipId = randomUUID();
    const giftId = randomUUID();
    const stamped = new Date();
    const slipBytes = Buffer.from(`%PDF-1.4 loose-slip ${runId}`);
    const giftBytes = Buffer.from(`%PDF-1.4 loose-gift ${runId}`);
    await storage.put(
      storageKey({ companyId: companyA, kind: 'packing_slip', id: slipId, at: stamped }),
      slipBytes,
    );
    await storage.put(
      storageKey({ companyId: companyA, kind: 'gift_message', id: giftId, at: stamped }),
      giftBytes,
    );
    await withCompany(companyA, async (tx) => {
      await tx.storedFile.create({
        data: storedFile(
          companyA,
          slipId,
          'packing_slip',
          adminUserId,
          stamped,
          slipBytes,
          null,
          null,
        ),
      });
      await tx.storedFile.create({
        data: storedFile(
          companyA,
          giftId,
          'gift_message',
          adminUserId,
          stamped,
          giftBytes,
          'order',
          randomUUID(),
        ),
      });
    });
    try {
      await expectDenied(
        await fetchPdf(adminA, `/api/c/${companyA}/files/${slipId}`, cid('loose-slip')),
        404,
        cid('loose-slip'),
        companyA,
        'out_of_scope',
      );
      await expectDenied(
        await fetchPdf(adminA, `/api/c/${companyA}/files/${giftId}`, cid('loose-gift')),
        404,
        cid('loose-gift'),
        companyA,
        'out_of_scope',
      );
    } finally {
      await withCompany(companyA, (tx) =>
        tx.storedFile.deleteMany({ where: { id: { in: [slipId, giftId] } } }),
      );
    }
  });

  it('rejects template measurements outside the column and the allowed range', async () => {
    const rejected = [
      { pageWidthMm: '10000.00' },
      { pageWidthMm: '19.99' },
      { pageWidthMm: '500.01' },
      { pageHeightMm: '19.99' },
      { pageHeightMm: '500.01' },
      { marginLeftMm: '74.00' },
      { marginTopMm: '52.50' },
      { marginLeftMm: '-0.01' },
      { fontSizePt: '3.99' },
      { fontSizePt: '72.01' },
      { minFontSizePt: '3.99' },
      { minFontSizePt: '72.01' },
      { fontSizePt: '10.00', minFontSizePt: '10.01' },
      { lineHeight: '0.799' },
      { lineHeight: '3.001' },
    ];
    for (const [index, body] of rejected.entries()) {
      const correlationId = cid(`template-bound-${String(index)}`);
      const response = await send(
        adminA,
        'patch',
        `/api/c/${companyA}/gift-message-templates/${templateId}`,
        correlationId,
        body,
      );
      expect(response.status, text(response)).toBe(400);
      expect(await auditEvents(app, correlationId, companyA)).toEqual([]);
    }
    const low = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/gift-message-templates/${templateId}`,
      cid('template-low'),
      {
        pageWidthMm: '20.00',
        pageHeightMm: '20.00',
        marginTopMm: '0.00',
        marginRightMm: '0.00',
        marginBottomMm: '0.00',
        marginLeftMm: '0.00',
        fontSizePt: '4.00',
        minFontSizePt: '4.00',
        lineHeight: '0.800',
      },
    );
    expect(low.status, text(low)).toBe(200);
    const high = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/gift-message-templates/${templateId}`,
      cid('template-high'),
      {
        pageWidthMm: '500.00',
        pageHeightMm: '500.00',
        marginTopMm: '249.99',
        marginRightMm: '249.99',
        marginBottomMm: '249.99',
        marginLeftMm: '249.99',
        fontSizePt: '72.00',
        minFontSizePt: '72.00',
        lineHeight: '3.000',
      },
    );
    expect(high.status, text(high)).toBe(200);
    const card = record(record(bodyOf(high)).template);
    expect(card.pageWidthMm).toBe('500.00');
    expect(card.marginLeftMm).toBe('249.99');
    expect(card.fontSizePt).toBe('72.00');
    expect(card.minFontSizePt).toBe('72.00');
    expect(card.lineHeight).toBe('3.000');
    const restored = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/gift-message-templates/${templateId}`,
      cid('template-bounds-restore'),
      {
        name: templateName,
        pageWidthMm: '148.00',
        pageHeightMm: '105.00',
        marginTopMm: '12.00',
        marginRightMm: '12.00',
        marginBottomMm: '12.00',
        marginLeftMm: '12.00',
        fontSizePt: '16.00',
        minFontSizePt: '10.00',
        lineHeight: '1.200',
        align: 'center',
        verticalAlign: 'middle',
        isDefault: true,
      },
    );
    expect(restored.status, text(restored)).toBe(200);
  });

  it('keeps one default when two templates are switched together', async () => {
    const documents = started().get(DocumentService);
    const second = await withCompany(companyA, (tx) =>
      tx.giftMessageTemplate.create({
        data: {
          companyId: companyA,
          name: `Second card ${runId}`,
          pageWidthMm: '148.00',
          pageHeightMm: '105.00',
          marginTopMm: '12.00',
          marginRightMm: '12.00',
          marginBottomMm: '12.00',
          marginLeftMm: '12.00',
          fontSizePt: '16.00',
          minFontSizePt: '10.00',
          lineHeight: '1.200',
          align: 'center',
          verticalAlign: 'middle',
          isDefault: false,
        },
        select: { id: true },
      }),
    );
    const gate = defer();
    const inside = defer();
    let paused = false;
    documents.hooks = {
      beforeTemplateSave: async () => {
        if (paused) {
          return;
        }
        paused = true;
        inside.resolve();
        await gate.promise;
      },
    };
    try {
      const first = send(
        adminA,
        'patch',
        `/api/c/${companyA}/gift-message-templates/${second.id}`,
        cid('default-b'),
        {
          isDefault: true,
        },
      );
      startRequest(first);
      await inside.promise;
      const other = send(
        adminA,
        'patch',
        `/api/c/${companyA}/gift-message-templates/${templateId}`,
        cid('default-a'),
        {
          isDefault: true,
        },
      );
      startRequest(other);
      await delay(150);
      gate.resolve();
      const [left, right] = await Promise.all([first, other]);
      expect(left.status, text(left)).toBe(200);
      expect(right.status, text(right)).toBe(200);
      const rows = await withCompany(companyA, (tx) =>
        tx.giftMessageTemplate.findMany({
          where: { companyId: companyA },
          select: { id: true, isDefault: true, name: true },
        }),
      );
      expect(rows.filter((row) => row.isDefault)).toHaveLength(1);
      const renamed = rows.find((row) => row.id === second.id);
      expect(renamed?.name).toBe(`Second card ${runId}`);
    } finally {
      gate.resolve();
      documents.hooks = null;
      await send(
        adminA,
        'patch',
        `/api/c/${companyA}/gift-message-templates/${templateId}`,
        cid('default-restore'),
        {
          isDefault: true,
          name: templateName,
        },
      );
      await withCompany(companyA, (tx) =>
        tx.giftMessageTemplate.deleteMany({ where: { id: second.id } }),
      );
    }
  });

  it('chains concurrent switch audits from the locked previous value', async () => {
    const switches = started().get(CompanyAutomationService);
    const before = await send(adminA, 'get', `/api/c/${companyA}/automation/switches`);
    const shipment = arrayOf(record(bodyOf(before)).switches)
      .map((item) => record(item))
      .find((item) => item.key === 'shipment.book');
    if (!shipment || typeof shipment.enabled !== 'boolean') {
      throw new Error('shipment.book was not listed');
    }
    const start = shipment.enabled;
    const gate = defer();
    const inside = defer();
    let paused = false;
    switches.hooks = {
      beforeSwitchWrite: async () => {
        if (paused) {
          return;
        }
        paused = true;
        inside.resolve();
        await gate.promise;
      },
    };
    try {
      const enabling = send(
        adminA,
        'put',
        `/api/c/${companyA}/automation/switches/shipment.book`,
        cid('switch-race-on'),
        {
          enabled: true,
          reason: `c2b1 race on ${runId}`,
        },
      );
      startRequest(enabling);
      await inside.promise;
      const disabling = send(
        adminA,
        'put',
        `/api/c/${companyA}/automation/switches/shipment.book`,
        cid('switch-race-off'),
        {
          enabled: false,
          reason: `c2b1 race off ${runId}`,
        },
      );
      startRequest(disabling);
      await delay(150);
      gate.resolve();
      const [left, right] = await Promise.all([enabling, disabling]);
      expect(left.status, text(left)).toBe(200);
      expect(right.status, text(right)).toBe(200);
      const events = [
        ...(await auditEvents(app, cid('switch-race-on'), companyA)),
        ...(await auditEvents(app, cid('switch-race-off'), companyA)),
      ];
      const changes = events.map((event) => ({
        previous: booleanDetail(event.details, 'previousEnabled'),
        enabled: booleanDetail(event.details, 'enabled'),
      }));
      expect(changes).toHaveLength(2);
      const after = await send(adminA, 'get', `/api/c/${companyA}/automation/switches`);
      const finalRow = arrayOf(record(bodyOf(after)).switches)
        .map((item) => record(item))
        .find((item) => item.key === 'shipment.book');
      expect(typeof finalRow?.enabled).toBe('boolean');
      expect(switchChain(changes, start, finalRow?.enabled === true)).toBe(true);
    } finally {
      gate.resolve();
      switches.hooks = null;
      await send(
        adminA,
        'put',
        `/api/c/${companyA}/automation/switches/shipment.book`,
        cid('switch-race-restore'),
        {
          enabled: start,
          reason: `c2b1 race restore ${runId}`,
        },
      );
    }
  });
});

function storedFile(
  companyId: string,
  id: string,
  kind: 'packing_slip' | 'invoice_pdf' | 'gift_message' | 'test_print',
  createdById: string,
  at: Date,
  bytes: Buffer,
  sourceType: string | null,
  sourceId: string | null,
) {
  return {
    id,
    companyId,
    kind,
    storageKey: storageKey({ companyId, kind, id, at }),
    contentType: 'application/pdf',
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sourceType,
    sourceId,
    createdById,
  };
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

function logText(): string {
  return logChunks.join('');
}

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Supertest does not send until something attaches to the thenable. */
function startRequest(pending: Promise<request.Response>): void {
  void pending.then(
    () => undefined,
    () => undefined,
  );
}

function booleanDetail(details: unknown, key: string): boolean {
  if (!isRecord(details) || typeof details[key] !== 'boolean') {
    throw new Error(`${key} is missing`);
  }
  return details[key];
}

function switchChain(
  changes: { previous: boolean; enabled: boolean }[],
  start: boolean,
  finalEnabled: boolean,
): boolean {
  const [first, second] = changes;
  if (!first || !second) {
    return false;
  }
  return [
    [first, second],
    [second, first],
  ].some(([earlier, later]) => {
    if (!earlier || !later) {
      return false;
    }
    return (
      earlier.previous === start &&
      later.previous === earlier.enabled &&
      later.enabled === finalEnabled
    );
  });
}

async function bootApp(): Promise<INestApplication> {
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      logChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
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

function withCompany<T>(companyId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return new TenantDb(started().get(PrismaService).client).run(
    { companyId, actor: 'documents-test', correlationId: `c2b1-db-${runId}` },
    fn,
  );
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
  payload?: unknown,
) {
  const call = session.agent[method](url).set('X-XSRF-TOKEN', session.xsrf);
  if (correlationId) {
    call.set('X-Correlation-Id', correlationId);
  }
  if (payload !== undefined && payload !== null && typeof payload === 'object') {
    call.send(payload);
  }
  return call;
}

function fetchPdf(session: Session, url: string, correlationId?: string) {
  const call = session.agent
    .get(url)
    .set('X-XSRF-TOKEN', session.xsrf)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer | string) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      res.on('end', () => {
        callback(null, Buffer.concat(chunks));
      });
    });
  if (correlationId) {
    call.set('X-Correlation-Id', correlationId);
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

async function expectDenied(
  response: request.Response,
  status: number,
  correlationId: string,
  companyId: string,
  reason: string,
): Promise<void> {
  expect(response.status, preview(response)).toBe(status);
  const events = await auditEvents(app, correlationId, companyId);
  expect(events.length).toBeGreaterThan(0);
  expect(events[0]?.action).toBe('authorization.denied');
  expect(detailReason(events[0]?.details)).toBe(reason);
}

async function jobIds(session: Session, companyId: string): Promise<string[]> {
  const ids: string[] = [];
  let page = 1;
  let total = 0;
  do {
    const response = await send(
      session,
      'get',
      `/api/c/${companyId}/automation/jobs?pageSize=100&page=${String(page)}`,
    );
    expect(response.status, text(response)).toBe(200);
    const body = record(bodyOf(response));
    total = numberField(body, 'total');
    ids.push(...idsOf(body.jobs));
    page += 1;
  } while (ids.length < total && page <= 20);
  return ids;
}

function cid(name: string): string {
  return `c2b1-${name}-${runId}`.slice(0, 64);
}

function bodyOf(response: request.Response): unknown {
  return response.body as unknown;
}

function bufferOf(response: request.Response): Buffer {
  if (Buffer.isBuffer(response.body)) {
    return response.body;
  }
  throw new Error('expected a buffer');
}

function preview(response: request.Response): string {
  if (Buffer.isBuffer(response.body)) {
    return response.body.subarray(0, 400).toString('utf8');
  }
  return JSON.stringify(response.body);
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
  if (typeof field !== 'string') {
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

function idsOf(value: unknown): string[] {
  return arrayOf(value).map((item) => stringField(record(item), 'id'));
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

type PdfItem = { str?: string; hasEOL?: boolean; transform?: number[] };

type PdfDoc = {
  numPages: number;
  getPage: (page: number) => Promise<{
    getViewport: (input: { scale: number }) => { width: number; height: number };
    getTextContent: () => Promise<{ items: PdfItem[] }>;
  }>;
};

async function readPdf(
  pdf: Buffer,
): Promise<{
  text: string;
  width: number;
  height: number;
  pages: number;
  lines: { text: string; y: number }[];
}> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
    getDocument: (src: { data: Uint8Array; isEvalSupported?: boolean }) => {
      promise: Promise<PdfDoc>;
    };
  };
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), isEvalSupported: false })
    .promise;
  const parts: string[] = [];
  const positioned: { str: string; x: number; y: number }[] = [];
  let width = 0;
  let height = 0;
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    if (pageNumber === 1) {
      width = viewport.width;
      height = viewport.height;
    }
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (typeof item.str === 'string') {
        parts.push(item.str);
        const x = item.transform?.[4];
        const y = item.transform?.[5];
        if (typeof x === 'number' && typeof y === 'number') {
          positioned.push({ str: item.str, x, y });
        }
      }
      if (item.hasEOL) {
        parts.push('\n');
      }
    }
  }
  const text = parts.join('');
  const groups: { y: number; items: { str: string; x: number }[] }[] = [];
  for (const item of positioned) {
    if (item.str.length === 0) {
      continue;
    }
    const group = groups.find((candidate) => Math.abs(candidate.y - item.y) <= 1);
    if (group) {
      group.items.push(item);
      continue;
    }
    groups.push({ y: item.y, items: [{ str: item.str, x: item.x }] });
  }
  groups.sort((left, right) => right.y - left.y);
  const lines = groups.map((group) => ({
    y: group.y,
    text: [...group.items]
      .sort((left, right) => left.x - right.x)
      .map((item) => item.str)
      .join(''),
  }));
  return {
    text: text.endsWith('\n') ? text.slice(0, -1) : text,
    width,
    height,
    pages: doc.numPages,
    lines,
  };
}
