import { Inject, Injectable } from '@nestjs/common';
import { Prisma, TenantDb, type TenantTransaction } from '@bp/db';
import { permittedScopeFilter } from '@bp/domain';
import { AuditService } from '../audit/audit.service';
import { isUuid } from '../authz/company-path';
import type { RequestContext } from '../authz/request-context';
import { CommerceError, settleCommerceError } from '../commerce/errors';
import { requireActor } from '../commerce/http';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';
import { companyDetails, type CompanyDetails } from './company-details';
import type {
  BrandCreate,
  BrandPatch,
  CompanyPatch,
  LocationCreate,
  LocationPatch,
  StoreCreate,
  StorePatch,
} from './company-setup.schema';

export type BrandView = {
  id: string;
  name: string;
  archivedAt: string | null;
};

export type LocationView = {
  id: string;
  name: string;
  address: unknown;
  timezone: string | null;
  archivedAt: string | null;
};

export type StoreConnectionView = {
  id: string;
  mode: string;
  status: string;
};

export type StoreView = {
  id: string;
  name: string;
  platform: string;
  brandId: string;
  locationId: string;
  domain: string | null;
  invoiceAuthority: string;
  status: string;
  brand: { id: string; name: string };
  location: { id: string; name: string };
  connections: StoreConnectionView[];
};

const storeSelect = {
  id: true,
  name: true,
  platform: true,
  brandId: true,
  locationId: true,
  domain: true,
  invoiceAuthority: true,
  status: true,
  brand: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  connections: {
    select: { id: true, mode: true, status: true },
    orderBy: { id: 'asc' as const },
  },
} satisfies Prisma.StoreSelect;

type StoreRow = Prisma.StoreGetPayload<{ select: typeof storeSelect }>;

