import { type INestApplication } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { addDaysToBusinessDate, businessDateInZone } from '@bp/domain';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { crc32, inflateRawSync } from 'node:zlib';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertDatabaseNameIsTest,
  assertEnvConnectionsTargetTestDatabase,
  assertTestDatabaseUrls,
} from '../../../tools/test-db-guard.mjs';
import { AppModule } from './app.module';
import { cancelQueuedJobs } from './test/cancel-queued-jobs';
import { APP_CONFIG, type AppConfig } from './config/env';
import { PrismaService } from './database/prisma.service';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { LOG_STREAM } from './logging/logging.module';

const runId = randomUUID().slice(0, 8);
const today = businessDateInZone(new Date(), 'Asia/Nicosia');
const from = addDaysToBusinessDate(today, -4);
const to = addDaysToBusinessDate(today, -3);
const later = addDaysToBusinessDate(today, -1);
const description = '=Δοκιμή, "είδος"\r\nδεύτερη  γραμμή';
const reason = 'Επιστροφή, "δοκιμή"\n  ευχαριστούμε';
const reference = '+Δοκιμαστική αναφορά, "μόνο"\r\n  κείμενο';
const buyerName = `Αγοραστής ${runId} (fictional)`;
const files = [
  'invoices.csv',
  'invoice_lines.csv',
  'tax_summary.csv',
  'payments.csv',
  'allocations.csv',
  'refunds.csv',
];
const headers: Record<string, string[]> = {
  'invoices.csv': [
    'id',
    'document_type',
    'number',
    'series_code',
    'issue_date',
    'supply_date',
    'due_date',
    'client_id',
    'buyer_name',
    'buyer_vat_number',
    'currency',
    'prices_include_tax',
    'net',
    'tax',
    'total',
    'credited_invoice_number',
    'credit_reason',
    'issued_at',
  ],
  'invoice_lines.csv': [
    'document_number',
    'position',
    'description',
    'quantity',
    'unit',
    'unit_price',
    'discount_percent',
    'tax_code',
    'tax_rate',
    'line_net',
    'line_amount_incl_vat',
  ],
  'tax_summary.csv': ['document_number', 'tax_code', 'tax_name', 'tax_rate', 'net', 'tax', 'gross'],
  'payments.csv': [
    'id',
    'client_id',
    'client_name',
    'received_on',
    'amount',
    'currency',
    'method',
    'reference',
    'status',
    'voided_on',
    'void_reason',
  ],
  'allocations.csv': [
    'id',
    'source_type',
    'payment_id',
    'credit_note_number',
    'invoice_number',
    'amount',
    'effective_on',
    'reversed_on',
    'reversal_reason',
  ],
  'refunds.csv': [
    'id',
    'source_type',
    'payment_id',
    'credit_note_number',
    'amount',
    'refunded_on',
    'method',
    'reference',
    'status',
    'voided_on',
  ],
};
type Session = { agent: ReturnType<typeof request.agent>; xsrf: string; cookie: string };
let app: INestApplication | undefined;
let storageRoot = '';
let mockRoot = '';

