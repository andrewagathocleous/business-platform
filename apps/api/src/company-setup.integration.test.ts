import { type INestApplication } from '@nestjs/common';
import { TenantDb } from '@bp/db';
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
import { PrismaService } from './database/prisma.service';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { LOG_STREAM } from './logging/logging.module';

const COMPANY_A = 'Demo Company A Ltd (fictional)';
const COMPANY_B = 'Demo Company B Ltd (fictional)';
const runId = randomUUID().slice(0, 8);

type Agent = ReturnType<typeof request.agent>;
type Session = { agent: Agent; xsrf: string };

describe('company setup', () => {
  let companyA = '';
  let companyB = '';
  let adminA: Session;
  let adminB: Session;
  let fulfil: Session;
  let shopifyStoreId = '';
  let prestaStoreId = '';
  let adminUserId = '';

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
    adminUserId = (
      await prisma.client.userAccount.findFirstOrThrow({ where: { email: 'admin.a@example.test' } })
    ).id;
    const stores = await inCompany(app, companyA, (tx) =>
      tx.store.findMany({ where: { companyId: companyA }, select: { id: true, name: true } }),
    );
    shopifyStoreId = stores.find((store) => store.name === 'Nutbox Demo Shopify')?.id ?? '';
    prestaStoreId = stores.find((store) => store.name === 'Nutbox Demo PrestaShop')?.id ?? '';
    if (!shopifyStoreId || !prestaStoreId) {
      throw new Error('seed stores are missing');
    }
    adminA = await login(app, 'admin.a@example.test');
    adminB = await login(app, 'admin.b@example.test');
    fulfil = await login(app, 'fulfil.a@example.test');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('lets bp_app update the new columns and keeps the partial indexes and RLS policies', async () => {
    const prisma = started().get(PrismaService);
    const privileges = await prisma.client.$queryRaw<
      { company_version: boolean; brand_archived: boolean; location_archived: boolean }[]
    >`
      SELECT
        has_column_privilege(current_user, 'company', 'version', 'UPDATE') AS company_version,
        has_column_privilege(current_user, 'brand', 'archived_at', 'UPDATE') AS brand_archived,
        has_column_privilege(current_user, 'location', 'archived_at', 'UPDATE') AS location_archived
    `;
    expect(privileges[0]).toEqual({
      company_version: true,
      brand_archived: true,
      location_archived: true,
    });
    const policies = await prisma.client.$queryRaw<{ relname: string; polname: string }[]>`
      SELECT c.relname, p.polname
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      WHERE c.relname IN ('brand', 'location', 'store')
        AND p.polname = 'tenant_isolation'
      ORDER BY c.relname
    `;
    expect(policies).toEqual([
      { relname: 'brand', polname: 'tenant_isolation' },
      { relname: 'location', polname: 'tenant_isolation' },
      { relname: 'store', polname: 'tenant_isolation' },
    ]);
    const indexes = await prisma.client.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN ('user_identity_one_entra_key', 'gift_message_template_one_default_key')
      ORDER BY indexname
    `;
    expect(indexes.map((row) => row.indexname)).toEqual([
      'gift_message_template_one_default_key',
      'user_identity_one_entra_key',
    ]);
  });

  it('updates company details, audits field names, and rejects a stale version', async () => {
    const before = record(record(await read(adminA, 'get', `/api/c/${companyA}/context`)).company);
    try {
      const version = numberField(before, 'version');
      const legalName = `Fictional Legal ${runId}`;
      const vatNumber = `CY${runId}`;
      const correlationId = cid('company-patch');
      const saved = await send(adminA, 'patch', `/api/c/${companyA}/company`, correlationId, {
        expectedVersion: version,
        legalName: `  ${legalName}  `,
        vatNumber,
        timezone: 'Asia/Nicosia',
      });
      expect(saved.status, text(saved)).toBe(200);
      const company = record(record(saved.body).company);
      expect(company.legalName).toBe(legalName);
      expect(company.vatNumber).toBe(vatNumber);
      expect(company.version).toBe(version + 1);
      const events = await auditEvents(companyA, correlationId);
      expect(events).toEqual([
        expect.objectContaining({
          action: 'company.updated',
          objectType: 'company',
          objectId: companyA,
          outcome: 'success',
          correlationId,
        }),
      ]);
      const details = record(events[0]?.details);
      expect(details.fields).toEqual(['legalName', 'vatNumber']);
      expect(JSON.stringify(details)).not.toContain(legalName);
      expect(JSON.stringify(details)).not.toContain(vatNumber);

      const staleId = cid('company-stale');
      const stale = await send(adminA, 'patch', `/api/c/${companyA}/company`, staleId, {
        expectedVersion: version,
        tradingName: 'Should not stick',
      });
      expect(stale.status).toBe(409);
      expect(errorCode(stale.body)).toBe('conflict');
      expect(errorMessage(stale.body)).toBe('version_conflict');
      const staleAudit = await auditEvents(companyA, staleId);
      expect(staleAudit[0]).toEqual(
        expect.objectContaining({
          action: 'company.updated',
          outcome: 'failure',
          correlationId: staleId,
        }),
      );
      expect(detailReason(staleAudit[0]?.details)).toBe('version_conflict');
      const reread = record(
        record(await read(adminA, 'get', `/api/c/${companyA}/context`)).company,
      );
      expect(reread.tradingName).toBe(before.tradingName);
      expect(reread.version).toBe(version + 1);
    } finally {
      await inCompany(started(), companyA, (tx) =>
        tx.company.update({
          where: { id: companyA },
          data: { legalName: COMPANY_A, vatNumber: null, version: 1 },
        }),
      );
    }
  });

  it('rejects invalid company details and a missing permission', async () => {
    const version = numberField(
      record(record(await read(adminA, 'get', `/api/c/${companyA}/context`)).company),
      'version',
    );
    const badZone = await send(adminA, 'patch', `/api/c/${companyA}/company`, cid('bad-zone'), {
      expectedVersion: version,
      timezone: 'Not/AZone',
    });
    expect(badZone.status).toBe(400);
    const badCurrency = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/company`,
      cid('bad-currency'),
      {
        expectedVersion: version,
        defaultCurrency: 'EURO',
      },
    );
    expect(badCurrency.status).toBe(400);
    const unknownCurrency = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/company`,
      cid('unknown-currency'),
      {
        expectedVersion: version,
        defaultCurrency: 'ZZZ',
      },
    );
    expect(unknownCurrency.status).toBe(400);
    const yen = await send(adminA, 'patch', `/api/c/${companyA}/company`, cid('currency-jpy'), {
      expectedVersion: version,
      defaultCurrency: 'JPY',
    });
    expect(yen.status, text(yen)).toBe(400);
    expect(errorMessage(yen.body)).toContain('defaultCurrency must have two minor digits');
    const dinar = await send(adminA, 'patch', `/api/c/${companyA}/company`, cid('currency-kwd'), {
      expectedVersion: version,
      defaultCurrency: 'KWD',
    });
    expect(dinar.status, text(dinar)).toBe(400);
    expect(errorMessage(dinar.body)).toContain('defaultCurrency must have two minor digits');
    const offset = await send(adminA, 'patch', `/api/c/${companyA}/company`, cid('offset-zone'), {
      expectedVersion: version,
      timezone: '+03:00',
    });
    expect(offset.status).toBe(400);
    const blankVat = await send(adminA, 'patch', `/api/c/${companyA}/company`, cid('blank-vat'), {
      expectedVersion: version,
      vatNumber: '   ',
    });
    expect(blankVat.status).toBe(400);
    const badTerms = await send(adminA, 'patch', `/api/c/${companyA}/company`, cid('bad-terms'), {
      expectedVersion: version,
      paymentTermsDays: 366,
    });
    expect(badTerms.status).toBe(400);
    const extra = await send(adminA, 'patch', `/api/c/${companyA}/company`, cid('extra'), {
      expectedVersion: version,
      countryCode: 'CY',
    });
    expect(extra.status).toBe(400);
    const correlationId = cid('company-denied');
    const denied = await send(fulfil, 'patch', `/api/c/${companyA}/company`, correlationId, {
      expectedVersion: version,
      legalName: 'Not allowed',
    });
    expect(denied.status).toBe(403);
    expect(errorCode(denied.body)).toBe('forbidden');
    const events = await auditEvents(companyA, correlationId);
    expect(events[0]).toEqual(
      expect.objectContaining({ action: 'authorization.denied', outcome: 'denied', correlationId }),
    );
    expect(detailReason(events[0]?.details)).toBe('permission_missing');
    const foreign = await send(
      adminB,
      'patch',
      `/api/c/${companyA}/company`,
      cid('company-foreign'),
      {
        expectedVersion: version,
        legalName: 'Other company',
      },
    );
    expect(foreign.status).toBe(404);
  });

  it('accepts EUR and USD as the company currency', async () => {
    const before = record(record(await read(adminA, 'get', `/api/c/${companyA}/context`)).company);
    const version = numberField(before, 'version');
    try {
      const eur = await send(adminA, 'patch', `/api/c/${companyA}/company`, cid('currency-eur'), {
        expectedVersion: version,
        defaultCurrency: 'EUR',
      });
      expect(eur.status, text(eur)).toBe(200);
      expect(stringField(record(record(eur.body).company), 'defaultCurrency')).toBe('EUR');
      const eurVersion = numberField(record(record(eur.body).company), 'version');
      const usd = await send(adminA, 'patch', `/api/c/${companyA}/company`, cid('currency-usd'), {
        expectedVersion: eurVersion,
        defaultCurrency: 'USD',
      });
      expect(usd.status, text(usd)).toBe(200);
      expect(stringField(record(record(usd.body).company), 'defaultCurrency')).toBe('USD');
    } finally {
      await inCompany(started(), companyA, (tx) =>
        tx.company.update({
          where: { id: companyA },
          data: { defaultCurrency: 'EUR', version: 1 },
        }),
      );
    }
  });

  it('returns the current company when a patch changes nothing, and rejects a stale no-op', async () => {
    const before = record(record(await read(adminA, 'get', `/api/c/${companyA}/context`)).company);
    const version = numberField(before, 'version');
    expect(version).toBeGreaterThan(0);
    const legalName = stringField(before, 'legalName');
    const correlationId = cid('company-noop');
    const same = await send(adminA, 'patch', `/api/c/${companyA}/company`, correlationId, {
      expectedVersion: version,
      legalName,
    });
    expect(same.status, text(same)).toBe(200);
    expect(numberField(record(record(same.body).company), 'version')).toBe(version);
    expect(await auditEvents(companyA, correlationId)).toEqual([]);

    const staleId = cid('company-noop-stale');
    const stale = await send(adminA, 'patch', `/api/c/${companyA}/company`, staleId, {
      expectedVersion: version - 1,
      legalName,
    });
    expect(stale.status).toBe(409);
    expect(errorCode(stale.body)).toBe('conflict');
    expect(errorMessage(stale.body)).toBe('version_conflict');
    const reread = record(record(await read(adminA, 'get', `/api/c/${companyA}/context`)).company);
    expect(numberField(reread, 'version')).toBe(version);
    expect(detailReason((await auditEvents(companyA, staleId))[0]?.details)).toBe(
      'version_conflict',
    );
  });

  it('clears a VAT number and a location timezone with null', async () => {
    const before = record(record(await read(adminA, 'get', `/api/c/${companyA}/context`)).company);
    const version = numberField(before, 'version');
    const tradingName = stringField(before, 'tradingName');
    const vatNumber = `CY${runId}`;
    try {
      const set = await send(adminA, 'patch', `/api/c/${companyA}/company`, cid('vat-set'), {
        expectedVersion: version,
        vatNumber,
      });
      expect(set.status, text(set)).toBe(200);
      const setVersion = numberField(record(record(set.body).company), 'version');
      const correlationId = cid('vat-clear');
      const cleared = await send(adminA, 'patch', `/api/c/${companyA}/company`, correlationId, {
        expectedVersion: setVersion,
        vatNumber: null,
      });
      expect(cleared.status, text(cleared)).toBe(200);
      const company = record(record(cleared.body).company);
      expect(company.vatNumber).toBeNull();
      expect(company.version).toBe(setVersion + 1);
      expect(record((await auditEvents(companyA, correlationId))[0]?.details).fields).toEqual([
        'vatNumber',
      ]);

      const blankName = await send(
        adminA,
        'patch',
        `/api/c/${companyA}/company`,
        cid('name-blank'),
        {
          expectedVersion: setVersion + 1,
          tradingName: '   ',
        },
      );
      expect(blankName.status, text(blankName)).toBe(400);
      const nullName = await send(adminA, 'patch', `/api/c/${companyA}/company`, cid('name-null'), {
        expectedVersion: setVersion + 1,
        tradingName: null,
      });
      expect(nullName.status, text(nullName)).toBe(400);
      const kept = record(record(await read(adminA, 'get', `/api/c/${companyA}/context`)).company);
      expect(kept.tradingName).toBe(tradingName);
      expect(numberField(kept, 'version')).toBe(setVersion + 1);

      const created = await send(
        adminA,
        'post',
        `/api/c/${companyA}/locations`,
        cid('zone-create'),
        {
          name: `Zone ${runId}`,
          address: { line1: '9 Demo Street', city: 'Nicosia', countryCode: 'CY' },
          timezone: 'Asia/Nicosia',
        },
      );
      expect(created.status, text(created)).toBe(200);
      const locationId = stringField(record(record(created.body).location), 'id');
      const badZone = await send(
        adminA,
        'patch',
        `/api/c/${companyA}/locations/${locationId}`,
        cid('zone-offset'),
        { timezone: '+03:00' },
      );
      expect(badZone.status).toBe(400);
      const zoneId = cid('zone-clear');
      const zone = await send(
        adminA,
        'patch',
        `/api/c/${companyA}/locations/${locationId}`,
        zoneId,
        { timezone: null },
      );
      expect(zone.status, text(zone)).toBe(200);
      expect(record(record(zone.body).location).timezone).toBeNull();
      expect(record((await auditEvents(companyA, zoneId))[0]?.details).fields).toEqual([
        'timezone',
      ]);
    } finally {
      await inCompany(started(), companyA, (tx) =>
        tx.company.update({
          where: { id: companyA },
          data: { vatNumber: null, tradingName, version: 1 },
        }),
      );
    }
  });

  it('keeps brand names unique among active brands, including a concurrent create', async () => {
    const name = `Grove ${runId}`;
    const created = await send(adminA, 'post', `/api/c/${companyA}/brands`, cid('brand-create'), {
      name: `  ${name}  `,
    });
    expect(created.status, text(created)).toBe(200);
    const brand = record(record(created.body).brand);
    expect(brand.name).toBe(name);
    expect(brand.archivedAt).toBeNull();
    const createAudit = await auditEvents(companyA, cid('brand-create'));
    expect(createAudit[0]).toEqual(
      expect.objectContaining({ action: 'brand.created', objectType: 'brand', outcome: 'success' }),
    );
    const clash = await send(adminA, 'post', `/api/c/${companyA}/brands`, cid('brand-clash'), {
      name: name.toUpperCase(),
    });
    expect(clash.status).toBe(409);
    expect(errorCode(clash.body)).toBe('name_taken');

    const raceName = `Race ${runId}`;
    const raced = await Promise.all([
      send(adminA, 'post', `/api/c/${companyA}/brands`, cid('brand-race-1'), { name: raceName }),
      send(adminA, 'post', `/api/c/${companyA}/brands`, cid('brand-race-2'), {
        name: raceName.toLowerCase(),
      }),
    ]);
    const statuses = raced.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(
      raced.find(
        (response) => response.status === 409 && errorCode(response.body) === 'name_taken',
      ),
    ).toBeDefined();
    const active = await inCompany(
      started(),
      companyA,
      (tx) =>
        tx.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM brand
        WHERE company_id = ${companyA}::uuid
          AND archived_at IS NULL
          AND lower(name) = lower(${raceName})
      `,
    );
    expect(active[0]?.count).toBe(1);

    const archived = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/brands/${stringField(brand, 'id')}`,
      cid('brand-archive'),
      {
        archived: true,
      },
    );
    expect(archived.status, text(archived)).toBe(200);
    expect(record(record(archived.body).brand).archivedAt).toEqual(expect.any(String));
    const reused = await send(adminA, 'post', `/api/c/${companyA}/brands`, cid('brand-reuse'), {
      name,
    });
    expect(reused.status, text(reused)).toBe(200);
    const restore = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/brands/${stringField(brand, 'id')}`,
      cid('brand-restore'),
      { archived: false },
    );
    expect(restore.status).toBe(409);
    expect(errorCode(restore.body)).toBe('name_taken');

    const listed = await read(adminA, 'get', `/api/c/${companyA}/brands`);
    const names = arrayOf(record(listed).brands).map((row) => stringField(record(row), 'name'));
    const groveAt = names.findIndex((item) => item.toLowerCase() === name.toLowerCase());
    const raceAt = names.findIndex((item) => item.toLowerCase() === raceName.toLowerCase());
    expect(groveAt).toBeGreaterThanOrEqual(0);
    expect(raceAt).toBeGreaterThan(groveAt);
    expect(arrayOf(record(listed).brands).some((row) => record(row).archivedAt !== null)).toBe(
      true,
    );
  });

  it('rejects a brand write without permission and another company id', async () => {
    const correlationId = cid('brand-denied');
    const denied = await send(fulfil, 'post', `/api/c/${companyA}/brands`, correlationId, {
      name: 'No',
    });
    expect(denied.status).toBe(403);
    const events = await auditEvents(companyA, correlationId);
    expect(detailReason(events[0]?.details)).toBe('permission_missing');
    expect(record(events[0]?.details).permission).toBe('store.manage');
    const foreignBrand = record(
      record(
        (
          await send(adminB, 'post', `/api/c/${companyB}/brands`, cid('brand-b'), {
            name: `Other ${runId}`,
          })
        ).body,
      ).brand,
    );
    const hidden = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/brands/${stringField(foreignBrand, 'id')}`,
      cid('brand-hidden'),
      {
        name: 'Stolen',
      },
    );
    expect(hidden.status).toBe(404);
    const invalid = await send(adminA, 'post', `/api/c/${companyA}/brands`, cid('brand-invalid'), {
      name: '  ',
      extra: true,
    });
    expect(invalid.status).toBe(400);
  });

  it('refuses to archive a location that has an active store or a printer mapping', async () => {
    const listed = await read(adminA, 'get', `/api/c/${companyA}/locations`);
    const nicosia = arrayOf(record(listed).locations)
      .map((row) => record(row))
      .find((row) => row.name === 'Demo Shop – Nicosia');
    if (!nicosia) {
      throw new Error('seed location is missing');
    }
    expect(nicosia.archivedAt).toBeNull();
    expect(record(nicosia.address).line1).toBe('1 Demo Street');
    const blocked = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/locations/${stringField(nicosia, 'id')}`,
      cid('loc-used'),
      {
        archived: true,
      },
    );
    expect(blocked.status).toBe(409);
    expect(errorCode(blocked.body)).toBe('location_in_use');
    const created = await send(adminA, 'post', `/api/c/${companyA}/locations`, cid('loc-create'), {
      name: `Spare ${runId}`,
      address: { line1: '2 Demo Street', city: 'Nicosia', countryCode: 'CY' },
      timezone: 'Asia/Nicosia',
    });
    expect(created.status, text(created)).toBe(200);
    const locationId = stringField(record(record(created.body).location), 'id');
    const archived = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/locations/${locationId}`,
      cid('loc-archive'),
      {
        archived: true,
      },
    );
    expect(archived.status, text(archived)).toBe(200);
    expect(record(record(archived.body).location).archivedAt).toEqual(expect.any(String));
    const archiveAudit = await auditEvents(companyA, cid('loc-archive'));
    expect(archiveAudit[0]?.action).toBe('location.archived');

    const correlationId = cid('loc-denied');
    const denied = await send(fulfil, 'post', `/api/c/${companyA}/locations`, correlationId, {
      name: 'No',
      address: { line1: '3 Demo Street', city: 'Nicosia', countryCode: 'CY' },
    });
    expect(denied.status).toBe(403);
    expect(detailReason((await auditEvents(companyA, correlationId))[0]?.details)).toBe(
      'permission_missing',
    );
    const foreign = await send(adminB, 'post', `/api/c/${companyB}/locations`, cid('loc-b'), {
      name: `Other place ${runId}`,
      address: { line1: '4 Demo Street', city: 'Larnaca', countryCode: 'CY' },
    });
    const foreignId = stringField(record(record(foreign.body).location), 'id');
    const hidden = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/locations/${foreignId}`,
      cid('loc-hidden'),
      {
        name: 'Stolen',
      },
    );
    expect(hidden.status).toBe(404);
  });

  it('creates a store, keeps the platform, and hides another company and an archived parent', async () => {
    const brands = arrayOf(
      record(await read(adminA, 'get', `/api/c/${companyA}/brands`)).brands,
    ).map((row) => record(row));
    const brand = brands.find((row) => row.archivedAt === null);
    const locations = arrayOf(
      record(await read(adminA, 'get', `/api/c/${companyA}/locations`)).locations,
    ).map((row) => record(row));
    const location = locations.find((row) => row.archivedAt === null);
    if (!brand || !location) {
      throw new Error('an active brand and location are required');
    }
    const created = await send(adminA, 'post', `/api/c/${companyA}/stores`, cid('store-create'), {
      name: `Demo Presta ${runId}`,
      platform: 'prestashop',
      brandId: stringField(brand, 'id'),
      locationId: stringField(location, 'id'),
      domain: 'demo-shop.example.test',
    });
    expect(created.status, text(created)).toBe(200);
    const store = record(record(created.body).store);
    expect(store.platform).toBe('prestashop');
    expect(store.domain).toBe('demo-shop.example.test');
    expect(store.invoiceAuthority).toBe('undecided');
    expect(store.status).toBe('active');
    expect(store.connections).toEqual([]);
    const storeId = stringField(store, 'id');
    const unchanged = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/stores/${storeId}`,
      cid('store-platform'),
      {
        platform: 'shopify',
        name: 'Should not apply',
      },
    );
    expect(unchanged.status).toBe(400);
    const reread = record(
      record(await read(adminA, 'get', `/api/c/${companyA}/stores/${storeId}`)).store,
    );
    expect(reread.platform).toBe('prestashop');
    expect(reread.name).toBe(`Demo Presta ${runId}`);

    const seedStore = record(
      record(await read(adminA, 'get', `/api/c/${companyA}/stores/${shopifyStoreId}`)).store,
    );
    const connection = record(arrayOf(seedStore.connections)[0]);
    expect(Object.keys(connection).sort()).toEqual(['id', 'mode', 'status']);
    expect(JSON.stringify(connection)).not.toContain('settings');

    const archivedBrand = await send(
      adminA,
      'post',
      `/api/c/${companyA}/brands`,
      cid('store-arch-brand'),
      {
        name: `Archived brand ${runId}`,
      },
    );
    const archivedBrandId = stringField(record(record(archivedBrand.body).brand), 'id');
    await send(
      adminA,
      'patch',
      `/api/c/${companyA}/brands/${archivedBrandId}`,
      cid('store-arch-brand-do'),
      { archived: true },
    );
    const brandBlocked = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/stores/${storeId}`,
      cid('store-brand-arch'),
      {
        brandId: archivedBrandId,
      },
    );
    expect(brandBlocked.status).toBe(422);
    expect(errorCode(brandBlocked.body)).toBe('brand_archived');

    const spare = await send(
      adminA,
      'post',
      `/api/c/${companyA}/locations`,
      cid('store-arch-loc'),
      {
        name: `Archived place ${runId}`,
        address: { line1: '9 Demo Street', city: 'Nicosia', countryCode: 'CY' },
      },
    );
    const spareId = stringField(record(record(spare.body).location), 'id');
    await send(
      adminA,
      'patch',
      `/api/c/${companyA}/locations/${spareId}`,
      cid('store-arch-loc-do'),
      { archived: true },
    );
    const locationBlocked = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/stores/${storeId}`,
      cid('store-loc-arch'),
      {
        locationId: spareId,
      },
    );
    expect(locationBlocked.status).toBe(422);
    expect(errorCode(locationBlocked.body)).toBe('location_archived');

    const badDomain = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/stores/${storeId}`,
      cid('store-domain'),
      {
        domain: 'https://demo-shop.example.test/admin',
      },
    );
    expect(badDomain.status).toBe(400);

    const correlationId = cid('store-denied');
    const denied = await send(fulfil, 'post', `/api/c/${companyA}/stores`, correlationId, {
      name: 'No',
      platform: 'manual',
      brandId: stringField(brand, 'id'),
      locationId: stringField(location, 'id'),
    });
    expect(denied.status).toBe(403);
    expect(detailReason((await auditEvents(companyA, correlationId))[0]?.details)).toBe(
      'permission_missing',
    );

    const foreignStore = stringField(
      record(
        record(
          (
            await send(adminB, 'post', `/api/c/${companyB}/stores`, cid('store-b'), {
              name: `Other store ${runId}`,
              platform: 'manual',
              brandId: stringField(
                record(
                  arrayOf(
                    record(await read(adminB, 'get', `/api/c/${companyB}/brands`)).brands,
                  ).map((row) => record(row))[0] ?? {},
                ),
                'id',
              ),
              locationId: stringField(
                record(
                  arrayOf(
                    record(await read(adminB, 'get', `/api/c/${companyB}/locations`)).locations,
                  ).map((row) => record(row))[0] ?? {},
                ),
                'id',
              ),
            })
          ).body,
        ).store,
      ),
      'id',
    );
    const missed = await send(
      adminA,
      'get',
      `/api/c/${companyA}/stores/${foreignStore}`,
      cid('store-hidden'),
    );
    expect(missed.status).toBe(404);
    const missedPatch = await send(
      adminA,
      'patch',
      `/api/c/${companyA}/stores/${foreignStore}`,
      cid('store-hidden-patch'),
      {
        name: 'Stolen',
      },
    );
    expect(missedPatch.status).toBe(404);
  });

  it('shows a store-scoped member only the granted store', async () => {
    const email = `store.scope.${runId}@example.test`;
    const prisma = started().get(PrismaService);
    const role = await prisma.client.role.findFirstOrThrow({
      where: { companyId: companyA, key: 'AUD' },
    });
    await prisma.client.userAccount.create({
      data: {
        email,
        displayName: 'Store scope (fictional)',
        identities: {
          create: {
            provider: 'dev',
            issuer: 'https://dev-login.invalid',
            subject: email,
            emailAtLink: email,
          },
        },
        memberships: {
          create: {
            companyId: companyA,
            status: 'active',
            roles: {
              create: {
                roleId: role.id,
                scopeType: 'store',
                scopeId: shopifyStoreId,
                grantedById: adminUserId,
              },
            },
          },
        },
      },
    });
    const scoped = await login(started(), email);
    const listed = await read(scoped, 'get', `/api/c/${companyA}/stores`);
    const rows = arrayOf(record(listed).stores).map((row) => record(row));
    expect(rows.map((row) => stringField(row, 'id'))).toEqual([shopifyStoreId]);
    const listedStore = rows[0];
    if (!listedStore) {
      throw new Error('the granted store is missing');
    }
    const brand = record(listedStore.brand);
    const location = record(listedStore.location);
    expect(stringField(brand, 'name')).toBe('Nutbox (demo)');
    expect(stringField(brand, 'id').length).toBeGreaterThan(0);
    expect(stringField(location, 'name')).toBe('Demo Shop – Nicosia');
    expect(stringField(location, 'id').length).toBeGreaterThan(0);
    const other = await send(
      scoped,
      'get',
      `/api/c/${companyA}/stores/${prestaStoreId}`,
      cid('store-scope'),
    );
    expect(other.status).toBe(404);
    const own = record(
      record(await read(scoped, 'get', `/api/c/${companyA}/stores/${shopifyStoreId}`)).store,
    );
    expect(stringField(own, 'id')).toBe(shopifyStoreId);
    expect(record(own.brand)).toEqual(record(listedStore.brand));
    expect(record(own.location)).toEqual(record(listedStore.location));
  });
});

