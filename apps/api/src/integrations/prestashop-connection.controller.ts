import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { RequirePermission } from '../authz/require-permission.decorator';
import { issueMessage, requireActor, requireContext, unknownBody } from '../commerce/http';
import { requestMeta } from '../identity/request-meta';
import { connectionMapsSchema, connectionPutSchema, emptyBodySchema } from './prestashop-connection.schema';
import { PrestashopConnectionService } from './prestashop-connection.service';

const companyIdParam = ApiParam({
  name: 'companyId',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});
const storeIdParam = ApiParam({
  name: 'storeId',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});

@ApiTags('integrations')
@companyIdParam
@storeIdParam
@Controller('c/:companyId/stores/:storeId/prestashop-connection')
export class PrestashopConnectionController {
  constructor(@Inject(PrestashopConnectionService) private readonly connections: PrestashopConnectionService) {}

  @Get()
  @RequirePermission('integration.view')
  @ApiOperation({ summary: 'The live PrestaShop connection for this store, or null' })
  async get(@Req() req: Request, @Param('companyId') companyId: string, @Param('storeId') storeId: string) {
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { connection: await this.connections.get(ctx, storeId, requestMeta(req)) };
  }

  @Put()
  @RequirePermission('integration.manage')
  @ApiOperation({ summary: 'Create or update the live PrestaShop connection' })
  async save(@Req() req: Request, @Param('companyId') companyId: string, @Param('storeId') storeId: string) {
    const parsed = parse(connectionPutSchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { connection: await this.connections.save(ctx, storeId, parsed, requestMeta(req)) };
  }

  @Post('test')
  @HttpCode(200)
  @RequirePermission('integration.manage')
  @ApiOperation({ summary: 'Probe the saved shop with the saved key' })
  async test(@Req() req: Request, @Param('companyId') companyId: string, @Param('storeId') storeId: string) {
    parse(emptyBodySchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return this.connections.test(ctx, storeId, requestMeta(req));
  }

  @Get('order-states')
  @RequirePermission('integration.manage')
  @ApiOperation({ summary: 'Order states from the saved shop' })
  async orderStates(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('companyId') companyId: string,
    @Param('storeId') storeId: string,
  ) {
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    const outcome = await this.connections.orderStates(ctx, storeId, requestMeta(req));
    if (!outcome.ok) {
      res.status(502);
      return { errorClass: outcome.errorClass };
    }
    return outcome.states;
  }

  @Get('carriers')
  @RequirePermission('integration.manage')
  @ApiOperation({ summary: 'Carriers from the saved shop, one row per id_reference' })
  async carriers(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('companyId') companyId: string,
    @Param('storeId') storeId: string,
  ) {
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    const outcome = await this.connections.carriers(ctx, storeId, requestMeta(req));
    if (!outcome.ok) {
      res.status(502);
      return { errorClass: outcome.errorClass };
    }
    return outcome.carriers;
  }

  @Put('maps')
  @RequirePermission('integration.manage')
  @ApiOperation({ summary: 'Save the order-state and carrier maps' })
  async maps(@Req() req: Request, @Param('companyId') companyId: string, @Param('storeId') storeId: string) {
    const parsed = parse(connectionMapsSchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { connection: await this.connections.saveMaps(ctx, storeId, parsed, requestMeta(req)) };
  }

  @Post('activate')
  @HttpCode(200)
  @RequirePermission('integration.manage')
  @ApiOperation({ summary: 'Start sync after a passed test' })
  async activate(@Req() req: Request, @Param('companyId') companyId: string, @Param('storeId') storeId: string) {
    parse(emptyBodySchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { connection: await this.connections.activate(ctx, storeId, requestMeta(req)) };
  }

  @Post('pause')
  @HttpCode(200)
  @RequirePermission('integration.manage')
  @ApiOperation({ summary: 'Pause sync' })
  async pause(@Req() req: Request, @Param('companyId') companyId: string, @Param('storeId') storeId: string) {
    parse(emptyBodySchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { connection: await this.connections.pause(ctx, storeId, requestMeta(req)) };
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body === undefined ? {} : body);
  if (!parsed.success) {
    throw new BadRequestException(issueMessage(parsed.error));
  }
  return parsed.data;
}