@Injectable()
export class CompanySetupService {
  private readonly tenant: TenantDb;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditLog: AuditService,
  ) {
    this.tenant = new TenantDb(prisma.client);
  }

  async updateCompany(
    ctx: RequestContext,
    input: CompanyPatch,
    meta: RequestMeta,
  ): Promise<CompanyDetails> {
    const actor = requireActor(ctx);
    try {
      return await this.tenant.run(this.context(ctx, actor), async (tx) => {
        const current = await this.lockCompany(tx, ctx.companyId);
        if (current.version !== input.expectedVersion) {
          throw new CommerceError(
            409,
            'version_conflict',
            'company',
            current.id,
            'version_conflict',
            'company.updated',
          );
        }
        const next = companyDiff(current, input);
        // Unchanged values are not a write: same version, no audit.
        // expectedVersion was checked above, so a stale no-op is still a conflict.
        if (next.fields.length === 0) {
          return current;
        }
        const updated = await tx.company.updateMany({
          where: { id: current.id, version: input.expectedVersion },
          data: { ...next.data, version: { increment: 1 } },
        });
        if (updated.count !== 1) {
          throw new CommerceError(
            409,
            'version_conflict',
            'company',
            current.id,
            'version_conflict',
            'company.updated',
          );
        }
        const saved = companyDetails(
          await tx.company.findUniqueOrThrow({ where: { id: current.id } }),
        );
        await this.audit(tx, ctx, meta, 'company.updated', 'company', saved.id, {
          fields: next.fields,
        });
        return saved;
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async listBrands(ctx: RequestContext): Promise<{ brands: BrandView[] }> {
    const actor = requireActor(ctx);
    const rows = await this.tenant.run(this.context(ctx, actor), (tx) =>
      tx.brand.findMany({
        where: { companyId: ctx.companyId },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, archivedAt: true },
      }),
    );
    return { brands: rows.map(toBrand) };
  }

  async createBrand(
    ctx: RequestContext,
    input: BrandCreate,
    meta: RequestMeta,
  ): Promise<BrandView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenant.run(this.context(ctx, actor), async (tx) => {
        await lockBrandName(tx, ctx.companyId, input.name);
        if (await brandNameTaken(tx, ctx.companyId, input.name)) {
          throw new CommerceError(409, 'name_taken', 'brand', null, 'name_taken', 'brand.created');
        }
        const created = await tx.brand.create({
          data: { companyId: ctx.companyId, name: input.name },
          select: { id: true, name: true, archivedAt: true },
        });
        await this.audit(tx, ctx, meta, 'brand.created', 'brand', created.id, {});
        return toBrand(created);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async updateBrand(
    ctx: RequestContext,
    brandId: string,
    input: BrandPatch,
    meta: RequestMeta,
  ): Promise<BrandView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenant.run(this.context(ctx, actor), async (tx) => {
        const current = await this.lockBrand(tx, ctx.companyId, brandId);
        const wasArchived = current.archivedAt !== null;
        const archived = input.archived ?? wasArchived;
        const name = input.name ?? current.name;
        if (!archived) {
          await lockBrandName(tx, ctx.companyId, name);
          if (await brandNameTaken(tx, ctx.companyId, name, current.id)) {
            throw new CommerceError(
              409,
              'name_taken',
              'brand',
              current.id,
              'name_taken',
              'brand.updated',
            );
          }
        }
        const nameChanged = input.name !== undefined && input.name !== current.name;
        const archiveChanged = input.archived !== undefined && input.archived !== wasArchived;
        if (!nameChanged && !archiveChanged) {
          return toBrand(current);
        }
        const saved = await tx.brand.update({
          where: { id: current.id },
          data: {
            ...(nameChanged ? { name: input.name } : {}),
            ...(input.archived === true && !wasArchived ? { archivedAt: new Date() } : {}),
            ...(input.archived === false && wasArchived ? { archivedAt: null } : {}),
          },
          select: { id: true, name: true, archivedAt: true },
        });
        if (nameChanged) {
          await this.audit(tx, ctx, meta, 'brand.updated', 'brand', saved.id, { fields: ['name'] });
        }
        if (input.archived === true && !wasArchived) {
          await this.audit(tx, ctx, meta, 'brand.archived', 'brand', saved.id, {});
        }
        if (input.archived === false && wasArchived) {
          await this.audit(tx, ctx, meta, 'brand.restored', 'brand', saved.id, {});
        }
        return toBrand(saved);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async createLocation(
    ctx: RequestContext,
    input: LocationCreate,
    meta: RequestMeta,
  ): Promise<LocationView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenant.run(this.context(ctx, actor), async (tx) => {
        const created = await tx.location.create({
          data: {
            companyId: ctx.companyId,
            name: input.name,
            address: input.address,
            timezone: input.timezone ?? null,
          },
          select: locationSelect,
        });
        await this.audit(tx, ctx, meta, 'location.created', 'location', created.id, {});
        return toLocation(created);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async updateLocation(
    ctx: RequestContext,
    locationId: string,
    input: LocationPatch,
    meta: RequestMeta,
  ): Promise<LocationView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenant.run(this.context(ctx, actor), async (tx) => {
        const current = await this.lockLocation(tx, ctx.companyId, locationId);
        const wasArchived = current.archivedAt !== null;
        const fields = locationFields(current, input);
        const archiveOn = input.archived === true && !wasArchived;
        const archiveOff = input.archived === false && wasArchived;
        if (fields.length === 0 && !archiveOn && !archiveOff) {
          return toLocation(current);
        }
        if (archiveOn) {
          await this.assertLocationFree(tx, ctx.companyId, current.id);
        }
        const saved = await tx.location.update({
          where: { id: current.id },
          data: {
            ...(fields.includes('name') ? { name: input.name } : {}),
            ...(fields.includes('address') ? { address: input.address } : {}),
            ...(fields.includes('timezone') ? { timezone: input.timezone } : {}),
            ...(archiveOn ? { archivedAt: new Date() } : {}),
            ...(archiveOff ? { archivedAt: null } : {}),
          },
          select: locationSelect,
        });
        if (fields.length > 0) {
          await this.audit(tx, ctx, meta, 'location.updated', 'location', saved.id, { fields });
        }
        if (archiveOn) {
          await this.audit(tx, ctx, meta, 'location.archived', 'location', saved.id, {});
        }
        if (archiveOff) {
          await this.audit(tx, ctx, meta, 'location.restored', 'location', saved.id, {});
        }
        return toLocation(saved);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async listStores(ctx: RequestContext): Promise<{ stores: StoreView[] }> {
    const actor = requireActor(ctx);
    const scope = permittedScopeFilter(ctx.grants, 'store.view', 'store');
    if (scope.kind === 'none') {
      return { stores: [] };
    }
    const rows = await this.tenant.run(this.context(ctx, actor), (tx) =>
      tx.store.findMany({
        where: {
          companyId: ctx.companyId,
          ...(scope.kind === 'ids' ? { id: { in: scope.ids } } : {}),
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: storeSelect,
      }),
    );
    return { stores: rows.map(toStore) };
  }

  async getStore(ctx: RequestContext, storeId: string, meta: RequestMeta): Promise<StoreView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenant.run(this.context(ctx, actor), async (tx) => {
        const store = await this.findStore(tx, ctx.companyId, storeId);
        return toStore(store);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async createStore(
    ctx: RequestContext,
    input: StoreCreate,
    meta: RequestMeta,
  ): Promise<StoreView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenant.run(this.context(ctx, actor), async (tx) => {
        const brandId = input.brandId.toLowerCase();
        const locationId = input.locationId.toLowerCase();
        await this.requireActiveBrand(tx, ctx.companyId, brandId, 'store.created');
        await this.requireActiveLocation(tx, ctx.companyId, locationId, 'store.created');
        const created = await tx.store.create({
          data: {
            companyId: ctx.companyId,
            name: input.name,
            platform: input.platform,
            brandId,
            locationId,
            domain: input.domain ?? null,
            invoiceAuthority: input.invoiceAuthority ?? 'undecided',
          },
          select: storeSelect,
        });
        await this.audit(tx, ctx, meta, 'store.created', 'store', created.id, {
          platform: created.platform,
        });
        return toStore(created);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async updateStore(
    ctx: RequestContext,
    storeId: string,
    input: StorePatch,
    meta: RequestMeta,
  ): Promise<StoreView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenant.run(this.context(ctx, actor), async (tx) => {
        const current = await this.lockStore(tx, ctx.companyId, storeId);
        const wasArchived = current.status === 'archived';
        const archiveOn = input.archived === true && !wasArchived;
        const archiveOff = input.archived === false && wasArchived;
        const nextBrand = input.brandId?.toLowerCase() ?? current.brandId;
        const nextLocation = input.locationId?.toLowerCase() ?? current.locationId;
        const staysActive = input.archived === undefined ? !wasArchived : !input.archived;
        if (input.brandId !== undefined || (staysActive && archiveOff)) {
          await this.requireActiveBrand(tx, ctx.companyId, nextBrand, 'store.updated');
        }
        if (input.locationId !== undefined || (staysActive && archiveOff)) {
          await this.requireActiveLocation(tx, ctx.companyId, nextLocation, 'store.updated');
        }
        const fields = storeFields(current, input);
        if (fields.length === 0 && !archiveOn && !archiveOff) {
          return toStore(current);
        }
        const saved = await tx.store.update({
          where: { id: current.id },
          data: {
            ...(fields.includes('name') ? { name: input.name } : {}),
            ...(fields.includes('brandId') ? { brandId: nextBrand } : {}),
            ...(fields.includes('locationId') ? { locationId: nextLocation } : {}),
            ...(fields.includes('domain') ? { domain: input.domain } : {}),
            ...(fields.includes('invoiceAuthority')
              ? { invoiceAuthority: input.invoiceAuthority }
              : {}),
            ...(archiveOn ? { status: 'archived' } : {}),
            ...(archiveOff ? { status: 'active' } : {}),
          },
          select: storeSelect,
        });
        if (fields.length > 0) {
          await this.audit(tx, ctx, meta, 'store.updated', 'store', saved.id, { fields });
        }
        if (archiveOn) {
          await this.audit(tx, ctx, meta, 'store.archived', 'store', saved.id, {});
        }
        if (archiveOff) {
          await this.audit(tx, ctx, meta, 'store.restored', 'store', saved.id, {});
        }
        return toStore(saved);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  private async lockCompany(tx: TenantTransaction, companyId: string): Promise<CompanyDetails> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM company WHERE id = ${companyId}::uuid FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new CommerceError(404, 'company_not_found', 'company', companyId, 'Not found');
    }
    return companyDetails(await tx.company.findUniqueOrThrow({ where: { id: companyId } }));
  }

  private async lockBrand(
    tx: TenantTransaction,
    companyId: string,
    brandId: string,
  ): Promise<{ id: string; name: string; archivedAt: Date | null }> {
    const id = this.objectId(brandId, 'brand', 'brand_not_found');
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM brand
      WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new CommerceError(404, 'brand_not_found', 'brand', id, 'Not found');
    }
    return tx.brand.findFirstOrThrow({
      where: { id, companyId },
      select: { id: true, name: true, archivedAt: true },
    });
  }

  private async lockLocation(
    tx: TenantTransaction,
    companyId: string,
    locationId: string,
  ): Promise<LocationRow> {
    const id = this.objectId(locationId, 'location', 'location_not_found');
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM location
      WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new CommerceError(404, 'location_not_found', 'location', id, 'Not found');
    }
    return tx.location.findFirstOrThrow({ where: { id, companyId }, select: locationSelect });
  }

  private async lockStore(
    tx: TenantTransaction,
    companyId: string,
    storeId: string,
  ): Promise<StoreRow> {
    const id = this.objectId(storeId, 'store', 'store_not_found');
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM store
      WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new CommerceError(404, 'store_not_found', 'store', id, 'Not found');
    }
    return this.findStore(tx, companyId, id);
  }

  private async findStore(
    tx: TenantTransaction,
    companyId: string,
    storeId: string,
  ): Promise<StoreRow> {
    const id = this.objectId(storeId, 'store', 'store_not_found');
    const store = await tx.store.findFirst({ where: { id, companyId }, select: storeSelect });
    if (!store) {
      throw new CommerceError(404, 'store_not_found', 'store', id, 'Not found');
    }
    return store;
  }

  private async requireActiveBrand(
    tx: TenantTransaction,
    companyId: string,
    brandId: string,
    action: string,
  ): Promise<void> {
    const id = this.objectId(brandId, 'brand', 'brand_not_found');
    const locked = await tx.$queryRaw<{ id: string; archived_at: Date | null }[]>`
      SELECT id::text AS id, archived_at FROM brand
      WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      FOR UPDATE
    `;
    const brand = locked[0];
    if (!brand) {
      throw new CommerceError(404, 'brand_not_found', 'brand', id, 'Not found');
    }
    if (brand.archived_at) {
      throw new CommerceError(422, 'brand_archived', 'brand', id, 'brand_archived', action);
    }
  }

  private async requireActiveLocation(
    tx: TenantTransaction,
    companyId: string,
    locationId: string,
    action: string,
  ): Promise<void> {
    const id = this.objectId(locationId, 'location', 'location_not_found');
    const locked = await tx.$queryRaw<{ id: string; archived_at: Date | null }[]>`
      SELECT id::text AS id, archived_at FROM location
      WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      FOR UPDATE
    `;
    const location = locked[0];
    if (!location) {
      throw new CommerceError(404, 'location_not_found', 'location', id, 'Not found');
    }
    if (location.archived_at) {
      throw new CommerceError(
        422,
        'location_archived',
        'location',
        id,
        'location_archived',
        action,
      );
    }
  }

  private async assertLocationFree(
    tx: TenantTransaction,
    companyId: string,
    locationId: string,
  ): Promise<void> {
    const activeStores = await tx.store.count({
      where: { companyId, locationId, status: 'active' },
    });
    const mappings = await tx.printerMapping.count({ where: { companyId, locationId } });
    if (activeStores > 0 || mappings > 0) {
      throw new CommerceError(
        409,
        'location_in_use',
        'location',
        locationId,
        'location_in_use',
        'location.archived',
      );
    }
  }

  private objectId(value: string, objectType: string, reason: string): string {
    if (!isUuid(value)) {
      throw new CommerceError(404, reason, objectType, null, 'Not found');
    }
    return value.toLowerCase();
  }

  private context(ctx: RequestContext, actor: string) {
    return { companyId: ctx.companyId, actor, correlationId: ctx.correlationId };
  }

  private async audit(
    tx: TenantTransaction,
    ctx: RequestContext,
    meta: RequestMeta,
    action: string,
    objectType: string,
    objectId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.auditLog.record(tx, {
      companyId: ctx.companyId,
      actorType: 'user',
      actorId: requireActor(ctx),
      actorLabel: ctx.actorLabel,
      action,
      objectType,
      objectId,
      outcome: 'success',
      ip: meta.ip,
      userAgent: meta.userAgent,
      details,
    });
  }

  private async fail(ctx: RequestContext, meta: RequestMeta, error: unknown): Promise<never> {
    if (error instanceof CommerceError) {
      return settleCommerceError(this.auditLog, this.prisma, ctx, meta, error);
    }
    throw error;
  }
}

const locationSelect = {
  id: true,
  name: true,
  address: true,
  timezone: true,
  archivedAt: true,
} as const;

type LocationRow = {
  id: string;
  name: string;
  address: unknown;
  timezone: string | null;
  archivedAt: Date | null;
};

function toBrand(row: { id: string; name: string; archivedAt: Date | null }): BrandView {
  return { id: row.id, name: row.name, archivedAt: row.archivedAt?.toISOString() ?? null };
}

function toLocation(row: LocationRow): LocationView {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    timezone: row.timezone,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

function toStore(row: StoreRow): StoreView {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    brandId: row.brandId,
    locationId: row.locationId,
    domain: row.domain,
    invoiceAuthority: row.invoiceAuthority,
    status: row.status,
    brand: { id: row.brand.id, name: row.brand.name },
    location: { id: row.location.id, name: row.location.name },
    connections: row.connections.map((connection) => ({
      id: connection.id,
      mode: connection.mode,
      status: connection.status,
    })),
  };
}

function companyDiff(
  current: CompanyDetails,
  input: CompanyPatch,
): { data: Prisma.CompanyUpdateInput; fields: string[] } {
  const data: Prisma.CompanyUpdateInput = {};
  const fields: string[] = [];
  if (input.legalName !== undefined && input.legalName !== current.legalName) {
    data.legalName = input.legalName;
    fields.push('legalName');
  }
  if (input.tradingName !== undefined && input.tradingName !== current.tradingName) {
    data.tradingName = input.tradingName;
    fields.push('tradingName');
  }
  if (
    input.registrationNumber !== undefined &&
    input.registrationNumber !== current.registrationNumber
  ) {
    data.registrationNumber = input.registrationNumber;
    fields.push('registrationNumber');
  }
  if (input.vatNumber !== undefined && input.vatNumber !== current.vatNumber) {
    data.vatNumber = input.vatNumber;
    fields.push('vatNumber');
  }
  if (input.taxOffice !== undefined && input.taxOffice !== current.taxOffice) {
    data.taxOffice = input.taxOffice;
    fields.push('taxOffice');
  }
  if (input.address !== undefined && !sameJson(current.address, input.address)) {
    data.address = input.address;
    fields.push('address');
  }
  if (input.timezone !== undefined && input.timezone !== current.timezone) {
    data.timezone = input.timezone;
    fields.push('timezone');
  }
  if (input.defaultCurrency !== undefined && input.defaultCurrency !== current.defaultCurrency) {
    data.defaultCurrency = input.defaultCurrency;
    fields.push('defaultCurrency');
  }
  if (input.defaultLocale !== undefined && input.defaultLocale !== current.defaultLocale) {
    data.defaultLocale = input.defaultLocale;
    fields.push('defaultLocale');
  }
  if (input.documentLanguage !== undefined && input.documentLanguage !== current.documentLanguage) {
    data.documentLanguage = input.documentLanguage;
    fields.push('documentLanguage');
  }
  if (input.paymentTermsDays !== undefined && input.paymentTermsDays !== current.paymentTermsDays) {
    data.paymentTermsDays = input.paymentTermsDays;
    fields.push('paymentTermsDays');
  }
  return { data, fields };
}

function locationFields(current: LocationRow, input: LocationPatch): string[] {
  const fields: string[] = [];
  if (input.name !== undefined && input.name !== current.name) {
    fields.push('name');
  }
  if (input.address !== undefined && !sameJson(current.address, input.address)) {
    fields.push('address');
  }
  if (input.timezone !== undefined && input.timezone !== current.timezone) {
    fields.push('timezone');
  }
  return fields;
}

function storeFields(current: StoreRow, input: StorePatch): string[] {
  const fields: string[] = [];
  if (input.name !== undefined && input.name !== current.name) {
    fields.push('name');
  }
  if (input.brandId !== undefined && input.brandId.toLowerCase() !== current.brandId) {
    fields.push('brandId');
  }
  if (input.locationId !== undefined && input.locationId.toLowerCase() !== current.locationId) {
    fields.push('locationId');
  }
  if (input.domain !== undefined && input.domain !== current.domain) {
    fields.push('domain');
  }
  if (input.invoiceAuthority !== undefined && input.invoiceAuthority !== current.invoiceAuthority) {
    fields.push('invoiceAuthority');
  }
  return fields;
}

async function lockBrandName(
  tx: TenantTransaction,
  companyId: string,
  name: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${companyId} || ':' || lower(${name}), 0::bigint))
  `;
}

async function brandNameTaken(
  tx: TenantTransaction,
  companyId: string,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM brand
    WHERE company_id = ${companyId}::uuid
      AND archived_at IS NULL
      AND lower(name) = lower(${name})
  `;
  return rows.some((row) => row.id !== exceptId);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalJson(item));
  }
  if (typeof value === 'object' && value !== null) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = canonicalJson((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return value;
}
