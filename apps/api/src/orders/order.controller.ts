import { BadRequestException, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { FULFILMENT_STATUSES } from '@bp/domain';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../authz/require-permission.decorator';
import { issueMessage, requireContext, unknownBody } from '../commerce/http';
import { requestMeta } from '../identity/request-meta';
import { parseOrderListQuery } from './order.query';
import { orderListScope, orderResourceScope } from './order.scope';
import { OrderService, type OrderActivityEvent } from './order.service';

const transitionBody = z
  .object({
    to: z.enum(FULFILMENT_STATUSES),
    expectedVersion: z.number().int().nonnegative(),
    reason: z.string().max(500).optional(),
  })
  .strict();

const noteBody = z
  .object({
    body: z.string().min(1).max(4000),
  })
  .strict();

const assignBody = z
  .object({
    userId: z.uuid().nullable(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

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

@ApiTags('orders')
@companyIdParam
@Controller('c/:companyId/orders')
export class OrderController {
  constructor(@Inject(OrderService) private readonly orders: OrderService) {}

  @Get()
  @RequirePermission('order.view', { scope: orderListScope })
  @ApiOperation({
    summary:
      'List orders in scope. Filters: q, fulfilmentStatus, paymentStatus, storeId, assigned, from, to. Sort and page.',
  })
  async list(@Req() req: Request, @Param('companyId') companyId: string) {
    return this.orders.list(requireContext(req, companyId), parseOrderListQuery(req.query), requestMeta(req));
  }

  @Get(':id')
  @idParam
  @RequirePermission('order.view', { scope: orderResourceScope })
  @ApiOperation({ summary: 'Order detail, including the exact gift message and allowed transitions' })
  async detail(@Req() req: Request, @Param('companyId') companyId: string, @Param('id') id: string) {
    return this.orders.detail(requireContext(req, companyId), id, requestMeta(req));
  }

  @Get(':id/activity')
  @idParam
  @RequirePermission('order.view', { scope: orderResourceScope })
  @ApiOperation({ summary: 'Audit events for this order and its print jobs, newest first' })
  async activity(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ): Promise<{ events: OrderActivityEvent[] }> {
    return this.orders.activity(requireContext(req, companyId), id, requestMeta(req));
  }

  @Post(':id/transitions')
  @idParam
  @HttpCode(200)
  @RequirePermission('order.transition', { scope: orderResourceScope })
  @ApiOperation({ summary: 'Move an order. Cancel also requires order.cancel. Version conflicts are 409.' })
  async transition(@Req() req: Request, @Param('companyId') companyId: string, @Param('id') id: string) {
    const parsed = transitionBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    const input = {
      to: parsed.data.to,
      expectedVersion: parsed.data.expectedVersion,
      ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
    };
    return this.orders.transition(requireContext(req, companyId), id, input, requestMeta(req));
  }

  @Post(':id/notes')
  @idParam
  @HttpCode(200)
  @RequirePermission('order.edit', { scope: orderResourceScope })
  @ApiOperation({ summary: 'Add an order note. The body is stored exactly.' })
  async note(@Req() req: Request, @Param('companyId') companyId: string, @Param('id') id: string) {
    const parsed = noteBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    return this.orders.addNote(requireContext(req, companyId), id, parsed.data, requestMeta(req));
  }

  @Post(':id/assign')
  @idParam
  @HttpCode(200)
  @RequirePermission('order.assign', { scope: orderResourceScope, anyOf: ['order.claim'] })
  @ApiOperation({
    summary:
      'Assign the order. Someone else, or clearing the assignee, needs order.assign. Assigning yourself needs order.claim or order.assign.',
  })
  async assign(@Req() req: Request, @Param('companyId') companyId: string, @Param('id') id: string) {
    const parsed = assignBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    return this.orders.assign(requireContext(req, companyId), id, parsed.data, requestMeta(req));
  }
}
