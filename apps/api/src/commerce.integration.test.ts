import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
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
import { cancelQueuedJobs } from './test/cancel-queued-jobs';
import { PrismaService } from './database/prisma.service';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { LOG_STREAM } from './logging/logging.module';

const COMPANY_A = 'Demo Company A Ltd (fictional)';
const COMPANY_B = 'Demo Company B Ltd (fictional)';
const SEEDED_CLIENT = 'Demo Gifts Ltd (fictional)';
const WATERMARK = 'DRAFT – NOT A TAX INVOICE / ΠΡΟΣΧΕΔΙΟ – ΔΕΝ ΑΠΟΤΕΛΕΙ ΦΟΡΟΛΟΓΙΚΟ ΤΙΜΟΛΟΓΙΟ';
const runId = randomUUID().slice(0, 8);

type Agent = ReturnType<typeof request.agent>;
type Session = { agent: Agent; xsrf: string };
type LineSpec = {
  position?: number;
  quantity?: string;
  unitPrice?: string;
  discountPercent?: string;
  tax: string;
  description?: string;
};

describe('clients, catalogue and invoice drafts', () => {
  let app: INestApplication | undefined;
  let companyA = '';
  let companyB = '';
  let adminA: Session;
  let adminB: Session;
  let fulfil: Session;
  let support: Session;
  let ops: Session;
  let taxA: Record<string, string> = {};
  let taxB: Record<string, string> = {};

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
    adminA = await login(app, 'admin.a@example.test');
    adminB = await login(app, 'admin.b@example.test');
    fulfil = await login(app, 'fulfil.a@example.test');
    support = await login(app, 'support.a@example.test');
    ops = await login(app, 'ops.a@example.test');
    taxA = await taxCodeIds(adminA, companyA);
    taxB = await taxCodeIds(adminB, companyB);
    expect(taxA.STD19).toEqual(expect.any(String));
    expect(taxA.RED5).toEqual(expect.any(String));
    expect(taxA.RED9).toEqual(expect.any(String));
    expect(taxA.ZERO).toEqual(expect.any(String));
    expect(Object.keys(taxA).sort()).toEqual(Object.keys(taxB).sort());
    expect(Object.values(taxA).some((id) => Object.values(taxB).includes(id))).toBe(false);
  }, 120_000);

  afterAll(async () => {
    await cancelQueuedJobs(app, [companyA, companyB]);
    await app?.close();
  });

  it('creates, edits, archives and duplicate-checks clients inside one company', async () => {
    const createdId = cid('client-create');
    const displayName = `C1 ${runId} Harbour Limited`;
    const created = await send(adminA, 'post', `/api/c/${companyA}/clients`, createdId, {
      kind: 'organisation',
      displayName,
      legalName: `  Harbour   Limited ${runId}  `,
      email: `harbour.${runId}@example.test`,
      vatNumber: `CY${runId.toUpperCase()}`,
      notes: 'keep\n  the break  ',
      defaultLanguage: 'en',
      paymentTermsDays: 30,
      contacts: [{ name: '  Desk  ', email: `desk.${runId}@example.test`, isPrimary: true }],
      addresses: [
        {
          kind: 'billing',
          line1: '1 Warehouse  Road',
          city: 'Nicosia',
          countryCode: 'CY',
          isDefault: true,
        },
      ],
    });
    expect(created.status, text(created)).toBe(200);
    const client = record(record(bodyOf(created)).client);
    expect(client.displayName).toBe(displayName);
    expect(client.legalName).toBe(`  Harbour   Limited ${runId}  `);
    expect(client.notes).toBe('keep\n  the break  ');
    expect(client.version).toBe(0);
    expect(record(arrayOf(client.contacts)[0]).name).toBe('  Desk  ');
    expect(record(arrayOf(client.addresses)[0]).countryCode).toBe('CY');
    const clientId = stringField(client, 'id');
    const createdAudit = await auditEvents(app, createdId, companyA);
    expect(createdAudit).toEqual([
      expect.objectContaining({
        action: 'client.created',
        objectType: 'client',
        objectId: clientId,
        outcome: 'success',
        correlationId: createdId,
      }),
    ]);

    const renamedId = cid('client-rename');
    const contactId = stringField(record(arrayOf(client.contacts)[0]), 'id');
    const addressId = stringField(record(arrayOf(client.addresses)[0]), 'id');
    const renamed = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/clients/${clientId}`,
      renamedId,
      {
        expectedVersion: 0,
        contacts: [{ id: contactId, name: 'Reception', isPrimary: true }],
        addresses: [
          {
            id: addressId,
            kind: 'billing',
            line1: '1 Warehouse  Road',
            city: 'Nicosia',
            countryCode: 'CY',
            isDefault: true,
          },
        ],
      },
    );
    expect(renamed.status, text(renamed)).toBe(200);
    const edited = record(record(bodyOf(renamed)).client);
    expect(edited.version).toBe(1);
    expect(record(arrayOf(edited.contacts)[0]).name).toBe('Reception');
    const renamedAudit = await auditEvents(app, renamedId, companyA);
    expect(renamedAudit[0]).toEqual(
      expect.objectContaining({
        action: 'client.updated',
        outcome: 'success',
        correlationId: renamedId,
      }),
    );

    const duplicate = await send(
      adminA,
      'post',
      `/api/c/${companyA}/clients/duplicate-check`,
      undefined,
      {
        displayName: `C1 ${runId} Harbour Ltd.`,
      },
    );
    expect(duplicate.status, text(duplicate)).toBe(200);
    const nameMatches = arrayOf(record(bodyOf(duplicate)).matches).map((item) => record(item));
    expect(
      nameMatches.some(
        (match) => match.id === clientId && arrayOf(match.matchedOn).includes('name'),
      ),
    ).toBe(true);
    const emailMatch = await send(
      adminA,
      'post',
      `/api/c/${companyA}/clients/duplicate-check`,
      undefined,
      {
        email: `HARBOUR.${runId}@example.test`,
      },
    );
    expect(
      arrayOf(record(bodyOf(emailMatch)).matches).some((item) => record(item).id === clientId),
    ).toBe(true);
    const otherCompany = await send(
      adminB,
      'post',
      `/api/c/${companyB}/clients/duplicate-check`,
      undefined,
      {
        displayName: `C1 ${runId} Harbour Ltd.`,
        email: `harbour.${runId}@example.test`,
        vatNumber: `cy${runId}`,
      },
    );
    expect(otherCompany.status, text(otherCompany)).toBe(200);
    expect(arrayOf(record(bodyOf(otherCompany)).matches)).toEqual([]);

    const staleId = cid('client-stale');
    const stale = await send(adminA, 'patch', `/api/c/${companyA}/clients/${clientId}`, staleId, {
      expectedVersion: 0,
      notes: 'stale',
    });
    expect(stale.status).toBe(409);
    expect(errorCode(bodyOf(stale))).toBe('conflict');
    const staleAudit = await auditEvents(app, staleId, companyA);
    expect(staleAudit[0]).toEqual(
      expect.objectContaining({
        action: 'client.update',
        outcome: 'failure',
        correlationId: staleId,
      }),
    );
    expect(detailReason(staleAudit[0]?.details)).toBe('version_conflict');

    const leftId = cid('client-race-left');
    const rightId = cid('client-race-right');
    const [left, right] = await Promise.all([
      send(adminA, 'patch', `/api/c/${companyA}/clients/${clientId}`, leftId, {
        expectedVersion: 1,
        notes: 'left',
      }),
      send(adminA, 'patch', `/api/c/${companyA}/clients/${clientId}`, rightId, {
        expectedVersion: 1,
        notes: 'right',
      }),
    ]);
    const statuses = [left.status, right.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    const loser = left.status === 409 ? leftId : rightId;
    const loserAudit = await auditEvents(app, loser, companyA);
    expect(detailReason(loserAudit[0]?.details)).toBe('version_conflict');

    const current = await send(adminA, 'get', `/api/c/${companyA}/clients/${clientId}`);
    const version = record(record(bodyOf(current)).client).version;
    const archiveId = cid('client-archive');
    const archived = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/clients/${clientId}`,
      archiveId,
      {
        expectedVersion: version,
        archived: true,
      },
    );
    expect(archived.status, text(archived)).toBe(200);
    expect(record(record(bodyOf(archived)).client).archivedAt).toEqual(expect.any(String));
    const hidden = await send(adminA, 'get', `/api/c/${companyA}/clients`);
    expect(idsOf(record(bodyOf(hidden)).clients)).not.toContain(clientId);
    const shown = await send(adminA, 'get', `/api/c/${companyA}/clients?includeArchived=true`);
    expect(idsOf(record(bodyOf(shown)).clients)).toContain(clientId);
    const stillThere = await send(adminA, 'get', `/api/c/${companyA}/clients/${clientId}`);
    expect(stillThere.status).toBe(200);

    const blank = await send(adminA, 'post', `/api/c/${companyA}/clients`, undefined, {
      kind: 'individual',
      displayName: '   ',
    });
    expect(blank.status).toBe(400);
    expect(errorCode(bodyOf(blank))).toBe('bad_request');
    const twoPrimary = await send(adminA, 'post', `/api/c/${companyA}/clients`, undefined, {
      kind: 'organisation',
      displayName: `Two desks ${runId}`,
      contacts: [
        { name: 'One', isPrimary: true },
        { name: 'Two', isPrimary: true },
      ],
    });
    expect(twoPrimary.status).toBe(400);
  });

  it('lists tax codes for anyone who can view the catalogue and manages products without a version', async () => {
    const codes = await send(ops, 'get', `/api/c/${companyA}/tax-codes`);
    expect(codes.status, text(codes)).toBe(200);
    expect(arrayOf(record(bodyOf(codes)).taxCodes).map((item) => record(item).code)).toEqual(
      expect.arrayContaining(['STD19', 'RED5', 'RED9', 'ZERO', 'EXEMPT']),
    );
    const createId = cid('product-create');
    const created = await send(ops, 'post', `/api/c/${companyA}/products`, createId, {
      sku: `C1-${runId}`,
      name: `  Mixed nuts ${runId}  `,
      kind: 'product',
      unit: 'kg',
      unitPrice: '4.5000',
      pricesIncludeTax: true,
      taxCodeId: taxA.STD19,
    });
    expect(created.status, text(created)).toBe(200);
    const product = record(record(bodyOf(created)).product);
    expect(product.name).toBe(`  Mixed nuts ${runId}  `);
    expect(product.unitPrice).toBe('4.5000');
    const productId = stringField(product, 'id');
    const createdAudit = await auditEvents(app, createId, companyA);
    expect(createdAudit[0]).toEqual(
      expect.objectContaining({
        action: 'product.created',
        objectId: productId,
        outcome: 'success',
        correlationId: createId,
      }),
    );
    const updateId = cid('product-update');
    const updated = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/products/${productId}`,
      updateId,
      {
        name: `Mixed nuts ${runId}`,
        active: false,
      },
    );
    expect(updated.status, text(updated)).toBe(200);
    expect(record(record(bodyOf(updated)).product).active).toBe(false);
    const updateAudit = await auditEvents(app, updateId, companyA);
    expect(updateAudit[0]).toEqual(
      expect.objectContaining({
        action: 'product.updated',
        outcome: 'success',
        correlationId: updateId,
      }),
    );
    const active = await send(
      adminA,
      'get',
      `/api/c/${companyA}/products?active=true&q=${encodeURIComponent(runId)}`,
    );
    expect(idsOf(record(bodyOf(active)).products)).not.toContain(productId);
    const inactive = await send(
      adminA,
      'get',
      `/api/c/${companyA}/products?active=false&q=${encodeURIComponent(runId)}`,
    );
    expect(idsOf(record(bodyOf(inactive)).products)).toContain(productId);
    const numbered = await send(adminA, 'post', `/api/c/${companyA}/products`, undefined, {
      name: `Bad price ${runId}`,
      kind: 'service',
      unit: 'hour',
      unitPrice: 12.5,
      pricesIncludeTax: false,
      taxCodeId: taxA.STD19,
    });
    expect(numbered.status).toBe(400);
    expect(errorCode(bodyOf(numbered))).toBe('bad_request');
    expect(errorMessage(bodyOf(numbered))).toContain('JSON numbers are rejected');
    const supportDenied = cid('product-support');
    const denied = await send(support, 'post', `/api/c/${companyA}/products`, supportDenied, {
      name: `Support product ${runId}`,
      kind: 'product',
      unit: 'ea',
      unitPrice: '1.0000',
      pricesIncludeTax: false,
      taxCodeId: taxA.STD19,
    });
    expect(denied.status).toBe(403);
    expect(errorCode(bodyOf(denied))).toBe('forbidden');
    const deniedAudit = await auditEvents(app, supportDenied, companyA);
    expect(detailReason(deniedAudit[0]?.details)).toBe('permission_missing');
    expect(record(deniedAudit[0]?.details).permission).toBe('catalog.manage');
  });

  it('calculates E1–E9 through the API, ignores fake totals and rejects JSON numbers', async () => {
    const client = await createClient(adminA, companyA, {
      kind: 'organisation',
      displayName: `Totals ${runId}`,
      defaultLanguage: 'en',
      paymentTermsDays: 30,
    });
    const before = idsOf(
      record(bodyOf(await send(adminA, 'get', `/api/c/${companyA}/invoices`))).invoices,
    );
    const preview = await send(
      adminA,
      'post',
      `/api/c/${companyA}/invoices/preview-totals`,
      undefined,
      {
        pricesIncludeTax: false,
        subtotal: '999.99',
        total: '1.00',
        lines: [
          line(taxA, { quantity: '2', unitPrice: '10.00', discountPercent: '15', tax: 'STD19' }),
        ],
      },
    );
    expect(preview.status, text(preview)).toBe(200);
    expect(record(record(bodyOf(preview)).totals)).toMatchObject({
      subtotal: '20.00',
      discountTotal: '3.00',
      netTotal: '17.00',
      taxTotal: '3.23',
      total: '20.23',
    });
    const after = idsOf(
      record(bodyOf(await send(adminA, 'get', `/api/c/${companyA}/invoices`))).invoices,
    );
    expect(after).toEqual(before);

    const examples: {
      name: string;
      pricesIncludeTax: boolean;
      lines: LineSpec[];
      totals: Record<string, string>;
      lineNets?: string[];
      taxes?: string[];
    }[] = [
      {
        name: 'E1',
        pricesIncludeTax: false,
        lines: [{ quantity: '3', unitPrice: '0.3333', tax: 'STD19' }],
        totals: {
          subtotal: '1.00',
          discountTotal: '0.00',
          netTotal: '1.00',
          taxTotal: '0.19',
          total: '1.19',
        },
      },
      {
        name: 'E2',
        pricesIncludeTax: false,
        lines: [{ unitPrice: '0.125', tax: 'ZERO' }],
        totals: { netTotal: '0.13', taxTotal: '0.00', total: '0.13' },
      },
      {
        name: 'E3',
        pricesIncludeTax: false,
        lines: [{ unitPrice: '0.005', tax: 'ZERO' }],
        totals: { netTotal: '0.01', taxTotal: '0.00', total: '0.01' },
      },
      {
        name: 'E4',
        pricesIncludeTax: false,
        lines: [{ quantity: '2', unitPrice: '10.00', discountPercent: '15', tax: 'STD19' }],
        totals: {
          subtotal: '20.00',
          discountTotal: '3.00',
          netTotal: '17.00',
          taxTotal: '3.23',
          total: '20.23',
        },
      },
      {
        name: 'E5',
        pricesIncludeTax: false,
        lines: [
          { position: 1, unitPrice: '10.00', tax: 'STD19' },
          { position: 2, unitPrice: '5.00', tax: 'RED9' },
        ],
        totals: { taxTotal: '2.35', total: '17.35' },
        taxes: ['0.45', '1.90'],
      },
      {
        name: 'E6',
        pricesIncludeTax: true,
        lines: [{ unitPrice: '11.90', tax: 'STD19' }],
        totals: { netTotal: '10.00', taxTotal: '1.90', total: '11.90' },
      },
      {
        name: 'E7',
        pricesIncludeTax: true,
        lines: [
          { position: 1, unitPrice: '0.99', tax: 'STD19' },
          { position: 2, unitPrice: '0.99', tax: 'STD19' },
          { position: 3, unitPrice: '0.99', tax: 'STD19' },
        ],
        totals: { total: '2.97', netTotal: '2.50', taxTotal: '0.47' },
        lineNets: ['0.84', '0.83', '0.83'],
      },
      {
        name: 'E8',
        pricesIncludeTax: false,
        lines: [
          { position: 1, unitPrice: '0.05', tax: 'STD19' },
          { position: 2, unitPrice: '0.05', tax: 'STD19' },
          { position: 3, unitPrice: '0.05', tax: 'STD19' },
        ],
        totals: { total: '0.18' },
        taxes: ['0.03'],
      },
      {
        name: 'E9',
        pricesIncludeTax: false,
        lines: [{ unitPrice: '50.00', discountPercent: '100', tax: 'STD19' }],
        totals: { netTotal: '0.00', taxTotal: '0.00', total: '0.00' },
      },
    ];

    for (const example of examples) {
      const correlationId = cid(`invoice-${example.name}`);
      const response = await send(adminA, 'post', `/api/c/${companyA}/invoices`, correlationId, {
        clientId: client.id,
        pricesIncludeTax: example.pricesIncludeTax,
        issueDate: '2026-03-01',
        dueDate: '2026-03-31',
        reference: example.name,
        subtotal: '123456.78',
        discountTotal: '123456.78',
        netTotal: '123456.78',
        taxTotal: '123456.78',
        total: '123456.78',
        lines: example.lines.map((item, index) => ({
          ...line(taxA, item),
          position: item.position ?? index + 1,
          lineNet: '999.99',
          lineGross: '999.99',
        })),
      });
      expect(response.status, `${example.name} ${text(response)}`).toBe(200);
      const invoice = record(record(bodyOf(response)).invoice);
      expect(invoice).toMatchObject({
        status: 'draft',
        language: 'en',
        currency: 'EUR',
        ...example.totals,
      });
      expect(invoice.version).toBe(0);
      if (example.lineNets) {
        expect(arrayOf(invoice.lines).map((item) => record(item).lineNet)).toEqual(
          example.lineNets,
        );
      }
      if (example.taxes) {
        expect(arrayOf(invoice.taxSummary).map((item) => record(item).tax)).toEqual(example.taxes);
      }
      const firstLine = record(arrayOf(invoice.lines)[0]);
      expect(firstLine.taxRatePercent).toBe(
        example.lines[0]?.tax === 'RED9'
          ? '9.0000'
          : example.lines[0]?.tax === 'ZERO'
            ? '0.0000'
            : '19.0000',
      );
      const events = await auditEvents(app, correlationId, companyA);
      expect(events[0]).toEqual(
        expect.objectContaining({
          action: 'invoice.created',
          objectId: invoice.id,
          outcome: 'success',
          correlationId,
        }),
      );
    }

    const numbered = await send(adminA, 'post', `/api/c/${companyA}/invoices`, undefined, {
      clientId: client.id,
      pricesIncludeTax: false,
      lines: [{ ...line(taxA, { tax: 'STD19' }), unitPrice: 10, quantity: 1 }],
    });
    expect(numbered.status).toBe(400);
    expect(errorCode(bodyOf(numbered))).toBe('bad_request');
    expect(errorMessage(bodyOf(numbered))).toContain('JSON numbers are rejected');

    const greekName = `Μαρία Παπαδοπούλου ${runId}`;
    const greek = await createClient(adminA, companyA, {
      kind: 'individual',
      displayName: greekName,
      defaultLanguage: 'el',
      paymentTermsDays: 14,
    });
    const draftId = cid('invoice-draft');
    const draft = await send(adminA, 'post', `/api/c/${companyA}/invoices`, draftId, {
      documentType: 'quote',
      clientId: greek.id,
      pricesIncludeTax: false,
      issueDate: '2026-03-01',
      reference: `REF ${runId}`,
      notes: 'σημείωση\n  δεύτερη  ',
      lines: [
        line(taxA, {
          position: 1,
          unitPrice: '10.0000',
          tax: 'STD19',
          description: 'Mixed nuts (demo)',
        }),
        line(taxA, {
          position: 2,
          quantity: '1',
          unitPrice: '5.0000',
          tax: 'RED5',
          description: 'Ribbon',
        }),
      ],
    });
    expect(draft.status, text(draft)).toBe(200);
    const quote = record(record(bodyOf(draft)).invoice);
    expect(quote).toMatchObject({
      documentType: 'quote',
      language: 'el',
      dueDate: '2026-03-15',
      notes: 'σημείωση\n  δεύτερη  ',
      status: 'draft',
    });
    expect(quote.dueDate).toBe('2026-03-15');
    const quoteId = stringField(quote, 'id');
    const listed = await send(
      adminA,
      'get',
      `/api/c/${companyA}/invoices?status=draft&clientId=${greek.id}&from=2026-03-01&to=2026-03-01&q=${encodeURIComponent(`REF ${runId}`)}`,
    );
    expect(listed.status, text(listed)).toBe(200);
    expect(idsOf(record(bodyOf(listed)).invoices)).toEqual([quoteId]);
    const badStatus = await send(adminA, 'get', `/api/c/${companyA}/invoices?status=nope`);
    expect(badStatus.status).toBe(400);
    const badDate = await send(adminA, 'get', `/api/c/${companyA}/invoices?from=2026-13-40`);
    expect(badDate.status).toBe(400);

    const patchedId = cid('invoice-patch');
    const patched = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/invoices/${quoteId}`,
      patchedId,
      {
        expectedVersion: 0,
        notes: 'σημείωση\n  δεύτερη  ',
        dueDate: null,
      },
    );
    expect(patched.status, text(patched)).toBe(200);
    expect(record(record(bodyOf(patched)).invoice).dueDate).toBeNull();
    expect(record(record(bodyOf(patched)).invoice).version).toBe(1);
    const patchAudit = await auditEvents(app, patchedId, companyA);
    expect(patchAudit[0]).toEqual(
      expect.objectContaining({
        action: 'invoice.updated',
        outcome: 'success',
        correlationId: patchedId,
      }),
    );
    const conflictId = cid('invoice-conflict');
    const conflict = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/invoices/${quoteId}`,
      conflictId,
      {
        expectedVersion: 0,
        reference: 'stale',
      },
    );
    expect(conflict.status).toBe(409);
    expect(detailReason((await auditEvents(app, conflictId, companyA))[0]?.details)).toBe(
      'version_conflict',
    );

    const englishClient = arrayOf(
      record(
        bodyOf(
          await send(
            adminA,
            'get',
            `/api/c/${companyA}/clients?q=${encodeURIComponent(SEEDED_CLIENT)}`,
          ),
        ),
      ).clients,
    )
      .map((item) => record(item))
      .find((item) => item.displayName === SEEDED_CLIENT);
    if (!englishClient) {
      throw new Error('seeded client is missing');
    }
    const english = await send(
      adminA,
      'post',
      `/api/c/${companyA}/invoices`,
      cid('invoice-english'),
      {
        clientId: englishClient.id,
        pricesIncludeTax: false,
        issueDate: '2026-03-01',
        dueDate: '2026-03-31',
        lines: [line(taxA, { unitPrice: '10.00', tax: 'STD19', description: 'Gift box' })],
      },
    );
    expect(english.status, text(english)).toBe(200);
    const englishId = stringField(record(record(bodyOf(english)).invoice), 'id');
    const englishPdf = await fetchPdf(adminA, `/api/c/${companyA}/invoices/${englishId}/pdf`);
    expect(englishPdf.status, text(englishPdf)).toBe(200);
    expect(englishPdf.headers['content-type']).toMatch(/application\/pdf/);
    expect(englishPdf.headers['content-disposition']).toBe(
      `inline; filename="draft-${englishId}.pdf"`,
    );
    expect(englishPdf.headers['cache-control']).toBe('no-store');
    expect(englishPdf.headers['x-content-type-options']).toBe('nosniff');
    const englishBytes = bufferOf(englishPdf);
    expect(englishBytes.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    const englishText = flatten(await extractPdfText(englishBytes));
    expect(englishText).toContain(flatten(SEEDED_CLIENT));
    expect(englishText).toContain(flatten(WATERMARK));
    expect(englishText).toContain('Billto');

    const greekPdf = await fetchPdf(adminA, `/api/c/${companyA}/invoices/${quoteId}/pdf`);
    expect(greekPdf.headers['content-disposition']).toBe(`inline; filename="draft-${quoteId}.pdf"`);
    const greekText = flatten(await extractPdfText(bufferOf(greekPdf)));
    expect(greekText).toContain(flatten(greekName));
    expect(greekText).toContain(flatten(WATERMARK));
    expect(greekText).toContain('Πελάτης');

    // The seeded companies keep invoice.issue_real off, so nothing issues here.
    const issue = await send(
      adminA,
      'post',
      `/api/c/${companyA}/invoices/${quoteId}/issue`,
      undefined,
      { expectedVersion: 0 },
    );
    expect(issue.status).toBe(409);
    expect(errorCode(bodyOf(issue))).toBe('issuance_disabled');
  });

  it('hides the other company and denies fulfilment access to invoices', async () => {
    const client = await createClient(adminA, companyA, {
      kind: 'individual',
      displayName: `Isolated ${runId}`,
    });
    const productResponse = await send(adminA, 'post', `/api/c/${companyA}/products`, undefined, {
      sku: `ISO-${runId}`,
      name: `Isolated product ${runId}`,
      kind: 'product',
      unit: 'ea',
      unitPrice: '1.0000',
      pricesIncludeTax: false,
      taxCodeId: taxA.STD19,
    });
    expect(productResponse.status, text(productResponse)).toBe(200);
    const productId = stringField(record(record(bodyOf(productResponse)).product), 'id');
    const invoiceResponse = await send(adminA, 'post', `/api/c/${companyA}/invoices`, undefined, {
      clientId: client.id,
      pricesIncludeTax: false,
      lines: [line(taxA, { tax: 'STD19' })],
    });
    expect(invoiceResponse.status, text(invoiceResponse)).toBe(200);
    const invoiceId = stringField(record(record(bodyOf(invoiceResponse)).invoice), 'id');

    const clientMiss = cid('iso-client');
    const clientDenied = await send(
      adminB,
      'get',
      `/api/c/${companyB}/clients/${client.id}`,
      clientMiss,
    );
    expect(clientDenied.status).toBe(404);
    expect(errorCode(bodyOf(clientDenied))).toBe('not_found');
    expect(detailReason((await auditEvents(app, clientMiss, companyB))[0]?.details)).toBe(
      'client_not_found',
    );

    const productMiss = cid('iso-product');
    const productDenied = await send(
      adminB,
      'patch',
      `/api/c/${companyB}/products/${productId}`,
      productMiss,
      {
        name: 'hidden',
      },
    );
    expect(productDenied.status).toBe(404);
    expect(detailReason((await auditEvents(app, productMiss, companyB))[0]?.details)).toBe(
      'product_not_found',
    );

    const invoiceMiss = cid('iso-invoice');
    const invoiceDenied = await send(
      adminB,
      'get',
      `/api/c/${companyB}/invoices/${invoiceId}`,
      invoiceMiss,
    );
    expect(invoiceDenied.status).toBe(404);
    expect(detailReason((await auditEvents(app, invoiceMiss, companyB))[0]?.details)).toBe(
      'invoice_not_found',
    );

    const pdfMiss = cid('iso-pdf');
    const pdfDenied = await send(
      adminB,
      'get',
      `/api/c/${companyB}/invoices/${invoiceId}/pdf`,
      pdfMiss,
    );
    expect(pdfDenied.status).toBe(404);
    expect(detailReason((await auditEvents(app, pdfMiss, companyB))[0]?.details)).toBe(
      'invoice_not_found',
    );

    const taxMiss = cid('iso-tax');
    const taxOnInvoice = await send(adminB, 'post', `/api/c/${companyB}/invoices`, taxMiss, {
      clientId: client.id,
      pricesIncludeTax: false,
      lines: [line({ STD19: taxA.STD19 ?? '' }, { tax: 'STD19' })],
    });
    expect(taxOnInvoice.status).toBe(404);
    expect(detailReason((await auditEvents(app, taxMiss, companyB))[0]?.details)).toBe(
      'client_not_found',
    );

    const foreignTax = cid('iso-tax-code');
    const ownClient = await createClient(adminB, companyB, {
      kind: 'individual',
      displayName: `Company B ${runId}`,
    });
    const foreign = await send(adminB, 'post', `/api/c/${companyB}/invoices`, foreignTax, {
      clientId: ownClient.id,
      pricesIncludeTax: false,
      lines: [line({ STD19: taxA.STD19 ?? '' }, { tax: 'STD19' })],
    });
    expect(foreign.status).toBe(404);
    expect(detailReason((await auditEvents(app, foreignTax, companyB))[0]?.details)).toBe(
      'tax_code_not_found',
    );

    const urlMiss = cid('iso-url');
    const urlDenied = await send(adminB, 'get', `/api/c/${companyA}/clients/${client.id}`, urlMiss);
    expect(urlDenied.status).toBe(404);
    expect(detailReason((await auditEvents(app, urlMiss, companyA))[0]?.details)).toBe(
      'not_a_member',
    );

    const lists = await Promise.all([
      send(adminB, 'get', `/api/c/${companyB}/clients?includeArchived=true`),
      send(adminB, 'get', `/api/c/${companyB}/products`),
      send(adminB, 'get', `/api/c/${companyB}/invoices`),
      send(adminB, 'get', `/api/c/${companyB}/tax-codes`),
    ]);
    expect(idsOf(record(bodyOf(lists[0])).clients)).not.toContain(client.id);
    expect(idsOf(record(bodyOf(lists[1])).products)).not.toContain(productId);
    expect(idsOf(record(bodyOf(lists[2])).invoices)).not.toContain(invoiceId);
    expect(
      idsOf(record(bodyOf(lists[3])).taxCodes).some((id) => Object.values(taxA).includes(id)),
    ).toBe(false);

    const malformed = cid('iso-malformed');
    const badId = await send(adminA, 'get', `/api/c/${companyA}/clients/not-a-uuid`, malformed);
    expect(badId.status).toBe(404);
    expect(detailReason((await auditEvents(app, malformed, companyA))[0]?.details)).toBe(
      'client_not_found',
    );

    const listDenied = cid('fulfil-list');
    const fulfilList = await send(fulfil, 'get', `/api/c/${companyA}/invoices`, listDenied);
    expect(fulfilList.status).toBe(403);
    expect(errorCode(bodyOf(fulfilList))).toBe('forbidden');
    const listAudit = await auditEvents(app, listDenied, companyA);
    expect(detailReason(listAudit[0]?.details)).toBe('permission_missing');
    expect(record(listAudit[0]?.details).permission).toBe('invoice.view');

    const oneDenied = cid('fulfil-one');
    const fulfilOne = await send(
      fulfil,
      'get',
      `/api/c/${companyA}/invoices/${invoiceId}`,
      oneDenied,
    );
    expect(fulfilOne.status).toBe(403);
    const oneAudit = await auditEvents(app, oneDenied, companyA);
    expect(detailReason(oneAudit[0]?.details)).toBe('permission_missing');
    expect(record(oneAudit[0]?.details).permission).toBe('invoice.view');

    const manageDenied = cid('support-client');
    const supportWrite = await send(support, 'post', `/api/c/${companyA}/clients`, manageDenied, {
      kind: 'individual',
      displayName: `Support cannot ${runId}`,
    });
    expect(supportWrite.status).toBe(403);
    expect(record((await auditEvents(app, manageDenied, companyA))[0]?.details).permission).toBe(
      'client.manage',
    );
  });

  it('rejects a client currency other than the company one, and a company currency without two digits', async () => {
    if (!app) {
      throw new Error('the API was not started');
    }
    const prisma = app.get(PrismaService).client;
    const kwd = await createClient(adminA, companyA, {
      kind: 'organisation',
      displayName: `KWD ${runId}`,
      defaultCurrency: 'KWD',
    });
    const rejected = await send(adminA, 'post', `/api/c/${companyA}/invoices`, cid('kwd-invoice'), {
      clientId: kwd.id,
      pricesIncludeTax: false,
      lines: [line(taxA, { quantity: '1', unitPrice: '0.001', tax: 'ZERO' })],
    });
    // R2-B: drafts are in the company currency only, so a KWD client is refused before precision.
    expect(rejected.status, text(rejected)).toBe(422);
    expect(errorCode(bodyOf(rejected))).toBe('currency_not_supported');
    const stored = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.company_id', ${companyA}, true)`;
      return tx.invoice.count({ where: { companyId: companyA, clientId: kwd.id } });
    });
    expect(stored).toBe(0);

    const previous = await prisma.company.findUniqueOrThrow({ where: { id: companyB } });
    await prisma.company.update({ where: { id: companyB }, data: { defaultCurrency: 'KWD' } });
    try {
      const fallbackClient = await createClient(adminB, companyB, {
        kind: 'organisation',
        displayName: `Fallback ${runId}`,
      });
      const fallback = await send(adminB, 'post', `/api/c/${companyB}/invoices`, cid('kwd-fallback'), {
        clientId: fallbackClient.id,
        pricesIncludeTax: false,
        lines: [line(taxB, { quantity: '1', unitPrice: '0.001', tax: 'ZERO' })],
      });
      expect(fallback.status, text(fallback)).toBe(400);
      expect(errorMessage(bodyOf(fallback))).toBe('currency precision must be 2 digits');
    } finally {
      await prisma.company.update({
        where: { id: companyB },
        data: { defaultCurrency: previous.defaultCurrency },
      });
    }

    const eur = await createClient(adminA, companyA, {
      kind: 'organisation',
      displayName: `EUR ${runId}`,
    });
    const draft = await send(adminA, 'post', `/api/c/${companyA}/invoices`, cid('eur-draft'), {
      clientId: eur.id,
      pricesIncludeTax: false,
      lines: [line(taxA, { unitPrice: '10.00', tax: 'ZERO' })],
    });
    expect(draft.status, text(draft)).toBe(200);
    const invoiceId = stringField(record(record(bodyOf(draft)).invoice), 'id');
    const patched = await send(adminA, 'patch', `/api/c/${companyA}/invoices/${invoiceId}`, cid('kwd-patch'), {
      expectedVersion: 0,
      clientId: kwd.id,
    });
    expect(patched.status, text(patched)).toBe(422);
    expect(errorCode(bodyOf(patched))).toBe('currency_not_supported');
    const row = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.company_id', ${companyA}, true)`;
      return tx.invoice.findFirstOrThrow({ where: { id: invoiceId, companyId: companyA } });
    });
    expect(row.currency).toBe('EUR');
  });

  it('returns an audited 404 for a contact or address from another company', async () => {
    const createdA = await send(adminA, 'post', `/api/c/${companyA}/clients`, cid('iso-a'), {
      kind: 'organisation',
      displayName: `Iso A ${runId}`,
      contacts: [{ name: 'Ada', isPrimary: true }],
      addresses: [
        { kind: 'billing', line1: '1 Road', city: 'Nicosia', countryCode: 'CY', isDefault: true },
      ],
    });
    expect(createdA.status, text(createdA)).toBe(200);
    const clientA = record(record(bodyOf(createdA)).client);
    const contactId = stringField(record(arrayOf(clientA.contacts)[0]), 'id');
    const addressId = stringField(record(arrayOf(clientA.addresses)[0]), 'id');
    const clientB = await createClient(adminB, companyB, {
      kind: 'organisation',
      displayName: `Iso B ${runId}`,
      contacts: [{ name: 'Bea', isPrimary: true }],
      addresses: [
        { kind: 'billing', line1: '2 Road', city: 'Limassol', countryCode: 'CY', isDefault: true },
      ],
    });

    const contactDenied = cid('foreign-contact');
    const contact = await send(adminB, 'patch', `/api/c/${companyB}/clients/${clientB.id}`, contactDenied, {
      expectedVersion: 0,
      contacts: [{ id: contactId, name: 'Stolen', isPrimary: true }],
    });
    expect(contact.status, text(contact)).toBe(404);
    const contactAudit = await auditEvents(app, contactDenied, companyB);
    expect(contactAudit).toEqual([
      expect.objectContaining({
        action: 'authorization.denied',
        outcome: 'denied',
        objectType: 'client_contact',
        objectId: contactId.toLowerCase(),
        correlationId: contactDenied,
      }),
    ]);
    expect(detailReason(contactAudit[0]?.details)).toBe('contact_not_found');

    const addressDenied = cid('foreign-address');
    const address = await send(adminB, 'patch', `/api/c/${companyB}/clients/${clientB.id}`, addressDenied, {
      expectedVersion: 0,
      addresses: [
        {
          id: addressId,
          kind: 'billing',
          line1: '2 Road',
          city: 'Limassol',
          countryCode: 'CY',
          isDefault: true,
        },
      ],
    });
    expect(address.status, text(address)).toBe(404);
    const addressAudit = await auditEvents(app, addressDenied, companyB);
    expect(addressAudit).toEqual([
      expect.objectContaining({
        action: 'authorization.denied',
        outcome: 'denied',
        objectType: 'client_address',
        objectId: addressId.toLowerCase(),
        correlationId: addressDenied,
      }),
    ]);
    expect(detailReason(addressAudit[0]?.details)).toBe('address_not_found');

    const malformed = cid('bad-contact');
    const bad = await send(adminB, 'patch', `/api/c/${companyB}/clients/${clientB.id}`, malformed, {
      expectedVersion: 0,
      contacts: [{ id: 'not-a-uuid', name: 'Nope', isPrimary: true }],
    });
    expect(bad.status, text(bad)).toBe(400);
    expect(await auditEvents(app, malformed, companyB)).toEqual([]);
  });
});

