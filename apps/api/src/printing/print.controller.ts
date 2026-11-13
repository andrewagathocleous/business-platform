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
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../authz/require-permission.decorator';
import { issueMessage, queryRecord, requireContext, unknownBody } from '../commerce/http';
import { requestMeta } from '../identity/request-meta';
import { isUuid } from '../authz/company-path';
import { PrintService, type PrintJobStatusName, type PrintRequestInput } from './print.service';
import {
  printJobReadAnyOf,
  printJobScope,
  printListScope,
  printRequestScope,
  printerListScope,
} from './print.scope';

const DOCUMENT_TYPES = ['invoice', 'packing_slip', 'gift_message', 'shipping_label'] as const;
const PRINT_STATUSES = [
  'queued',
  'held',
  'submitting',
  'submitted',
  'delivered_to_printer',
  'done_reported',
  'confirmed_printed',
  'not_printed',
  'failed',
  'uncertain',
  'cancelled',
] as const;

const requestBody = z
  .object({
    documentType: z.enum(DOCUMENT_TYPES),
    sourceType: z.enum(['order', 'invoice']),
    sourceId: z.uuid(),
    copies: z.number().int().min(1).max(5).optional(),
    printerId: z.uuid().optional(),
    locationId: z.uuid().optional(),
    requestKey: z.uuid().optional(),
    reprint: z
      .object({
        ofPrintJobId: z.uuid(),
        reason: z.string().min(5).max(500),
      })
      .strict()
      .optional(),
  })
  .strict();

const confirmBody = z
  .object({
    outcome: z.enum(['printed', 'not_printed']),
  })
  .strict();

const discoverBody = z
  .object({
    locationId: z.uuid().optional(),
    provider: z.enum(['mock', 'printnode']).optional(),
  })
  .strict();

