import { Inject, Injectable } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { AuditService } from '../audit/audit.service';
import { isUuid } from '../authz/company-path';
import type { RequestContext } from '../authz/request-context';
import { CommerceError, settleCommerceError } from '../commerce/errors';
import { fixed } from '../commerce/format';
import { requireActor } from '../commerce/http';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';

export type ProductWrite = {
  sku?: string | null;
  name: string;
  description?: string | null;
  kind: 'product' | 'service' | 'shipping';
  unit: string;
  unitPrice: string;
  pricesIncludeTax: boolean;
  taxCodeId: string;
  active?: boolean;
};

export type ProductPatch = Partial<ProductWrite>;

export type ProductQuery = {
  q?: string;
  active?: boolean;
};

export type ProductView = {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  kind: 'product' | 'service' | 'shipping';
  unit: string;
  unitPrice: string;
  pricesIncludeTax: boolean;
  taxCodeId: string;
  taxCode: string;
  active: boolean;
};

const productInclude = { taxCode: true } as const;

type ProductRow = {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  kind: 'product' | 'service' | 'shipping';
  unit: string;
  unitPrice: { toFixed(digits: number): string };
  pricesIncludeTax: boolean;
  taxCodeId: string;
  active: boolean;
  taxCode: { code: string };
};

@Injectable()
export class CatalogService {
  private readonly tenants: TenantDb;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.tenants = new TenantDb(prisma.client);
  }

  async products(ctx: RequestContext, query: ProductQuery): Promise<ProductView[]> {
    const actor = requireActor(ctx);
    const rows = await this.tenants.run(this.context(ctx, actor), (tx) =>
      tx.product.findMany({
        where: {
          companyId: ctx.companyId,
          ...(query.active === undefined ? {} : { active: query.active }),
          ...(query.q
            ? {
                OR: [
                  { name: { contains: query.q, mode: 'insensitive' } },
                  { sku: { contains: query.q, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        include: productInclude,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    );
    return rows.map((row) => toProduct(row));
  }

  async createProduct(
    ctx: RequestContext,
    input: ProductWrite,
    meta: RequestMeta,
  ): Promise<ProductView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        await this.requireTaxCode(tx, ctx.companyId, input.taxCodeId);
        const created = await tx.product.create({
          data: {
            companyId: ctx.companyId,
            sku: input.sku ?? null,
            name: input.name,
            description: input.description ?? null,
            kind: input.kind,
            unit: input.unit,
            unitPrice: input.unitPrice,
            pricesIncludeTax: input.pricesIncludeTax,
            taxCodeId: input.taxCodeId.toLowerCase(),
            active: input.active ?? true,
          },
          include: productInclude,
        });
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'product.created',
          objectType: 'product',
          objectId: created.id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: { sku: created.sku },
        });
        return toProduct(created);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async updateProduct(
    ctx: RequestContext,
    productId: string,
    patch: ProductPatch,
    meta: RequestMeta,
  ): Promise<ProductView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const current = await this.load(tx, ctx.companyId, productId);
        if (patch.taxCodeId !== undefined) {
          await this.requireTaxCode(tx, ctx.companyId, patch.taxCodeId);
        }
        const saved = await tx.product.update({
          where: { id: current.id },
          data: {
            sku: patch.sku === undefined ? undefined : patch.sku,
            name: patch.name,
            description: patch.description === undefined ? undefined : patch.description,
            kind: patch.kind,
            unit: patch.unit,
            unitPrice: patch.unitPrice,
            pricesIncludeTax: patch.pricesIncludeTax,
            taxCodeId: patch.taxCodeId?.toLowerCase(),
            active: patch.active,
          },
          include: productInclude,
        });
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'product.updated',
          objectType: 'product',
          objectId: saved.id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: { active: saved.active },
        });
        return toProduct(saved);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  private context(ctx: RequestContext, actor: string) {
    return { companyId: ctx.companyId, actor, correlationId: ctx.correlationId };
  }

  private async load(
    tx: TenantTransaction,
    companyId: string,
    productId: string,
  ): Promise<{ id: string }> {
    if (!isUuid(productId)) {
      throw new CommerceError(404, 'product_not_found', 'product', null, 'Not found');
    }
    const row = await tx.product.findFirst({
      where: { id: productId.toLowerCase(), companyId },
      select: { id: true },
    });
    if (!row) {
      throw new CommerceError(
        404,
        'product_not_found',
        'product',
        productId.toLowerCase(),
        'Not found',
      );
    }
    return row;
  }

  private async requireTaxCode(
    tx: TenantTransaction,
    companyId: string,
    taxCodeId: string,
  ): Promise<void> {
    if (!isUuid(taxCodeId)) {
      throw new CommerceError(400, 'invalid_tax_code', 'tax_code', null, 'taxCodeId is invalid');
    }
    const row = await tx.taxCode.findFirst({
      where: { id: taxCodeId.toLowerCase(), companyId },
      select: { id: true, active: true },
    });
    if (!row) {
      throw new CommerceError(
        404,
        'tax_code_not_found',
        'tax_code',
        taxCodeId.toLowerCase(),
        'Not found',
      );
    }
    if (!row.active) {
      throw new CommerceError(
        400,
        'tax_code_inactive',
        'tax_code',
        row.id,
        'tax code is not active',
      );
    }
  }

  private fail(ctx: RequestContext, meta: RequestMeta, error: unknown): Promise<never> {
    if (error instanceof CommerceError) {
      return settleCommerceError(this.audit, this.prisma, ctx, meta, error);
    }
    throw error;
  }
}

function toProduct(row: ProductRow): ProductView {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    kind: row.kind,
    unit: row.unit,
    unitPrice: fixed(row.unitPrice, 4),
    pricesIncludeTax: row.pricesIncludeTax,
    taxCodeId: row.taxCodeId,
    taxCode: row.taxCode.code,
    active: row.active,
  };
}