describe('accountant export (real Postgres and local stored PDFs)', () => {
  let company = '';
  let foreignCompany = '';
  let admin: Session;
  let viewer: Session;
  let clientId = '';
  let taxId = '';
  let invoiceId = '';
  let creditId = '';
  let invoiceNumber = '';
  let creditNumber = '';
  let paymentId = '';
  let allocationId = '';
  let refundId = '';

  beforeAll(async () => {
    const refusal = assertTestDatabaseUrls();
    if (refusal) throw new Error(refusal);
    await assertEnvConnectionsTargetTestDatabase();
    seedDatabase();
    storageRoot = mkdtempSync(join(tmpdir(), 'bp-r2g2-store-'));
    mockRoot = mkdtempSync(join(tmpdir(), 'bp-r2g2-print-'));
    process.env.STORAGE_ROOT = storageRoot;
    process.env.MOCK_PRINT_ROOT = mockRoot;
    process.env.APP_ENV = 'test';
    process.env.AUTH_DEV_LOGIN_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECURE = 'false';
    process.env.CSRF_SECRET = 'integration-test-csrf-secret';
    process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED = 'false';
    delete process.env.THROTTLE_ENABLED_IN_TEST;
    app = await bootApp();
    const prisma = app.get(PrismaService).client;
    const databases = await prisma.$queryRaw<{ current_database: string; current_user: string }[]>`
      SELECT current_database() AS current_database, current_user AS current_user
    `;
    assertDatabaseNameIsTest(databases[0]?.current_database, 'DATABASE_URL');
    expect(databases[0]?.current_user).toBe('bp_app');
    foreignCompany = (
      await prisma.company.findFirstOrThrow({
        where: { legalName: 'Demo Company B Ltd (fictional)' },
      })
    ).id;
    const owner = await login('owner@example.test');
    company = stringField(
      entity(
        await send(owner, 'post', '/api/platform/companies', {
          legalName: `Exports ${runId} Ltd (fictional)`,
          tradingName: `Exports ${runId}`,
          isFictional: true,
        }),
        'company',
      ),
      'id',
    );
    await createUserWithRole(`exports.${runId}@example.test`, 'CA');
    await createUserWithRole(`exports.viewer.${runId}@example.test`, 'FS');
    admin = await login(`exports.${runId}@example.test`);
    viewer = await login(`exports.viewer.${runId}@example.test`);
    taxId = (
      await inCompany(company, (tx) => tx.taxCode.findFirstOrThrow({ where: { code: 'STD19' } }))
    ).id;
    const series: string[] = [];
    for (const documentType of ['invoice', 'credit_note'] as const) {
      series.push(
        stringField(
          entity(
            await post('invoice-series', {
              code: `${documentType}-${runId}`,
              documentType,
              // A slash in a legal number must stay inside one ZIP path component.
              prefix: `${documentType === 'invoice' ? 'I' : 'C'}${runId}/`,
            }),
            'series',
          ),
          'id',
        ),
      );
    }
    const current = await inCompany(company, (tx) =>
      tx.company.findUniqueOrThrow({ where: { id: company } }),
    );
    entity(
      await send(admin, 'patch', url('company'), {
        expectedVersion: current.version,
        vatNumber: 'CY00000000X',
        address: {
          line1: '1 Fictional Street',
          city: 'Nicosia',
          postcode: '1010',
          countryCode: 'CY',
        },
        defaultInvoiceSeriesId: series[0],
        defaultCreditNoteSeriesId: series[1],
      }),
      'company',
    );
    const switched = await admin.agent
      .put(url('automation/switches/invoice.issue_real'))
      .set('X-XSRF-TOKEN', admin.xsrf)
      .send({ enabled: true, reason: 'Fictional export tests' });
    expect(switched.status, responseText(switched)).toBe(200);
    clientId = stringField(
      entity(
        await post('clients', {
          kind: 'organisation',
          displayName: buyerName,
          vatNumber: 'CY00000000X',
          addresses: [
            {
              kind: 'billing',
              line1: '2 Fictional Road',
              city: 'Nicosia',
              countryCode: 'CY',
              isDefault: true,
            },
          ],
        }),
        'client',
      ),
      'id',
    );
    const draftBody = {
      clientId,
      pricesIncludeTax: false,
      lines: [
        {
          position: 1,
          description,
          quantity: '2',
          unit: 'item',
          unitPrice: '100',
          taxCodeId: taxId,
        },
      ],
    };
    await onDate(from, async () => {
      const draft = entity(await post('invoices', draftBody), 'invoice');
      const invoice = entity(
        await post(`invoices/${stringField(draft, 'id')}/issue`, {
          expectedVersion: draft.version,
        }),
        'invoice',
      );
      invoiceId = stringField(invoice, 'id');
      invoiceNumber = stringField(invoice, 'number');
    });
    await onDate(to, async () => {
      const draft = entity(
        await post(`invoices/${invoiceId}/credit-notes`, {
          reason,
          lines: [
            {
              invoiceLineId: (
                await inCompany(company, (tx) =>
                  tx.invoiceLine.findFirstOrThrow({ where: { invoiceId } }),
                )
              ).id,
              quantity: '1',
            },
          ],
        }),
        'creditNote',
      );
      const credit = entity(
        await post(`credit-notes/${stringField(draft, 'id')}/issue`, {
          expectedVersion: draft.version,
        }),
        'creditNote',
      );
      creditId = stringField(credit, 'id');
      creditNumber = stringField(credit, 'number');
      paymentId = stringField(
        entity(
          await post('payments', {
            clientId,
            amount: '200',
            receivedOn: to,
            method: 'bank_transfer',
            reference,
          }),
          'payment',
        ),
        'id',
      );
      allocationId = stringField(
        entity(await post('allocations', { paymentId, invoiceId, amount: '50' }), 'allocation'),
        'id',
      );
      refundId = stringField(
        entity(
          await post('refunds', {
            paymentId,
            amount: '20',
            refundedOn: to,
            method: 'cash',
            reference: 'Δοκιμή επιστροφής',
          }),
          'refund',
        ),
        'id',
      );
    });
    for (const [documentType, status] of [
      ['invoice', 'draft'],
      ['quote', 'draft'],
      ['invoice', 'cancelled'],
    ] as const) {
      const draft = entity(await post('invoices', { ...draftBody, documentType }), 'invoice');
      if (status === 'cancelled')
        await inCompany(company, (tx) =>
          tx.invoice.update({
            where: { id: stringField(draft, 'id') },
            data: { status: 'cancelled' },
          }),
        );
    }
    // A live client/tax rename must not change frozen buyer or tax labels.
    await inCompany(company, async (tx) => {
      await tx.client.update({
        where: { id: clientId },
        data: { displayName: 'Renamed fictional buyer', vatNumber: 'CY11111111X' },
      });
      await tx.taxCode.update({
        where: { id: taxId },
        data: { code: 'RENAMED', name: 'Renamed fictional tax' },
      });
    });
  }, 120_000);

  afterAll(async () => {
    vi.useRealTimers();
    await cancelQueuedJobs(app, [company]);
    await app?.close();
    for (const root of [storageRoot, mockRoot])
      if (root) rmSync(root, { recursive: true, force: true });
    delete process.env.STORAGE_ROOT;
    delete process.env.MOCK_PRINT_ROOT;
  });

  it.each([false, true])(
    'exports the exact history, CSV safety and audit (PDFs %s)',
    async (pdfs) => {
      const correlationId = randomUUID();
      const before = readdirSync(storageRoot, { recursive: true });
      const response = await getExport(`from=${from}&to=${to}&pdfs=${String(pdfs)}`, correlationId);
      expect(response.status, responseText(response)).toBe(200);
      expect(response.headers['content-type']).toBe('application/zip');
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="accountant-export-${from}-${to}.zip"`,
      );
      const archive = unzip(response.body as Buffer);
      const pdfNames = [invoiceNumber, creditNumber].map(
        (number) => `pdfs/${encodeURIComponent(number)}.pdf`,
      );
      expect([...archive.keys()]).toEqual(['README.txt', ...files, ...(pdfs ? pdfNames : [])]);
      const readme = required(archive.get('README.txt')).toString('utf8');
      expect(readme).toContain(`Period: ${from} to ${to}`);
      expect(readme).toContain('VAT is calculated and rounded per tax-code group');
      expect(readme).toContain('Credit notes are positive amounts to subtract');
      for (const [name, columns] of Object.entries(headers)) {
        expect(readme).toContain(name);
        for (const column of columns) expect(readme).toContain(`${column}:`);
      }
      for (const name of files) {
        const bytes = required(archive.get(name));
        expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        expect(bytes.subarray(-2).toString()).toBe('\r\n');
        expect(parseCsv(bytes)[0]).toEqual(headers[name]);
        expect(bytes.toString()).not.toContain(storageRoot);
        expect(bytes.toString()).not.toContain('companies/');
        expect(bytes.toString()).not.toContain('storage_key');
      }
      const invoices = csvRows(archive, 'invoices.csv');
      expect(invoices).toHaveLength(2);
      expect(invoices[0]).toMatchObject({
        id: invoiceId,
        document_type: 'invoice',
        number: invoiceNumber,
        series_code: `invoice-${runId}`,
        issue_date: from,
        supply_date: from,
        client_id: clientId,
        buyer_name: buyerName,
        buyer_vat_number: 'CY00000000X',
        currency: 'EUR',
        prices_include_tax: 'false',
        net: '200.00',
        tax: '38.00',
        total: '238.00',
        credited_invoice_number: '',
        credit_reason: '',
        issued_at: `${from}T12:00:00.000Z`,
      });
      expect(invoices[1]).toMatchObject({
        id: creditId,
        document_type: 'credit_note',
        number: creditNumber,
        issue_date: to,
        net: '100.00',
        tax: '19.00',
        total: '119.00',
        credited_invoice_number: invoiceNumber,
        credit_reason: reason,
      });
      const lines = csvRows(archive, 'invoice_lines.csv');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toEqual({
        document_number: invoiceNumber,
        position: '1',
        description: `'${description}`,
        quantity: '2.0000',
        unit: 'item',
        unit_price: '100.0000',
        discount_percent: '0.00',
        tax_code: 'STD19',
        tax_rate: '19.0000',
        line_net: '200.00',
        line_amount_incl_vat: '',
      });
      expect(lines[1]).toMatchObject({
        document_number: creditNumber,
        description: `'${description}`,
        quantity: '1.0000',
        line_net: '100.00',
        line_amount_incl_vat: '',
      });
      expect(csvRows(archive, 'tax_summary.csv')).toEqual([
        {
          document_number: invoiceNumber,
          tax_code: 'STD19',
          tax_name: 'Standard 19% (example — verify with accountant)',
          tax_rate: '19.0000',
          net: '200.00',
          tax: '38.00',
          gross: '238.00',
        },
        {
          document_number: creditNumber,
          tax_code: 'STD19',
          tax_name: 'Standard 19% (example — verify with accountant)',
          tax_rate: '19.0000',
          net: '100.00',
          tax: '19.00',
          gross: '119.00',
        },
      ]);
      expect(csvRows(archive, 'payments.csv')).toEqual([
        {
          id: paymentId,
          client_id: clientId,
          client_name: 'Renamed fictional buyer',
          received_on: to,
          amount: '200.00',
          currency: 'EUR',
          method: 'bank_transfer',
          reference: `'${reference}`,
          status: 'recorded',
          voided_on: '',
          void_reason: '',
        },
      ]);
      expect(csvRows(archive, 'allocations.csv')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: allocationId,
            source_type: 'payment',
            payment_id: paymentId,
            credit_note_number: '',
            invoice_number: invoiceNumber,
            amount: '50.00',
            effective_on: to,
            reversed_on: '',
            reversal_reason: '',
          }),
          expect.objectContaining({
            source_type: 'credit_note',
            payment_id: '',
            credit_note_number: creditNumber,
            invoice_number: invoiceNumber,
            amount: '119.00',
            effective_on: to,
          }),
        ]),
      );
      expect(csvRows(archive, 'allocations.csv')).toHaveLength(2);
      expect(csvRows(archive, 'refunds.csv')).toEqual([
        {
          id: refundId,
          source_type: 'payment',
          payment_id: paymentId,
          credit_note_number: '',
          amount: '20.00',
          refunded_on: to,
          method: 'cash',
          reference: 'Δοκιμή επιστροφής',
          status: 'recorded',
          voided_on: '',
        },
      ]);
      if (pdfs) {
        const documents = await inCompany(company, (tx) =>
          tx.invoice.findMany({
            where: { id: { in: [invoiceId, creditId] } },
            include: { pdfFile: true },
          }),
        );
        for (const doc of documents)
          expect(archive.get(`pdfs/${encodeURIComponent(required(doc.number))}.pdf`)).toEqual(
            readFileSync(join(storageRoot, required(doc.pdfFile).storageKey)),
          );
      }
      expect(readdirSync(storageRoot, { recursive: true })).toEqual(before);
      const events = await auditEvents(correlationId);
      expect(events).toHaveLength(2);
      const actor = await started()
        .get(PrismaService)
        .client.userAccount.findUniqueOrThrow({
          where: { email: `exports.${runId}@example.test` },
        });
      const expected = {
        companyId: company,
        actorType: 'user',
        actorId: actor.id,
        objectType: 'accountant_export',
        outcome: 'success',
        correlationId,
        details: {
          from,
          to,
          totalSizeBytes: (response.body as Buffer).length,
          pdfsIncluded: pdfs,
          pdfSizeBytes: pdfs
            ? pdfNames.reduce((sum, name) => sum + required(archive.get(name)).length, 0)
            : 0,
          fileCounts: { csv: 6, pdfs: pdfs ? 2 : 0, total: pdfs ? 9 : 7 },
          rowCounts: {
            invoices: 2,
            invoiceLines: 2,
            taxSummary: 2,
            payments: 1,
            allocations: 2,
            refunds: 1,
          },
        },
      };
      expect(events).toContainEqual(
        expect.objectContaining({ ...expected, action: 'invoice.export_prepared' }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ ...expected, action: 'invoice.exported' }),
      );
      expect(events[0]?.details).toEqual(events[1]?.details);
    },
  );

  it('audits one interrupted transfer after the client destroys its socket on the first chunk', async () => {
    const day = addDaysToBusinessDate(from, -2);
    const payment = await inCompany(company, (tx) =>
      tx.payment.findUniqueOrThrow({ where: { id: paymentId } }),
    );
    // A large fictional reference keeps the real ZIP transfer in flight without
    // mocking the archive, HTTP stream, database or audit writer.
    await inCompany(company, (tx) =>
      tx.payment.create({
        data: {
          companyId: company,
          clientId,
          receivedOn: new Date(`${day}T00:00:00Z`),
          amount: '1.00',
          currency: 'EUR',
          method: 'cash',
          reference: randomBytes(8 * 1024 * 1024).toString('base64'),
          createdById: payment.createdById,
        },
      }),
    );
    await started().listen(0, '127.0.0.1');
    const baseUrl = await started().getUrl();
    const correlationId = randomUUID();
    let received = 0;
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      const call = httpGet(
        `${baseUrl}${url(`exports/accountant?from=${day}&to=${day}&pdfs=false`)}`,
        { headers: { Cookie: admin.cookie, 'X-Correlation-Id': correlationId } },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`Unexpected export status ${String(response.statusCode)}`));
            return;
          }
          total = Number(response.headers['content-length']);
          response.once('data', (chunk: Buffer) => {
            received += chunk.length;
            response.socket.destroy();
          });
          response.once('close', resolve);
          // Destroying the socket intentionally makes IncomingMessage abort.
          response.on('error', () => undefined);
        },
      );
      call.once('error', reject);
    });
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThan(total);
    const events = await transferEvents(correlationId);
    expect(events).toHaveLength(2);
    const prepared = events.find((event) => event.action === 'invoice.export_prepared');
    const exported = events.find((event) => event.action === 'invoice.exported');
    const details = {
      from: day,
      to: day,
      pdfsIncluded: false,
      pdfSizeBytes: 0,
      totalSizeBytes: total,
      fileCounts: { csv: 6, pdfs: 0, total: 7 },
      rowCounts: {
        invoices: 0,
        invoiceLines: 0,
        taxSummary: 0,
        payments: 1,
        allocations: 0,
        refunds: 0,
      },
    };
    expect(prepared).toMatchObject({ outcome: 'success', correlationId, details });
    expect(exported).toMatchObject({
      outcome: 'failure',
      correlationId,
      actorId: prepared?.actorId,
      actorType: 'user',
      details: { ...details, reason: 'transfer_interrupted' },
    });
    const bytesSent = record(exported?.details).bytesSent;
    expect(bytesSent).toBeGreaterThan(0);
    expect(bytesSent).toBeLessThan(total);
    expect(events.filter((event) => event.action === 'invoice.exported')).toHaveLength(1);
    expect(
      events.some((event) => event.action === 'invoice.exported' && event.outcome === 'success'),
    ).toBe(false);
  });

  it('uses inclusive independent business-date filters and always emits header-only files', async () => {
    const first = unzip((await getExport(`from=${from}&to=${from}`)).body as Buffer);
    expect(csvRows(first, 'invoices.csv').map((row) => row.id)).toEqual([invoiceId]);
    expect(csvRows(first, 'payments.csv')).toEqual([]);
    const last = unzip((await getExport(`from=${to}&to=${to}`)).body as Buffer);
    expect(csvRows(last, 'invoices.csv').map((row) => row.id)).toEqual([creditId]);
    expect(csvRows(last, 'allocations.csv')).toHaveLength(2);
    const empty = unzip((await getExport(`from=${today}&to=${today}&pdfs=true`)).body as Buffer);
    expect([...empty.keys()]).toEqual(['README.txt', ...files]);
    expect(required(empty.get('README.txt')).toString('utf8')).toContain(
      `Period: ${today} to ${today}`,
    );
    for (const name of files) expect(parseCsv(required(empty.get(name)))).toEqual([headers[name]]);
  });

  it('fills the VAT-inclusive line amount only on tax-inclusive documents', async () => {
    const day = addDaysToBusinessDate(from, -1);
    const number = await onDate(day, async () => {
      const draft = entity(
        await post('invoices', {
          clientId,
          pricesIncludeTax: true,
          lines: [
            {
              position: 1,
              description,
              quantity: '1',
              unit: 'item',
              unitPrice: '119',
              taxCodeId: taxId,
            },
          ],
        }),
        'invoice',
      );
      return stringField(
        entity(
          await post(`invoices/${stringField(draft, 'id')}/issue`, {
            expectedVersion: draft.version,
          }),
          'invoice',
        ),
        'number',
      );
    });
    const response = await getExport(`from=${day}&to=${day}`);
    expect(response.status, responseText(response)).toBe(200);
    const archive = unzip(response.body as Buffer);
    expect(csvRows(archive, 'invoices.csv')[0]).toMatchObject({ prices_include_tax: 'true' });
    expect(csvRows(archive, 'invoice_lines.csv')).toEqual([
      expect.objectContaining({
        document_number: number,
        line_net: '100.00',
        line_amount_incl_vat: '119.00',
      }),
    ]);
  });

  it.each([
    '',
    'from=2026-02-30&to=2026-03-01',
    'from=2026-1-01&to=2026-01-02',
    'from=2026-01-02&to=2026-01-01',
    'from=2024-01-01&to=2025-01-01',
    'from=2026-01-01&from=2026-01-02&to=2026-01-03',
  ])('audits and refuses invalid dates: %s', async (query) => {
    const correlationId = randomUUID();
    const response = await getExport(query, correlationId);
    expect(response.status).toBe(422);
    expect(record(record(response.body).error).code).toBe('invalid_date');
    expect(await auditEvents(correlationId)).toEqual([
      expect.objectContaining({
        action: 'invoice.exported',
        outcome: 'failure',
        details: expect.objectContaining({
          reason: 'invalid_date',
          fileCounts: { csv: 0, pdfs: 0, total: 0 },
        }) as unknown,
      }),
    ]);
  });

  it('accepts 366 inclusive days and refuses ambiguous PDF options', async () => {
    expect((await getExport('from=2024-01-01&to=2024-12-31')).status).toBe(200);
    for (const option of ['yes', 'true&pdfs=false']) {
      const correlationId = randomUUID();
      const response = await getExport(`from=${from}&to=${to}&pdfs=${option}`, correlationId);
      expect(response.status).toBe(400);
      expect(record(record(response.body).error).code).toBe('invalid_pdfs');
      expect(await auditEvents(correlationId)).toHaveLength(1);
    }
  });

  it('refuses missing permission and a foreign company, with denial audit', async () => {
    for (const [session, targetCompany, status] of [
      [viewer, company, 403],
      [admin, foreignCompany, 404],
    ] as const) {
      const correlationId = randomUUID();
      const response = await send(
        session,
        'get',
        url(`exports/accountant?from=${from}&to=${to}`, targetCompany),
        undefined,
        correlationId,
      );
      expect(response.status, responseText(response)).toBe(status);
      const events = await inCompany(targetCompany, (tx) =>
        tx.auditEvent.findMany({ where: { correlationId } }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          action: 'authorization.denied',
          outcome: 'denied',
          correlationId,
        }),
      );
      expect(events.some((event) => event.action === 'invoice.export_prepared')).toBe(false);
    }
  });

  it('requires MFA for invoice.export when the privileged policy is enabled', async () => {
    const config = started().get<AppConfig>(APP_CONFIG);
    const before = config.authRequireMfaForPrivileged;
    config.authRequireMfaForPrivileged = true;
    try {
      expect((await getExport(`from=${from}&to=${to}`)).status).toBe(403);
    } finally {
      config.authRequireMfaForPrivileged = before;
    }
  });

  it('includes reversals and voids in a later period without exporting unrelated documents or payments', async () => {
    await onDate(later, async () => {
      entity(
        await post(`allocations/${allocationId}/reverse`, { reason: '-Διόρθωση\n  λόγος' }),
        'allocation',
      );
      entity(
        await post(`refunds/${refundId}/void`, {
          expectedVersion: 0,
          reason: 'Ακύρωση επιστροφής',
        }),
        'refund',
      );
      entity(
        await post(`payments/${paymentId}/void`, {
          expectedVersion: 0,
          reason: '@Ακύρωση πληρωμής',
        }),
        'payment',
      );
      const automatic = await inCompany(company, (tx) =>
        tx.allocation.findFirstOrThrow({ where: { creditNoteId: creditId } }),
      );
      entity(
        await post(`allocations/${automatic.id}/reverse`, { reason: 'Αντιστροφή πίστωσης' }),
        'allocation',
      );
      entity(
        await post('refunds', {
          creditNoteId: creditId,
          amount: '10',
          refundedOn: later,
          method: 'cash',
        }),
        'refund',
      );
    });
    const original = unzip((await getExport(`from=${from}&to=${to}`)).body as Buffer);
    expect(csvRows(original, 'payments.csv')[0]).toMatchObject({
      status: 'voided',
      voided_on: later,
      void_reason: "'@Ακύρωση πληρωμής",
    });
    expect(csvRows(original, 'refunds.csv')[0]).toMatchObject({
      status: 'voided',
      voided_on: later,
    });
    const archive = unzip((await getExport(`from=${later}&to=${later}`)).body as Buffer);
    expect(csvRows(archive, 'invoices.csv')).toEqual([]);
    expect(csvRows(archive, 'payments.csv')).toEqual([]);
    expect(csvRows(archive, 'allocations.csv')).toHaveLength(2);
    expect(csvRows(archive, 'allocations.csv')).toContainEqual(
      expect.objectContaining({
        id: allocationId,
        effective_on: to,
        reversed_on: later,
        reversal_reason: "'-Διόρθωση\n  λόγος",
      }),
    );
    expect(csvRows(archive, 'refunds.csv')).toHaveLength(2);
    expect(csvRows(archive, 'refunds.csv')).toContainEqual(
      expect.objectContaining({ id: refundId, refunded_on: to, voided_on: later }),
    );
    expect(csvRows(archive, 'refunds.csv')).toContainEqual(
      expect.objectContaining({
        source_type: 'credit_note',
        payment_id: '',
        credit_note_number: creditNumber,
        amount: '10.00',
        refunded_on: later,
      }),
    );
  });

  it('refuses 1,001 PDFs before reading any stored file (simulated result count)', async () => {
    const prisma = started().get(PrismaService).client;
    const gated = prisma.$extends({
      query: {
        invoice: {
          async findMany({ args, query }) {
            const rows = await query(args);
            if (args.where?.companyId === company && args.where.status === 'issued')
              return Array.from({ length: 1001 }, () => required(rows[0]));
            return rows;
          },
        },
      },
    });
    const transact = gated.$transaction.bind(gated) as typeof prisma.$transaction;
    const spy = vi
      .spyOn(prisma, '$transaction')
      .mockImplementation((fn, options) => transact(fn, options));
    try {
      const correlationId = randomUUID();
      const response = await getExport(`from=${from}&to=${to}&pdfs=true`, correlationId);
      expect(response.status, responseText(response)).toBe(422);
      expect(record(record(response.body).error).code).toBe('export_too_large');
      expect(await auditEvents(correlationId)).toEqual([
        expect.objectContaining({
          action: 'invoice.exported',
          outcome: 'failure',
          details: expect.objectContaining({
            reason: 'export_too_large',
            rowCounts: expect.objectContaining({ invoices: 1001 }) as unknown,
            fileCounts: { csv: 0, pdfs: 0, total: 0 },
          }) as unknown,
        }),
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('reads a repeatable snapshot even when a payment commits between document and payment reads', async () => {
    const prisma = started().get(PrismaService).client;
    const payment = await inCompany(company, (tx) =>
      tx.payment.findUniqueOrThrow({ where: { id: paymentId } }),
    );
    const levels: unknown[] = [];
    let inserted = false;
    const gated = prisma.$extends({
      query: {
        invoice: {
          async findMany({ args, query }) {
            const rows = await query(args);
            if (!inserted && args.where?.companyId === company && args.where.status === 'issued') {
              inserted = true;
              await inCompany(company, (tx) =>
                tx.payment.create({
                  data: {
                    companyId: company,
                    clientId,
                    receivedOn: new Date(`${to}T00:00:00Z`),
                    amount: '5.00',
                    currency: 'EUR',
                    method: 'cash',
                    createdById: payment.createdById,
                  },
                }),
              );
            }
            return rows;
          },
        },
      },
    });
    const transact = gated.$transaction.bind(gated) as typeof prisma.$transaction;
    const spy = vi.spyOn(prisma, '$transaction').mockImplementation((fn, options) => {
      if (options?.isolationLevel) levels.push(options.isolationLevel);
      return transact(fn, options);
    });
    try {
      const response = await getExport(`from=${from}&to=${to}`);
      expect(response.status, responseText(response)).toBe(200);
      expect(csvRows(unzip(response.body as Buffer), 'payments.csv')).toHaveLength(1);
      expect(levels).toEqual(['RepeatableRead']);
    } finally {
      spy.mockRestore();
    }
    expect(inserted).toBe(true);
    expect(
      csvRows(unzip((await getExport(`from=${from}&to=${to}`)).body as Buffer), 'payments.csv'),
    ).toHaveLength(2);
  });

  it('aborts a tampered second PDF with 409, no archive bytes or files, and both failure audits', async () => {
    const credit = await inCompany(company, (tx) =>
      tx.invoice.findUniqueOrThrow({ where: { id: creditId }, include: { pdfFile: true } }),
    );
    const file = required(credit.pdfFile);
    const path = join(storageRoot, file.storageKey);
    const original = readFileSync(path);
    const tampered = Buffer.from(original);
    tampered[0] = required(tampered[0]) ^ 1;
    writeFileSync(path, tampered);
    try {
      const before = readdirSync(storageRoot, { recursive: true });
      const correlationId = randomUUID();
      const response = await getExport(`from=${from}&to=${to}&pdfs=true`, correlationId);
      expect(response.status, responseText(response)).toBe(409);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['content-disposition']).toBeUndefined();
      expect(record(record(response.body).error).code).toBe('file_integrity_failed');
      expect(responseText(response)).not.toContain('%PDF');
      expect(responseText(response)).not.toContain(file.storageKey);
      expect(responseText(response)).not.toContain(storageRoot);
      expect(readdirSync(storageRoot, { recursive: true })).toEqual(before);
      const events = await auditEvents(correlationId);
      expect(events).toHaveLength(2);
      expect(events).toContainEqual(
        expect.objectContaining({
          action: 'invoice.exported',
          outcome: 'failure',
          details: expect.objectContaining({
            from,
            to,
            pdfsIncluded: true,
            reason: 'file_integrity_failed',
            fileCounts: { csv: 0, pdfs: 0, total: 0 },
          }) as unknown,
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          action: 'file.integrity_failed',
          objectType: 'stored_file',
          objectId: file.id,
          outcome: 'failure',
          correlationId,
          details: { reason: 'file_integrity_failed', integrity: 'hash_mismatch' },
        }),
      );
      // CSV-only exports never read a PDF, including a damaged one.
      expect((await getExport(`from=${from}&to=${to}&pdfs=false`)).status).toBe(200);
    } finally {
      writeFileSync(path, original);
    }
  });

  function url(path: string, targetCompany = company) {
    return `/api/c/${targetCompany}/${path}`;
  }
  function post(path: string, body: unknown) {
    return send(admin, 'post', url(path), body).set('Idempotency-Key', randomUUID());
  }
  async function getExport(query: string, correlationId = randomUUID()) {
    const response = await send(
      admin,
      'get',
      url(`exports/accountant?${query}`),
      undefined,
      correlationId,
    )
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          callback(
            null,
            res.headers['content-type']?.includes('application/json')
              ? (JSON.parse(bytes.toString()) as object)
              : bytes,
          );
        });
        res.on('error', (error: Error) => {
          callback(error, null);
        });
      });
    if (response.status === 200) await transferEvents(correlationId);
    return response;
  }
  function auditEvents(correlationId: string) {
    return inCompany(company, (tx) => tx.auditEvent.findMany({ where: { correlationId } }));
  }
  async function transferEvents(correlationId: string) {
    await vi.waitFor(
      async () => {
        const events = await auditEvents(correlationId);
        expect(events.filter((event) => event.action === 'invoice.exported')).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    return auditEvents(correlationId);
  }
  async function createUserWithRole(email: string, roleKey: string) {
    const prisma = started().get(PrismaService).client;
    const user = await prisma.userAccount.create({
      data: {
        email,
        displayName: `Exports ${runId}`,
        identities: {
          create: {
            provider: 'dev',
            issuer: 'https://dev-login.invalid',
            subject: email,
            emailAtLink: email,
          },
        },
      },
    });
    const granter = await prisma.userAccount.findFirstOrThrow({
      where: { email: 'owner@example.test' },
    });
    await inCompany(company, async (tx) => {
      const role = await tx.role.findFirstOrThrow({ where: { companyId: company, key: roleKey } });
      const membership = await tx.membership.create({
        data: { companyId: company, userId: user.id, status: 'active' },
      });
      await tx.membershipRole.create({
        data: {
          membershipId: membership.id,
          roleId: role.id,
          scopeType: 'company',
          grantedById: granter.id,
        },
      });
    });
  }
});

