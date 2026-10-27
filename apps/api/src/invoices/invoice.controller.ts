import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { isUuid } from '../authz/company-path';
import { RequirePermission } from '../authz/require-permission.decorator';
import { issueMessage, queryRecord, requireContext, unknownBody } from '../commerce/http';
import { requestMeta } from '../identity/request-meta';
import { InvoiceService, type InvoiceQuery } from './invoice.service';

const lineSchema = z.object({
  position: z.number().int().positive(),
  kind: z.enum(['item', 'shipping']).optional(),
  productId: z.string().nullable().optional(),
  description: z.string().min(1).max(2000),
  quantity: z.unknown(),
  unit: z.string().min(1).max(40),
  unitPrice: z.unknown(),
  discountPercent: z.unknown().optional(),
  taxCodeId: z.string(),
});

const invoiceFields = {
  documentType: z.enum(['quote', 'invoice']).optional(),
  clientId: z.string(),
  pricesIncludeTax: z.boolean(),
  issueDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  supplyDate: z.string().nullable().optional(),
  reference: z.string().max(200).nullable().optional(),
  notes: z.string().max(20_000).nullable().optional(),
  terms: z.string().max(20_000).nullable().optional(),
  lines: z.array(lineSchema).min(1).max(200),
};

const invoiceCreate = z.object(invoiceFields);
const invoicePreview = z.object({
  pricesIncludeTax: z.boolean(),
  lines: z.array(lineSchema).min(1).max(200),
});
const invoicePatch = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    documentType: invoiceFields.documentType,
    clientId: invoiceFields.clientId.optional(),
    pricesIncludeTax: invoiceFields.pricesIncludeTax.optional(),
    issueDate: invoiceFields.issueDate,
    dueDate: invoiceFields.dueDate,
    supplyDate: invoiceFields.supplyDate,
    reference: invoiceFields.reference,
    notes: invoiceFields.notes,
    terms: invoiceFields.terms,
    lines: invoiceFields.lines.optional(),
  })
  .refine((body) => Object.keys(body).some((key) => key !== 'expectedVersion'), {
    message: 'no changes',
  });

const invoiceIssue = z.object({ expectedVersion: z.number().int().nonnegative() }).strict();

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

@ApiTags('invoices')
@companyIdParam
@Controller('c/:companyId/invoices')
export class InvoiceController {
  constructor(@Inject(InvoiceService) private readonly invoices: InvoiceService) {}

  @Post('preview-totals')
  @HttpCode(200)
  @RequirePermission('invoice.draft')
  @ApiOperation({
    summary: 'Calculate totals for lines. Nothing is stored. Client totals are ignored.',
  })
  async preview(@Req() req: Request, @Param('companyId') companyId: string) {
    const parsed = invoicePreview.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    const totals = await this.invoices.preview(
      requireContext(req, companyId),
      parsed.data,
      requestMeta(req),
    );
    return { totals };
  }

  @Post()
  @HttpCode(200)
  @RequirePermission('invoice.draft')
  @ApiOperation({
    summary: 'Create a draft invoice or quote. Totals are calculated on the server.',
  })
  async create(@Req() req: Request, @Param('companyId') companyId: string) {
    const parsed = invoiceCreate.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    const invoice = await this.invoices.create(
      requireContext(req, companyId),
      parsed.data,
      requestMeta(req),
    );
    return { invoice };
  }

  @Get()
  @RequirePermission('invoice.view')
  @ApiOperation({ summary: 'List invoices. Filters: status, clientId, from, to, q.' })
  async list(@Req() req: Request, @Param('companyId') companyId: string) {
    const invoices = await this.invoices.list(
      requireContext(req, companyId),
      parseInvoiceQuery(queryRecord(req)),
      requestMeta(req),
    );
    return { invoices };
  }

  @Get(':id/pdf')
  @idParam
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @RequirePermission('invoice.view')
  @ApiOperation({
    summary:
      'The PDF. An issued document returns its stored, verified file; a draft is rendered with a watermark and not stored.',
  })
  async pdf(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ): Promise<StreamableFile> {
    const file = await this.invoices.pdf(requireContext(req, companyId), id, requestMeta(req));
    const disposition = `inline; filename="${file.fileName}"`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', disposition);
    return new StreamableFile(file.bytes, {
      type: 'application/pdf',
      disposition,
      length: file.bytes.length,
    });
  }

  @Get(':id')
  @idParam
  @RequirePermission('invoice.view')
  @ApiOperation({ summary: 'One invoice, with lines and the tax summary' })
  async get(@Req() req: Request, @Param('companyId') companyId: string, @Param('id') id: string) {
    const invoice = await this.invoices.get(requireContext(req, companyId), id, requestMeta(req));
    return { invoice };
  }

  @Post(':id/issue')
  @HttpCode(200)
  @idParam
  @RequirePermission('invoice.issue')
  @ApiOperation({
    summary:
      'Issue a draft invoice: number, frozen snapshot and stored PDF, in one transaction. Needs outbound.all and invoice.issue_real on. 409 issuance_disabled when either is off; 422 invoice_incomplete lists the missing fields.',
  })
  async issue(@Req() req: Request, @Param('companyId') companyId: string, @Param('id') id: string) {
    const parsed = invoiceIssue.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    return this.invoices.issue(requireContext(req, companyId), id, parsed.data, requestMeta(req));
  }

  @Patch(':id')
  @idParam
  @RequirePermission('invoice.draft')
  @ApiOperation({
    summary: 'Edit a draft. expectedVersion must match. A mismatch is 409.',
  })
  async update(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    const parsed = invoicePatch.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    const invoice = await this.invoices.update(
      requireContext(req, companyId),
      id,
      parsed.data,
      requestMeta(req),
    );
    return { invoice };
  }
}

function parseInvoiceQuery(query: Record<string, unknown>): InvoiceQuery {
  const status = query.status;
  if (status !== undefined && status !== 'draft' && status !== 'issued' && status !== 'cancelled') {
    throw new BadRequestException('status is invalid');
  }
  const clientId = query.clientId;
  if (clientId !== undefined && (typeof clientId !== 'string' || !isUuid(clientId))) {
    throw new BadRequestException('clientId is invalid');
  }
  const from = optionalDate(query.from, 'from');
  const to = optionalDate(query.to, 'to');
  const q = query.q;
  if (q !== undefined && (typeof q !== 'string' || q.length === 0 || q.length > 200)) {
    throw new BadRequestException('q is invalid');
  }
  return {
    status,
    clientId: typeof clientId === 'string' ? clientId : undefined,
    from,
    to,
    q,
  };
}

function optionalDate(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return value;
}
