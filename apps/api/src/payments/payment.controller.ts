import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../authz/require-permission.decorator';
import { issueMessage, requireContext, unknownBody } from '../commerce/http';
import { requestMeta } from '../identity/request-meta';
import { PaymentService } from './payment.service';

const method = z.enum(['bank_transfer', 'card', 'cash', 'store', 'other']);
const textFields = {
  reference: z.string().max(200).optional(),
  notes: z.string().max(20_000).optional(),
};
const sourceFields = { paymentId: z.string().optional(), creditNoteId: z.string().optional() };
const oneSource = (body: { paymentId?: string; creditNoteId?: string }) =>
  (body.paymentId !== undefined) !== (body.creditNoteId !== undefined);
const recordBody = z
  .object({
    clientId: z.string(),
    receivedOn: z.string(),
    amount: z.unknown(),
    method,
    ...textFields,
  })
  .strict();
const allocationBody = z
  .object({ ...sourceFields, invoiceId: z.string(), amount: z.unknown() })
  .strict()
  .refine(oneSource, 'exactly one of paymentId or creditNoteId is required');
const refundBody = z
  .object({ ...sourceFields, amount: z.unknown(), refundedOn: z.string(), method, ...textFields })
  .strict()
  .refine(oneSource, 'exactly one of paymentId or creditNoteId is required');
const reason = z
  .string()
  .max(500)
  .refine((value) => /\S/.test(value), 'reason is required');
const reverseBody = z.object({ reason }).strict();
const voidBody = z.object({ expectedVersion: z.number().int().nonnegative(), reason }).strict();

function parse<T>(schema: z.ZodType<T>, req: Request): T {
  const parsed = schema.safeParse(unknownBody(req));
  if (!parsed.success) throw new BadRequestException(issueMessage(parsed.error));
  return parsed.data;
}

@ApiTags('payments')
@ApiParam({ name: 'companyId', required: true, schema: { type: 'string', format: 'uuid' } })
@Controller('c/:companyId')
export class PaymentController {
  constructor(@Inject(PaymentService) private readonly payments: PaymentService) {}

  @Post('payments')
  @HttpCode(200)
  @RequirePermission('payment.record')
  @ApiOperation({
    summary:
      'Record a payment already received. Recording never moves money. Requires Idempotency-Key.',
  })
  async record(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('companyId') companyId: string,
  ) {
    const result = await this.payments.record(
      requireContext(req, companyId),
      parse(recordBody, req),
      req.headers['idempotency-key'],
      requestMeta(req),
    );
    res.status(result.status);
    return result.body;
  }

  @Post('allocations')
  @HttpCode(200)
  @RequirePermission('payment.record')
  @ApiOperation({
    summary:
      'Record an allocation to an issued invoice. Recording never moves money. Requires Idempotency-Key.',
  })
  async allocate(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('companyId') companyId: string,
  ) {
    const result = await this.payments.allocate(
      requireContext(req, companyId),
      parse(allocationBody, req),
      req.headers['idempotency-key'],
      requestMeta(req),
    );
    res.status(result.status);
    return result.body;
  }

  @Post('allocations/:id/reverse')
  @HttpCode(200)
  @RequirePermission('payment.record')
  @ApiOperation({ summary: 'Reverse a recorded allocation today. Recording never moves money.' })
  async reverse(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    return this.payments.reverse(
      requireContext(req, companyId),
      id,
      parse(reverseBody, req),
      requestMeta(req),
    );
  }

  @Get('payments')
  @RequirePermission('invoice.view')
  @ApiOperation({
    summary:
      'List recorded payments, newest received first, optionally by clientId. Recording never moves money.',
  })
  async list(@Req() req: Request, @Param('companyId') companyId: string) {
    const clientId = req.query.clientId;
    if (clientId !== undefined && typeof clientId !== 'string')
      throw new BadRequestException('clientId is invalid');
    return {
      payments: await this.payments.list(
        requireContext(req, companyId),
        clientId,
        requestMeta(req),
      ),
    };
  }

  @Get('payments/:id')
  @RequirePermission('invoice.view')
  @ApiOperation({
    summary:
      'Read a payment with allocations, invoice numbers, refunds and remaining credit. Recording never moves money.',
  })
  async get(@Req() req: Request, @Param('companyId') companyId: string, @Param('id') id: string) {
    return {
      payment: await this.payments.get(requireContext(req, companyId), id, requestMeta(req)),
    };
  }

  @Get('clients/:id/account')
  @RequirePermission('invoice.view')
  @ApiOperation({ summary: 'Client open invoices and remaining payment and credit-note credit.' })
  async account(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    return this.payments.account(requireContext(req, companyId), id, requestMeta(req));
  }

  @Post('payments/:id/void')
  @HttpCode(200)
  @RequirePermission('payment.record')
  @ApiOperation({
    summary:
      'Void a payment and reverse its active allocations today. Recording never moves money.',
  })
  async voidPayment(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    return this.payments.voidPayment(
      requireContext(req, companyId),
      id,
      parse(voidBody, req),
      requestMeta(req),
    );
  }

  @Post('refunds')
  @HttpCode(200)
  @RequirePermission('payment.record')
  @ApiOperation({
    summary:
      'Record money already paid back. Recording never moves money or instructs a bank. Requires Idempotency-Key.',
  })
  async refund(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('companyId') companyId: string,
  ) {
    const result = await this.payments.refund(
      requireContext(req, companyId),
      parse(refundBody, req),
      req.headers['idempotency-key'],
      requestMeta(req),
    );
    res.status(result.status);
    return result.body;
  }

  @Post('refunds/:id/void')
  @HttpCode(200)
  @RequirePermission('payment.record')
  @ApiOperation({ summary: 'Void a recorded refund today. Recording never moves money.' })
  async voidRefund(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    return this.payments.voidRefund(
      requireContext(req, companyId),
      id,
      parse(voidBody, req),
      requestMeta(req),
    );
  }
}
