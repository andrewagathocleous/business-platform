import { BadRequestException, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../authz/require-permission.decorator';
import { issueMessage, requireActor, requireContext, unknownBody } from '../commerce/http';
import { requestMeta } from '../identity/request-meta';
import {
  brandCreateSchema,
  brandPatchSchema,
  companyPatchSchema,
  locationCreateSchema,
  locationPatchSchema,
  storeCreateSchema,
  storePatchSchema,
} from './company-setup.schema';
import { CompanySetupService } from './company-setup.service';
import { storeListScope, storeResourceScope } from './store.scope';

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

@ApiTags('company')
@companyIdParam
@Controller('c/:companyId')
export class CompanySetupController {
  constructor(@Inject(CompanySetupService) private readonly setup: CompanySetupService) {}

  @Patch('company')
  @RequirePermission('company.manage')
  @ApiOperation({ summary: 'Update company details. expectedVersion must match.' })
  async updateCompany(@Req() req: Request, @Param('companyId') companyId: string) {
    const parsed = parse(companyPatchSchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { company: await this.setup.updateCompany(ctx, parsed, requestMeta(req)) };
  }

  @Get('brands')
  @RequirePermission('store.view')
  @ApiOperation({ summary: 'Brands in this company, including archived ones' })
  async brands(@Req() req: Request, @Param('companyId') companyId: string) {
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return this.setup.listBrands(ctx);
  }

  @Post('brands')
  @HttpCode(200)
  @RequirePermission('store.manage')
  @ApiOperation({ summary: 'Create a brand' })
  async createBrand(@Req() req: Request, @Param('companyId') companyId: string) {
    const parsed = parse(brandCreateSchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { brand: await this.setup.createBrand(ctx, parsed, requestMeta(req)) };
  }

  @Patch('brands/:id')
  @idParam
  @RequirePermission('store.manage')
  @ApiOperation({ summary: 'Rename, archive or restore a brand' })
  async updateBrand(@Req() req: Request, @Param('companyId') companyId: string, @Param('id') id: string) {
    const parsed = parse(brandPatchSchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { brand: await this.setup.updateBrand(ctx, id, parsed, requestMeta(req)) };
  }

  @Post('locations')
  @HttpCode(200)
  @RequirePermission('company.manage')
  @ApiOperation({ summary: 'Create a location' })
  async createLocation(@Req() req: Request, @Param('companyId') companyId: string) {
    const parsed = parse(locationCreateSchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { location: await this.setup.createLocation(ctx, parsed, requestMeta(req)) };
  }

  @Patch('locations/:id')
  @idParam
  @RequirePermission('company.manage')
  @ApiOperation({ summary: 'Edit, archive or restore a location' })
  async updateLocation(@Req() req: Request, @Param('companyId') companyId: string, @Param('id') id: string) {
    const parsed = parse(locationPatchSchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { location: await this.setup.updateLocation(ctx, id, parsed, requestMeta(req)) };
  }

  @Get('stores')
  @RequirePermission('store.view', { scope: storeListScope })
  @ApiOperation({ summary: 'Stores in this company. A store grant sees only those stores.' })
  async stores(@Req() req: Request, @Param('companyId') companyId: string) {
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return this.setup.listStores(ctx);
  }

  @Get('stores/:id')
  @idParam
  @RequirePermission('store.view', { scope: storeResourceScope })
  @ApiOperation({ summary: 'One store, with connection id, mode and status only' })
  async store(@Req() req: Request, @Param('companyId') companyId: string, @Param('id') id: string) {
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { store: await this.setup.getStore(ctx, id, requestMeta(req)) };
  }

  @Post('stores')
  @HttpCode(200)
  @RequirePermission('store.manage')
  @ApiOperation({ summary: 'Create a store. Platform is fixed after this.' })
  async createStore(@Req() req: Request, @Param('companyId') companyId: string) {
    const parsed = parse(storeCreateSchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { store: await this.setup.createStore(ctx, parsed, requestMeta(req)) };
  }

  @Patch('stores/:id')
  @idParam
  @RequirePermission('store.manage')
  @ApiOperation({ summary: 'Edit, archive or restore a store. Platform cannot change.' })
  async updateStore(@Req() req: Request, @Param('companyId') companyId: string, @Param('id') id: string) {
    const parsed = parse(storePatchSchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { store: await this.setup.updateStore(ctx, id, parsed, requestMeta(req)) };
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException(issueMessage(parsed.error));
  }
  return parsed.data;
}
