import { type INestApplication } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
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
import {
  CLIENT_CSV_COLUMNS,
  parseCsv,
  undoFormulaPrefix,
  type ClientCsvColumn,
} from './clients/client-csv';
import type { ClientImportView } from './clients/client-csv.service';
import { APP_CONFIG, type AppConfig } from './config/env';
import { PrismaService } from './database/prisma.service';
import { textCell, writeCsv } from './export/csv';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { LOG_STREAM } from './logging/logging.module';

type Session = { agent: ReturnType<typeof request.agent>; xsrf: string; cookie: string };
const runId = randomUUID().slice(0, 8);
let app: INestApplication;
let storageRoot = '';
let mockRoot = '';
let company = '';
let foreignCompany = '';
let admin: Session;
let manager: Session;
let exporter: Session;
const notes = '=Ελληνικά, "λέξεις"\r\n  δεύτερη  γραμμή  ';

describe('client CSV imports and exports (real Postgres)', () => {
  beforeAll(async () => {
    const refusal = assertTestDatabaseUrls();
    if (refusal) throw new Error(refusal);
    await assertEnvConnectionsTargetTestDatabase();
    const seed = spawnSync('pnpm', ['--filter', '@bp/db', 'seed'], {
      cwd: resolve(process.cwd(), '../..'),
      env: process.env,
      stdio: 'inherit',
    });
    if (seed.status !== 0) throw new Error(`Seed failed: ${String(seed.status)}`);
    storageRoot = mkdtempSync(join(tmpdir(), 'bp-r2h-store-'));
    mockRoot = mkdtempSync(join(tmpdir(), 'bp-r2h-print-'));
    Object.assign(process.env, {
      STORAGE_ROOT: storageRoot,
      MOCK_PRINT_ROOT: mockRoot,
      APP_ENV: 'test',
      AUTH_DEV_LOGIN_ENABLED: 'true',
      SESSION_COOKIE_SECURE: 'false',
      CSRF_SECRET: 'integration-test-csrf-secret',
      AUTH_REQUIRE_MFA_FOR_PRIVILEGED: 'false',
    });
    delete process.env.THROTTLE_ENABLED_IN_TEST;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOG_STREAM)
      .useValue(
        new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
      )
      .compile();
    app = moduleRef.createNestApplication(caseSensitiveAdapter(), {
      bodyParser: false,
      abortOnError: false,
    });
    app.useLogger(app.get(Logger));
    configureHttp(app);
    await app.init();
    const db = app.get(PrismaService).client;
    const info = await db.$queryRaw<
      { current_database: string; current_user: string }[]
    >`SELECT current_database(), current_user`;
    assertDatabaseNameIsTest(info[0]?.current_database, 'DATABASE_URL');
    expect(info[0]?.current_user).toBe('bp_app');
    foreignCompany = (
      await db.company.findFirstOrThrow({ where: { legalName: 'Demo Company B Ltd (fictional)' } })
    ).id;
    const owner = await login('owner@example.test');
    const response = await send(owner, 'post', '/api/platform/companies', {
      legalName: `Client CSV ${runId} (fictional)`,
      tradingName: `CSV ${runId} (fictional)`,
      isFictional: true,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    company = (response.body as { company: { id: string } }).company.id;
    await grant(`csv.admin.${runId}@example.test`, 'CA');
    await grant(`csv.manager.${runId}@example.test`, 'manager', ['client.manage']);
    await grant(`csv.exporter.${runId}@example.test`, 'exporter', [
      'client.view',
      'invoice.export',
    ]);
    admin = await login(`csv.admin.${runId}@example.test`);
    manager = await login(`csv.manager.${runId}@example.test`);
    exporter = await login(`csv.exporter.${runId}@example.test`);
    const created = await post('', {
      kind: 'individual',
      displayName: `=Πελάτης ${runId} (fictional)`,
      email: `original.${runId}@example.test`,
      notes,
      paymentTermsDays: 0,
      acceptsEInvoices: true,
      addresses: [
        {
          kind: 'billing',
          line1: '+1 Fictional St',
          line2: '  Floor  2 ',
          city: 'Λευκωσία',
          region: '  Δοκιμή ',
          postalCode: '1000',
          countryCode: 'CY',
          isDefault: true,
        },
      ],
    });
    expect(created.status).toBe(200);
    const id = (created.body as { client: { id: string } }).client.id;
    expect(
      (await send(admin, 'patch', url(id), { expectedVersion: 0, archived: true })).status,
    ).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await cancelQueuedJobs(app, [company]);
    await app.close();
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
    if (mockRoot) rmSync(mockRoot, { recursive: true, force: true });
  });

  it('exports archived clients with BOM, safe formulas, Greek, the default billing address and a row-count audit; re-import gives only duplicates', async () => {
    const correlationId = randomUUID();
    const exported = await send(admin, 'get', url('export.csv'), undefined, correlationId);
    expect(exported.status).toBe(200);
    expect(exported.headers['content-disposition']).toMatch(
      /^attachment; filename="clients-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(exported.headers['content-type']).toContain('text/csv');
    const content = exported.text;
    expect(content.startsWith('\uFEFF')).toBe(true);
    const rows = parseCsv(content);
    expect(rows[0]).toEqual([...CLIENT_CSV_COLUMNS, 'archived']);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.[0]).toBe('person');
    expect(rows[1]?.[8]).toBe(`'${notes}`);
    expect(rows[1]?.[11]).toBe('0');
    expect(rows[1]?.[13]).toBe("'+1 Fictional St");
    expect(rows[1]?.at(-1)).toBe('true');
    const audits = await transferEvents(correlationId);
    expect(audits).toHaveLength(2);
    for (const action of ['client.export_prepared', 'client.exported'])
      expect(audits).toContainEqual(
        expect.objectContaining({
          action,
          correlationId,
          outcome: 'success',
          details: { rowCount: 1, totalSizeBytes: Buffer.byteLength(content) },
        }),
      );
    const preview = view(await post('imports', { fileName: 'export-fictional.csv', content }));
    expect(preview.counts).toEqual({ new: 0, duplicate: 1, error: 0 });
    expect(preview.rows[0]?.values.notes).toBe(notes);
    expect(preview.rows[0]?.values.payment_terms_days).toBe('0');
  });

  it('reads one repeatable-read snapshot for the export', async () => {
    const spy = vi.spyOn(TenantDb.prototype, 'run');
    try {
      expect((await send(admin, 'get', url('export.csv'))).status).toBe(200);
      expect(spy.mock.calls.some((call) => call[2]?.isolation === 'repeatable_read')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('audits exactly one interrupted download with flushed bytes and the original correlation id', async () => {
    await withLargeExportClients(600, async () => {
      await app.listen(0, '127.0.0.1');
      const baseUrl = await app.getUrl();
      const correlationId = randomUUID();
      let received = 0;
      let total = 0;
      await new Promise<void>((resolve, reject) => {
        const call = httpGet(
          `${baseUrl}${url('export.csv')}`,
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
            response.on('error', () => undefined);
          },
        );
        call.once('error', reject);
      });
      expect(received).toBeGreaterThan(0);
      expect(received).toBeLessThan(total);
      const audits = await transferEvents(correlationId);
      expect(audits).toHaveLength(2);
      const prepared = audits.find((event) => event.action === 'client.export_prepared');
      const exported = audits.find((event) => event.action === 'client.exported');
      expect(prepared).toMatchObject({
        correlationId,
        outcome: 'success',
        details: { rowCount: 601, totalSizeBytes: total },
      });
      expect(exported).toMatchObject({
        actorId: prepared?.actorId,
        actorType: 'user',
        correlationId,
        outcome: 'failure',
        details: { rowCount: 601, totalSizeBytes: total, reason: 'transfer_interrupted' },
      });
      const bytesSent = (exported?.details as { bytesSent: number }).bytesSent;
      expect(bytesSent).toBeGreaterThan(0);
      expect(bytesSent).toBeLessThan(total);
    });
  });

  it('previews mixed rows with named matches and field codes, reloads them and confirms only the new rows once', async () => {
    const content = csv([
      {
        display_name: `New mixed ${runId} (fictional)`,
        email: `mixed.${runId}@example.test`,
        notes,
        billing_line1: '  2 Fictional St ',
        billing_city: 'Λευκωσία',
        billing_country_code: 'CY',
        accepts_e_invoices: 'true',
      },
      { display_name: 'Other (fictional)', email: `original.${runId}@example.test` },
      { display_name: 'Error (fictional)', email: 'invalid' },
      { display_name: `  NEW MIXED ${runId} (fictional) ` },
    ]);
    const correlationId = randomUUID();
    const preview = view(
      await send(
        admin,
        'post',
        url('imports'),
        { fileName: 'mixed-fictional.csv', content },
        correlationId,
      ),
    );
    expect(preview.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(preview.counts).toEqual({ new: 1, duplicate: 2, error: 1 });
    expect(preview.rows.map((row) => row.number)).toEqual([2, 3, 4, 5]);
    expect(preview.rows[1]?.messages).toContainEqual(
      expect.objectContaining({
        field: 'email',
        code: 'duplicate',
        message: expect.stringContaining('client ') as unknown,
      }),
    );
    expect(preview.rows[2]?.messages).toContainEqual(
      expect.objectContaining({ field: 'email', code: 'invalid_email' }),
    );
    expect(preview.rows[3]?.messages[0]?.message).toContain('row 2');
    expect(view(await send(admin, 'get', url(`imports/${preview.id}`)))).toEqual(preview);
    expect(await events(correlationId)).toContainEqual(
      expect.objectContaining({
        action: 'client.import_previewed',
        outcome: 'success',
        objectId: preview.id,
      }),
    );
    const confirmCorrelation = randomUUID();
    const applied = await send(
      admin,
      'post',
      url(`imports/${preview.id}/confirm`),
      { expectedSha256: preview.sha256 },
      confirmCorrelation,
    );
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toEqual({ appliedCount: 1, counts: { new: 1, duplicate: 2, error: 1 } });
    const clients = await inCompany((tx) =>
      tx.client.findMany({
        where: { displayName: `New mixed ${runId} (fictional)` },
        include: { addresses: true },
      }),
    );
    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({
      notes,
      nameNormalized: `new mixed ${runId} (fictional)`,
      acceptsEInvoices: true,
      addresses: [
        expect.objectContaining({ line1: '  2 Fictional St ', city: 'Λευκωσία', isDefault: true }),
      ],
    });
    const stored = view(await send(admin, 'get', url(`imports/${preview.id}`)));
    expect(stored).toMatchObject({
      status: 'applied',
      appliedCount: 1,
      appliedAt: expect.any(String) as unknown,
    });
    expect(await events(confirmCorrelation)).toEqual([
      expect.objectContaining({
        action: 'client.imported',
        outcome: 'success',
        objectId: preview.id,
        details: expect.objectContaining({ appliedCount: 1, acceptsEInvoicesCount: 1 }) as unknown,
      }),
    ]);
    await refused(
      post(`imports/${preview.id}/confirm`, { expectedSha256: preview.sha256 }),
      409,
      'already_applied',
    );
    expect(
      await inCompany((tx) =>
        tx.client.count({ where: { displayName: `New mixed ${runId} (fictional)` } }),
      ),
    ).toBe(1);
  });

  it('skips a client created since preview, and persists the new duplicate classification', async () => {
    const displayName = `Late ${runId} (fictional)`;
    const preview = view(
      await post('imports', {
        fileName: 'late-fictional.csv',
        content: csv([{ display_name: displayName }]),
      }),
    );
    const created = await post('', { kind: 'organisation', displayName });
    expect(created.status).toBe(200);
    const id = (created.body as { client: { id: string } }).client.id;
    const result = await post(`imports/${preview.id}/confirm`, { expectedSha256: preview.sha256 });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ appliedCount: 0, counts: { new: 0, duplicate: 1, error: 0 } });
    expect(view(await send(admin, 'get', url(`imports/${preview.id}`))).rows[0]).toMatchObject({
      status: 'duplicate',
      messages: [expect.objectContaining({ message: `Matches client ${id}` })],
    });
  });

  it('serialises simultaneous confirms of the same preview', async () => {
    const preview = await newPreview('Concurrent same');
    const results = await Promise.all([
      post(`imports/${preview.id}/confirm`, { expectedSha256: preview.sha256 }),
      post(`imports/${preview.id}/confirm`, { expectedSha256: preview.sha256 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body).toMatchObject({
      error: { code: 'already_applied' },
    });
    expect(
      await inCompany((tx) =>
        tx.client.count({ where: { displayName: `Concurrent same ${runId} (fictional)` } }),
      ),
    ).toBe(1);
  });

  it('serialises two different previews with the same new client', async () => {
    const one = await newPreview('Concurrent different');
    const two = await newPreview('Concurrent different');
    const results = await Promise.all([
      post(`imports/${one.id}/confirm`, { expectedSha256: one.sha256 }),
      post(`imports/${two.id}/confirm`, { expectedSha256: two.sha256 }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => (r.body as { appliedCount: number }).appliedCount).sort()).toEqual([
      0, 1,
    ]);
  });

  it('commits expiry and audits the refusal without creating clients', async () => {
    const preview = await newPreview('Expired');
    await inCompany((tx) =>
      tx.clientImport.update({
        where: { id: preview.id },
        data: { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000 - 1) },
      }),
    );
    await refused(
      post(`imports/${preview.id}/confirm`, { expectedSha256: preview.sha256 }),
      409,
      'preview_expired',
    );
    expect(view(await send(admin, 'get', url(`imports/${preview.id}`))).status).toBe('expired');
    expect(
      await inCompany((tx) =>
        tx.client.count({ where: { displayName: `Expired ${runId} (fictional)` } }),
      ),
    ).toBe(0);
  });

  it('refuses a changed hash, preserves the preview and audits it', async () => {
    const preview = await newPreview('Changed hash');
    await refused(
      post(`imports/${preview.id}/confirm`, { expectedSha256: '0'.repeat(64) }),
      409,
      'preview_changed',
    );
    expect(view(await send(admin, 'get', url(`imports/${preview.id}`))).status).toBe('previewed');
  });

  it('refuses 5,001 data rows before storing a preview', async () => {
    const before = await inCompany((tx) => tx.clientImport.count());
    await refused(
      post('imports', {
        fileName: 'too-many-fictional.csv',
        content: 'kind,display_name\n' + 'person,Client (fictional)\n'.repeat(5001),
      }),
      422,
      'too_many_rows',
    );
    expect(await inCompany((tx) => tx.clientImport.count())).toBe(before);
  });

  it('accepts and applies exactly 5,000 new rows in one transaction', async () => {
    const preview = view(
      await post('imports', {
        fileName: 'maximum-fictional.csv',
        content: csv(
          Array.from({ length: 5000 }, (_, i) => ({
            display_name: `Maximum ${runId} ${String(i)} (fictional)`,
          })),
        ),
      }),
    );
    expect(preview.counts).toEqual({ new: 5000, duplicate: 0, error: 0 });
    const result = await post(`imports/${preview.id}/confirm`, { expectedSha256: preview.sha256 });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toEqual({
      appliedCount: 5000,
      counts: { new: 5000, duplicate: 0, error: 0 },
    });
  }, 120_000);

  it('exports every id-ordered batch with exactly one BOM and no missing or repeated clients', async () => {
    const expected = await inCompany((tx) =>
      tx.client.findMany({ orderBy: { id: 'asc' }, select: { displayName: true } }),
    );
    expect(expected.length).toBeGreaterThan(5000);
    const exported = await send(admin, 'get', url('export.csv'));
    expect(exported.status).toBe(200);
    expect(exported.text.split('\uFEFF')).toHaveLength(2);
    const rows = parseCsv(exported.text, 20_000);
    expect(rows.slice(1).map((row) => undoFormulaPrefix(row[1] ?? ''))).toEqual(
      expected.map((client) => client.displayName),
    );
  });

  it.each([
    [
      'kind,display_name,unknown_a,unknown_b\nperson,Client (fictional),,',
      'unknown_columns',
      'unknown_a, unknown_b',
    ],
    ['kind,display_name\nperson,"broken', 'invalid_csv', 'Unclosed'],
  ])('audits refused CSV layouts and names the unknown columns', async (content, code, message) => {
    const response = await refused(
      post('imports', { fileName: 'invalid-fictional.csv', content }),
      422,
      code,
    );
    expect(response.body).toMatchObject({
      error: { message: expect.stringContaining(message) as unknown },
    });
  });

  it('stores Unicode row errors as JSONB and reloads them without rejecting the preview', async () => {
    const prefix = 'x'.repeat(499);
    const preview = view(
      await post('imports', {
        fileName: 'unicode-fictional.csv',
        content: `kind,display_name,notes\nperson,${prefix}😀,\nperson,Lone high (fictional),before\uD800after\nperson,Lone low (fictional),before\uDC00after\nperson,Valid emoji (fictional),😀`,
      }),
    );
    expect(preview.counts).toEqual({ new: 1, duplicate: 0, error: 3 });
    expect(preview.rows[0]).toMatchObject({
      values: { display_name: prefix },
      messages: [expect.objectContaining({ field: 'display_name', code: 'too_long' })],
    });
    for (const row of preview.rows.slice(1, 3)) {
      expect(row).toMatchObject({
        values: { notes: 'before\uFFFDafter' },
        messages: [expect.objectContaining({ field: 'notes', code: 'invalid_unicode' })],
      });
    }
    expect(preview.rows[3]?.values.notes).toBe('😀');
    expect(view(await send(admin, 'get', url(`imports/${preview.id}`)))).toEqual(preview);
  });

  it('accepts JSON above 1 MB for preview with optional slash and query, and refuses above 4 MB', async () => {
    const row = 'person,Client (fictional),"' + 'α'.repeat(10_000) + '"\n';
    const content = 'kind,display_name,notes\n' + row.repeat(60);
    expect(Buffer.byteLength(content)).toBeGreaterThan(1024 * 1024);
    for (const suffix of [
      'imports',
      'imports/',
      'imports?source=fictional',
      'imports/?source=fictional',
    ]) {
      expect((await post(suffix, { fileName: 'large-fictional.csv', content })).status).toBe(200);
      expect(
        (
          await post(suffix, {
            fileName: 'too-large-fictional.csv',
            content: 'x'.repeat(4 * 1024 * 1024),
          })
        ).status,
      ).toBe(413);
    }
    expect(
      (
        await post('', {
          kind: 'organisation',
          displayName: 'Large (fictional)',
          notes: 'x'.repeat(1024 * 1024),
        })
      ).status,
    ).toBe(413);
    const preview = await newPreview('Small');
    expect(
      (
        await post(`imports/${preview.id}/confirm`, {
          expectedSha256: preview.sha256,
          extra: 'x'.repeat(1024 * 1024),
        })
      ).status,
    ).toBe(413);
  });

  it.each([
    ['get', '/api/c/COMPANY/clients/imports'],
    ['post', '/API/c/COMPANY/clients/imports'],
    ['post', '/api/C/COMPANY/clients/imports'],
    ['post', '/api/c/COMPANY/Clients/imports'],
    ['post', '/api/c/COMPANY/clients/Imports'],
    ['post', '/api/c/COMPANY/clients/IMPORTS/?source=fictional'],
    ['post', '/%61pi/c/COMPANY/clients/imports'],
    ['post', '/api/c/COMPANY/clients/%69mports'],
    ['post', '/api/c/COMPANY/clients/imports%2F'],
    ['post', '/api/c/COMPANY/clients/imports//'],
    ['post', '/api/c/COMPANY/clients/imports/extra'],
    ['post', '/api/c/COMPANY/extra/clients/imports'],
    ['post', '/api/c//clients/imports'],
  ] as const)('keeps the 1 MiB limit for %s %s', async (method, path) => {
    const response = await send(admin, method, path.replace('COMPANY', company), {
      fileName: 'standard-limit-fictional.csv',
      content: 'x'.repeat(1024 * 1024),
    });
    expect(response.status).toBe(413);
  });

  it('refuses client.manage without client.import and invoice.export without client.export, with denial audits', async () => {
    await refused(
      send(manager, 'post', url('imports'), {
        fileName: 'forbidden-fictional.csv',
        content: csv([]),
      }),
      403,
    );
    await refused(send(exporter, 'get', url('export.csv')), 403);
    const preview = await newPreview('Permission');
    await refused(send(manager, 'get', url(`imports/${preview.id}`)), 403);
    await refused(
      send(manager, 'post', url(`imports/${preview.id}/confirm`), {
        expectedSha256: preview.sha256,
      }),
      403,
    );
  });

  it('requires privileged MFA for client import and export', async () => {
    const preview = await newPreview('MFA');
    const config = app.get<AppConfig>(APP_CONFIG);
    const before = config.authRequireMfaForPrivileged;
    config.authRequireMfaForPrivileged = true;
    try {
      await refused(post('imports', { fileName: 'mfa-fictional.csv', content: csv([]) }), 403);
      await refused(post(`imports/${preview.id}/confirm`, { expectedSha256: preview.sha256 }), 403);
      await refused(send(admin, 'get', url('export.csv')), 403);
    } finally {
      config.authRequireMfaForPrivileged = before;
    }
  });

  it('refuses another company URL for export and preview with 404 and denial audits', async () => {
    await refused(
      send(admin, 'get', `/api/c/${foreignCompany}/clients/export.csv`),
      404,
      undefined,
      foreignCompany,
    );
    await refused(
      send(admin, 'post', `/api/c/${foreignCompany}/clients/imports`, {
        fileName: 'foreign-fictional.csv',
        content: csv([]),
      }),
      404,
      undefined,
      foreignCompany,
    );
  });

  it('refuses more than 20,000 clients before building an export', async () => {
    const actor = (
      await app.get(PrismaService).client.userAccount.findFirstOrThrow({
        where: { email: `csv.admin.${runId}@example.test` },
      })
    ).id;
    const count = await inCompany((tx) => tx.client.count());
    await inCompany((tx) =>
      tx.client.createMany({
        data: Array.from({ length: 20_001 - count }, (_, i) => ({
          companyId: company,
          kind: 'organisation' as const,
          displayName: `Export limit ${runId} ${String(i)} (fictional)`,
          createdById: actor,
        })),
      }),
    );
    try {
      await refused(send(admin, 'get', url('export.csv')), 422, 'export_too_large');
    } finally {
      await inCompany((tx) =>
        tx.client.deleteMany({ where: { displayName: { startsWith: `Export limit ${runId} ` } } }),
      );
    }
  });

  it('refuses output above 64 MiB before sending CSV headers or recording a prepared export', async () => {
    await withLargeExportClients(3500, async () => {
      const correlationId = randomUUID();
      const response = await refused(
        send(admin, 'get', url('export.csv'), undefined, correlationId),
        422,
        'export_too_large',
      );
      expect(response.headers['content-disposition']).toBeUndefined();
      expect(response.headers['content-type']).toContain('application/json');
      expect(await events(correlationId)).toEqual([
        expect.objectContaining({
          action: 'client.exported',
          outcome: 'failure',
          details: { reason: 'export_too_large' },
        }),
      ]);
    });
  });
});

function url(suffix: string) {
  return `/api/c/${company}/clients${suffix ? `/${suffix}` : ''}`;
}
function post(suffix: string, body: unknown) {
  return send(admin, 'post', url(suffix), body);
}
function send(
  session: Session,
  method: 'get' | 'post' | 'patch',
  path: string,
  body?: unknown,
  correlationId = randomUUID(),
) {
  const call = session.agent[method](path)
    .set('X-XSRF-TOKEN', session.xsrf)
    .set('X-Correlation-Id', correlationId);
  if (body !== undefined) call.send(body as object);
  return call;
}
function csv(rows: Partial<Record<ClientCsvColumn, string>>[]) {
  return writeCsv([
    CLIENT_CSV_COLUMNS.map(textCell),
    ...rows.map((row) =>
      CLIENT_CSV_COLUMNS.map((field) => textCell(row[field] ?? (field === 'kind' ? 'person' : ''))),
    ),
  ]).toString('utf8');
}
function view(response: request.Response): ClientImportView {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body as { import: ClientImportView }).import;
}
async function newPreview(label: string) {
  return view(
    await post('imports', {
      fileName: 'clients-fictional.csv',
      content: csv([{ display_name: `${label} ${runId} (fictional)` }]),
    }),
  );
}
function inCompany<T>(fn: (tx: TenantTransaction) => Promise<T>, companyId = company): Promise<T> {
  return new TenantDb(app.get(PrismaService).client).run(
    { companyId, actor: 'client-csv-test', correlationId: randomUUID() },
    fn,
  );
}
function events(correlationId: string, companyId = company) {
  return inCompany((tx) => tx.auditEvent.findMany({ where: { correlationId } }), companyId);
}
async function transferEvents(correlationId: string) {
  await vi.waitFor(
    async () => {
      expect(
        (await events(correlationId)).filter((event) => event.action === 'client.exported'),
      ).toHaveLength(1);
    },
    { timeout: 5000 },
  );
  return events(correlationId);
}
async function withLargeExportClients(count: number, fn: () => Promise<void>) {
  const actor = await app.get(PrismaService).client.userAccount.findFirstOrThrow({
    where: { email: `csv.admin.${runId}@example.test` },
  });
  const prefix = `Export bytes ${runId} (fictional) `;
  await inCompany(
    (tx) => tx.$executeRaw`
    INSERT INTO client (id, company_id, kind, display_name, notes, created_by, updated_at)
    SELECT gen_random_uuid(), ${company}::uuid, 'organisation'::client_kind,
      ${prefix} || i, repeat('x', 20000), ${actor.id}::uuid, CURRENT_TIMESTAMP
    FROM generate_series(1, ${count}::integer) AS i
  `,
  );
  try {
    await fn();
  } finally {
    await inCompany((tx) =>
      tx.client.deleteMany({ where: { displayName: { startsWith: prefix } } }),
    );
  }
}
async function refused(
  call: PromiseLike<request.Response>,
  status: number,
  code?: string,
  companyId = company,
) {
  const response = await call;
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  if (code) expect(response.body).toMatchObject({ error: { code } });
  const correlationId = String(response.headers['x-correlation-id']);
  expect(await events(correlationId, companyId)).toContainEqual(
    expect.objectContaining({
      correlationId,
      outcome: [403, 404].includes(status) ? 'denied' : 'failure',
    }),
  );
  return response;
}
async function login(email: string): Promise<Session> {
  const agent = request.agent(app.getHttpServer() as App);
  const response = await agent.post('/api/auth/dev/login').send({ email });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const raw: unknown = response.headers['set-cookie'];
  const cookies = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.map(String) : [];
  const cookie = cookies.find((v) => v.startsWith('XSRF-TOKEN='));
  if (!cookie) throw new Error('Missing XSRF token');
  return {
    agent,
    xsrf: decodeURIComponent(cookie.split(';')[0]?.slice('XSRF-TOKEN='.length) ?? ''),
    cookie: cookies.map((value) => value.split(';')[0]).join('; '),
  };
}
async function grant(email: string, roleKey: string, permissions?: string[]) {
  const db = app.get(PrismaService).client;
  const user = await db.userAccount.create({
    data: {
      email,
      displayName: `CSV ${runId} (fictional)`,
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
  const granter = await db.userAccount.findFirstOrThrow({ where: { email: 'owner@example.test' } });
  await inCompany(async (tx) => {
    const role = permissions
      ? await tx.role.create({
          data: {
            companyId: company,
            key: roleKey,
            name: `${roleKey} (fictional)`,
            permissions: { create: permissions.map((permission) => ({ permission })) },
          },
        })
      : await tx.role.findFirstOrThrow({ where: { companyId: company, key: roleKey } });
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