function started(): INestApplication {
  if (!app) {
    throw new Error('the API was not started');
  }
  return app;
}

let app: INestApplication | undefined;

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

function send(
  session: Session,
  method: 'get' | 'post' | 'patch',
  url: string,
  correlationId: string,
  payload?: unknown,
) {
  const call = session.agent[method](url)
    .set('X-XSRF-TOKEN', session.xsrf)
    .set('X-Correlation-Id', correlationId);
  if (payload !== undefined) {
    call.send(payload as object);
  }
  return call;
}

async function read(
  session: Session,
  method: 'get',
  url: string,
): Promise<Record<string, unknown>> {
  const response = await send(session, method, url, cid('read'));
  expect(response.status, text(response)).toBe(200);
  return record(response.body);
}

function cid(name: string): string {
  return `setup-${name}-${runId}`.slice(0, 64);
}

async function auditEvents(companyId: string, correlationId: string) {
  const prisma = started().get(PrismaService);
  return prisma.client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.company_id', ${companyId}, true)`;
    return tx.auditEvent.findMany({ where: { correlationId }, orderBy: { occurredAt: 'asc' } });
  });
}

function inCompany<T>(
  application: INestApplication,
  companyId: string,
  fn: (tx: import('@bp/db').TenantTransaction) => Promise<T>,
) {
  return new TenantDb(application.get(PrismaService).client).run(
    { companyId, actor: 'setup-test', correlationId: randomUUID() },
    fn,
  );
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

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== 'number') {
    throw new Error(`${key} is missing`);
  }
  return field;
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
  if (typeof details !== 'object' || details === null || !('reason' in details)) {
    return undefined;
  }
  const reason = details.reason;
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
