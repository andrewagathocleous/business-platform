import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../authz/require-permission.decorator';
import { CommerceError } from '../commerce/errors';
import { decimalField } from '../commerce/format';
import { issueMessage, queryRecord, requireContext, unknownBody } from '../commerce/http';
import { requestMeta } from '../identity/request-meta';
import { CatalogService, type ProductQuery } from './catalog.service';

const productFields = {
  sku: z.string().min(1).max(80).nullable().optional(),
  name: z.string().min(1).max(300),
  description: z.string().max(4000).nullable().optional(),
  kind: z.enum(['product', 'service', 'shipping']),
  unit: z.string().min(1).max(40),
  unitPrice: z.unknown(),
  pricesIncludeTax: z.boolean(),
  taxCodeId: z.string(),
  active: z.boolean().optional(),
};

const productCreate = z.strictObject(productFields);
const productPatch = z
  .strictObject({
    sku: productFields.sku,
    name: productFields.name.optional(),
    description: productFields.description,
    kind: productFields.kind.optional(),
    unit: productFields.unit.optional(),
    unitPrice: z.unknown().optional(),
    pricesIncludeTax: productFields.pricesIncludeTax.optional(),
    taxCodeId: productFields.taxCodeId.optional(),
    active: productFields.active,
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'no changes' });

const companyIdParam = ApiParam({
  name: 'companyId',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});
const idParam = ApiParam({
  name: 'id',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});

@ApiTags('catalog')
@companyIdParam
@Controller('c/:companyId')
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get('products')
  @RequirePermission('catalog.view')
  @ApiOperation({ summary: 'List products and services' })
  async products(@Req() req: Request, @Param('companyId') companyId: string) {
    return {
      products: await this.catalog.products(
        requireContext(req, companyId),
        parseProductQuery(queryRecord(req)),
      ),
    };
  }

  @Post('products')
  @HttpCode(200)
  @RequirePermission('catalog.manage')
  @ApiOperation({ summary: 'Create a product, service or shipping item' })
  async createProduct(@Req() req: Request, @Param('companyId') companyId: string) {
    const parsed = productCreate.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    const product = await this.catalog.createProduct(
      requireContext(req, companyId),
      { ...parsed.data, unitPrice: money(parsed.data.unitPrice) },
      requestMeta(req),
    );
    return { product };
  }

  @Patch('products/:id')
  @idParam
  @RequirePermission('catalog.manage')
  @ApiOperation({ summary: 'Edit a product. Products have no version column.' })
  async updateProduct(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    const parsed = productPatch.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    const product = await this.catalog.updateProduct(
      requireContext(req, companyId),
      id,
      {
        ...parsed.data,
        unitPrice: parsed.data.unitPrice === undefined ? undefined : money(parsed.data.unitPrice),
      },
      requestMeta(req),
    );
    return { product };
  }
}

function money(value: unknown): string {
  try {
    return decimalField(value, 4, 'unitPrice');
  } catch (error) {
    if (error instanceof CommerceError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}

function parseProductQuery(query: Record<string, unknown>): ProductQuery {
  const active = query.active;
  if (active !== undefined && active !== 'true' && active !== 'false') {
    throw new BadRequestException('active is invalid');
  }
  const q = query.q;
  if (q !== undefined && (typeof q !== 'string' || q.length === 0 || q.length > 200)) {
    throw new BadRequestException('q is invalid');
  }
  return { q, active: active === undefined ? undefined : active === 'true' };
}