function started(): INestApplication {
  if (!app) throw new Error('app is not started');
  return app;
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
  const result = spawnSync('pnpm', ['--filter', '@bp/db', 'seed'], {
    cwd: resolve(process.cwd(), '../..'),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`seed exited ${String(result.status ?? result.signal)}`);
}
async function login(email: string): Promise<Session> {
  const agent = request.agent(started().getHttpServer() as App);
  const response = await agent.post('/api/auth/dev/login').send({ email });
  expect(response.status, responseText(response)).toBe(200);
  const raw: unknown = response.headers['set-cookie'];
  const cookies = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.map(String) : [];
  const cookie = cookies.find((value) => value.startsWith('XSRF-TOKEN='));
  if (!cookie) throw new Error('XSRF cookie missing');
  return {
    agent,
    cookie: cookies.map((value) => value.split(';')[0]).join('; '),
    xsrf: decodeURIComponent(cookie.split(';')[0]?.slice('XSRF-TOKEN='.length) ?? ''),
  };
}
function send(
  session: Session,
  method: 'get' | 'post' | 'patch',
  url: string,
  body?: unknown,
  correlationId = randomUUID(),
) {
  const call = session.agent[method](url)
    .set('X-XSRF-TOKEN', session.xsrf)
    .set('X-Correlation-Id', correlationId);
  if (body !== undefined) call.send(body as object);
  return call;
}
function inCompany<T>(companyId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return new TenantDb(started().get(PrismaService).client).run(
    { companyId, actor: 'export-test', correlationId: randomUUID() },
    fn,
  );
}
async function onDate<T>(date: string, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${date}T12:00:00Z`));
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}
function entity(response: request.Response, field: string): Record<string, unknown> {
  expect(response.status, responseText(response)).toBe(200);
  return record(record(response.body)[field]);
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('expected an object');
  return value as Record<string, unknown>;
}
function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field) throw new Error(`${key} is missing`);
  return field;
}
function responseText(response: request.Response): string {
  return JSON.stringify(response.body);
}

/** Read the central directory independently, inflate files, and verify CRC and byte lengths. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  let cursor = zip.readUInt32LE(end + 16);
  const result = new Map<string, Buffer>();
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    expect(zip.readUInt16LE(cursor + 8)).toBe(0x0800);
    const size = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const local = zip.readUInt32LE(cursor + 42);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const bytes = inflateRawSync(zip.subarray(start, start + size));
    expect(bytes.length).toBe(zip.readUInt32LE(cursor + 24));
    expect(crc32(bytes)).toBe(zip.readUInt32LE(cursor + 16));
    result.set(name, bytes);
    cursor += 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }
  expect(cursor).toBe(end);
  return result;
}

/** RFC 4180 parser preserves quoted newlines and customer whitespace for exact comparisons. */
function parseCsv(bytes: Buffer): string[][] {
  const text = bytes.toString('utf8');
  expect(text[0]).toBe('\uFEFF');
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let i = 1; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && char === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += required(char);
  }
  expect(quoted).toBe(false);
  expect(row).toEqual([]);
  expect(cell).toBe('');
  return rows;
}
function csvRows(archive: Map<string, Buffer>, name: string): Record<string, string>[] {
  const [head, ...rows] = parseCsv(required(archive.get(name)));
  const columns = required(head);
  return rows.map((row) => {
    expect(row.length).toBe(columns.length);
    return Object.fromEntries(columns.map((key, i) => [key, required(row[i])]));
  });
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Required test value is missing');
  return value;
}