function line(codes: Record<string, string>, spec: LineSpec) {
  const taxCodeId = codes[spec.tax];
  if (!taxCodeId) {
    throw new Error(`tax code ${spec.tax} is missing`);
  }
  return {
    position: spec.position ?? 1,
    description: spec.description ?? `Line ${String(spec.position ?? 1)}`,
    quantity: spec.quantity ?? '1',
    unit: 'ea',
    unitPrice: spec.unitPrice ?? '1.0000',
    discountPercent: spec.discountPercent ?? '0',
    taxCodeId,
  };
}

async function createClient(
  session: Session,
  companyId: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> {
  const response = await send(session, 'post', `/api/c/${companyId}/clients`, undefined, input);
  expect(response.status, text(response)).toBe(200);
  return { id: stringField(record(record(bodyOf(response)).client), 'id') };
}

async function taxCodeIds(session: Session, companyId: string): Promise<Record<string, string>> {
  const response = await send(session, 'get', `/api/c/${companyId}/tax-codes`);
  expect(response.status, text(response)).toBe(200);
  const ids: Record<string, string> = {};
  // Only the seeded examples: other suites create their own codes since R2-B.
  for (const item of arrayOf(record(bodyOf(response)).taxCodes)) {
    const row = record(item);
    if (row.isExample === true && typeof row.code === 'string' && typeof row.id === 'string') {
      ids[row.code] = row.id;
    }
  }
  return ids;
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

type Method = 'get' | 'post' | 'patch';

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

function fetchPdf(session: Session, url: string) {
  return session.agent
    .get(url)
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
  return `b3-${name}-${runId}`.slice(0, 64);
}

async function extractPdfText(pdf: Buffer): Promise<string> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
    getDocument: (src: { data: Uint8Array; isEvalSupported?: boolean }) => {
      promise: Promise<PdfDoc>;
    };
  };
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), isEvalSupported: false })
    .promise;
  const parts: string[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (typeof item.str === 'string') {
        parts.push(item.str);
      }
    }
  }
  return parts.join('');
}

type PdfDoc = {
  numPages: number;
  getPage: (
    page: number,
  ) => Promise<{ getTextContent: () => Promise<{ items: { str?: string }[] }> }>;
};

function flatten(value: string): string {
  return value.replace(/\s+/g, '');
}

function bodyOf(response: request.Response): unknown {
  return response.body as unknown;
}

function bufferOf(response: request.Response): Buffer {
  const body = response.body as unknown;
  if (Buffer.isBuffer(body)) {
    return body;
  }
  throw new Error('pdf body was not a buffer');
}

function text(response: request.Response): string {
  const body = response.body as unknown;
  if (Buffer.isBuffer(body)) {
    return body.subarray(0, 180).toString('utf8');
  }
  return JSON.stringify(body);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
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

function errorMessage(body: unknown): string | undefined {
  const message = record(record(body).error).message;
  return typeof message === 'string' ? message : undefined;
}

function detailReason(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    return undefined;
  }
  const reason = (details as Record<string, unknown>).reason;
  return typeof reason === 'string' ? reason : undefined;
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