const mappingBody = z
  .object({
    locationId: z.uuid(),
    documentType: z.enum(DOCUMENT_TYPES),
    printerId: z.uuid(),
    paperSize: z.string().min(1).max(32),
    copies: z.number().int().min(1).max(5).optional(),
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

@ApiTags('printing')
@companyIdParam
@Controller('c/:companyId')
export class PrintController {
  constructor(@Inject(PrintService) private readonly printing: PrintService) {}

  @Post('print-requests')
  @HttpCode(200)
  @RequirePermission('print.submit', { anyOf: ['print.reprint'], scope: printRequestScope })
  @ApiOperation({
    summary:
      'Queue a packing slip or gift message (rendered now), or an issued invoice (its stored PDF; two copies by default for paper delivery). A second first print is 409 already_printed. The provider follows the mapped printer (mock in development and test only, otherwise printnode).',
  })
  async request(@Req() req: Request, @Param('companyId') companyId: string) {
    const parsed = requestBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    const input: PrintRequestInput = {
      documentType: parsed.data.documentType,
      sourceType: parsed.data.sourceType,
      sourceId: parsed.data.sourceId,
      ...(parsed.data.copies !== undefined ? { copies: parsed.data.copies } : {}),
      ...(parsed.data.printerId !== undefined ? { printerId: parsed.data.printerId } : {}),
      ...(parsed.data.locationId !== undefined ? { locationId: parsed.data.locationId } : {}),
      ...(parsed.data.requestKey !== undefined ? { requestKey: parsed.data.requestKey } : {}),
      ...(parsed.data.reprint !== undefined ? { reprint: parsed.data.reprint } : {}),
    };
    return this.printing.request(requireContext(req, companyId), input, requestMeta(req));
  }

  @Get('print-jobs')
  @RequirePermission('print.submit', { anyOf: ['automation.view'], scope: printListScope })
  @ApiOperation({ summary: 'List print jobs. done_reported is not shown as printed.' })
  async list(@Req() req: Request, @Param('companyId') companyId: string) {
    return this.printing.list(requireContext(req, companyId), printQuery(req), requestMeta(req));
  }

  @Get('print-jobs/:id')
  @idParam
  @RequirePermission('print.submit', { anyOf: printJobReadAnyOf, scope: printJobScope })
  @ApiOperation({
    summary:
      'One print job. print.submit, print.reprint, print.confirm or automation.view, at the job scope. The status stays the provider value, including done_reported.',
  })
  async get(@Req() req: Request, @Param('companyId') companyId: string, @Param('id') id: string) {
    return this.printing.get(requireContext(req, companyId), id, requestMeta(req));
  }

  @Post('print-jobs/:id/confirm')
  @HttpCode(200)
  @idParam
  @RequirePermission('print.confirm', { scope: printJobScope })
  @ApiOperation({
    summary: 'Staff confirm printed or not_printed. not_printed allows another first print.',
  })
  async confirm(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    const parsed = confirmBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    return this.printing.confirm(
      requireContext(req, companyId),
      id,
      parsed.data.outcome,
      requestMeta(req),
    );
  }

  @Post('print-jobs/:id/release')
  @HttpCode(200)
  @idParam
  @RequirePermission('automation.replay', { scope: printJobScope })
  @ApiOperation({
    summary: 'Release a held print job back to the queue after printing is enabled.',
  })
  async release(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    return this.printing.release(requireContext(req, companyId), id, requestMeta(req));
  }

  @Post('print-jobs/:id/cancel')
  @HttpCode(200)
  @idParam
  @RequirePermission('print.submit', { scope: printJobScope })
  @ApiOperation({
    summary: 'Cancel a queued, held or uncertain job. 409 once it is submitting or later.',
  })
  async cancel(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    return this.printing.cancel(requireContext(req, companyId), id, requestMeta(req));
  }

  @Get('printers')
  @RequirePermission('print.submit', { anyOf: ['printer.manage'], scope: printerListScope })
  @ApiOperation({
    summary: 'Printers visible to the caller. Mock printers are labelled simulated.',
  })
  async printers(@Req() req: Request, @Param('companyId') companyId: string) {
    return this.printing.printers(requireContext(req, companyId), requestMeta(req));
  }

  @Post('printers/discover')
  @HttpCode(200)
  @RequirePermission('printer.manage')
  @ApiOperation({
    summary:
      'Upsert printers from the selected provider. PrintNode when a key is stored, otherwise the simulated mock catalogue. Simulated — no physical printing.',
  })
  async discover(@Req() req: Request, @Param('companyId') companyId: string) {
    const body = unknownBody(req);
    const parsed = discoverBody.safeParse(body === undefined || body === null ? {} : body);
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    return this.printing.discover(
      requireContext(req, companyId),
      parsed.data.locationId,
      parsed.data.provider,
      requestMeta(req),
    );
  }

  @Get('printer-mappings')
  @RequirePermission('printer.manage')
  @ApiOperation({ summary: 'Printer mappings for this company' })
  async mappings(@Req() req: Request, @Param('companyId') companyId: string) {
    return this.printing.listMappings(requireContext(req, companyId), requestMeta(req));
  }

  @Put('printer-mappings')
  @RequirePermission('printer.manage')
  @ApiOperation({
    summary: 'Map a document type at a location to a printer, paper size and copies.',
  })
  async mapping(@Req() req: Request, @Param('companyId') companyId: string) {
    const parsed = mappingBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    return this.printing.putMapping(
      requireContext(req, companyId),
      {
        locationId: parsed.data.locationId,
        documentType: parsed.data.documentType,
        printerId: parsed.data.printerId,
        paperSize: parsed.data.paperSize,
        ...(parsed.data.copies !== undefined ? { copies: parsed.data.copies } : {}),
      },
      requestMeta(req),
    );
  }
}

function printQuery(req: Request): {
  status?: PrintJobStatusName;
  sourceId?: string;
  page: number;
  pageSize: number;
} {
  const query = queryRecord(req);
  const statusRaw = query['status'];
  if (statusRaw !== undefined && (typeof statusRaw !== 'string' || !isStatus(statusRaw))) {
    throw new BadRequestException('status is not a print job status');
  }
  const sourceRaw = query['sourceId'];
  if (sourceRaw !== undefined && (typeof sourceRaw !== 'string' || !isUuid(sourceRaw))) {
    throw new BadRequestException('sourceId must be a uuid');
  }
  return {
    ...(typeof statusRaw === 'string' && isStatus(statusRaw) ? { status: statusRaw } : {}),
    ...(typeof sourceRaw === 'string' ? { sourceId: sourceRaw.toLowerCase() } : {}),
    page: integer(query['page'], 'page', 1, 1_000_000, 1),
    pageSize: integer(query['pageSize'], 'pageSize', 1, 100, 50),
  };
}

function isStatus(value: string): value is PrintJobStatusName {
  return (PRINT_STATUSES as readonly string[]).includes(value);
}

function integer(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new BadRequestException(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new BadRequestException(`${name} is out of range`);
  }
  return parsed;
}
