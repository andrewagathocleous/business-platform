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
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../authz/require-permission.decorator';
import { isUuid } from '../authz/company-path';
import { issueMessage, queryRecord, requireContext, unknownBody } from '../commerce/http';
import { requestMeta } from '../identity/request-meta';
import { orderResourceScope } from '../orders/order.scope';
import { DocumentService, type TemplatePatch } from './document.service';
import { fileResourceScope } from './file.scope';

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

const previewBody = z.object({ text: z.string().min(1).max(2000) }).strict();

const templatePatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    pageWidthMm: z.unknown().optional(),
    pageHeightMm: z.unknown().optional(),
    marginTopMm: z.unknown().optional(),
    marginRightMm: z.unknown().optional(),
    marginBottomMm: z.unknown().optional(),
    marginLeftMm: z.unknown().optional(),
    fontSizePt: z.unknown().optional(),
    minFontSizePt: z.unknown().optional(),
    lineHeight: z.unknown().optional(),
    align: z.enum(['left', 'center']).optional(),
    verticalAlign: z.enum(['top', 'middle']).optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

@ApiTags('documents')
@companyIdParam
@Controller('c/:companyId')
export class DocumentController {
  constructor(@Inject(DocumentService) private readonly documents: DocumentService) {}

  @Get('orders/:id/documents/packing-slip.pdf')
  @idParam
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @RequirePermission('document.download', { scope: orderResourceScope })
  @ApiOperation({ summary: 'Preview a packing slip. The PDF is not stored.' })
  async packingSlip(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ): Promise<StreamableFile> {
    const bytes = await this.documents.packingSlip(
      requireContext(req, companyId),
      id,
      requestMeta(req),
    );
    return pdfFile(res, bytes, 'packing-slip.pdf');
  }

  @Get('orders/:id/documents/gift-message.pdf')
  @idParam
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @RequirePermission('document.download', { scope: orderResourceScope })
  @ApiQuery({ name: 'templateId', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({
    summary:
      'Preview a gift message. The PDF is not stored. Uses the default template when templateId is omitted.',
  })
  async giftMessage(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ): Promise<StreamableFile> {
    const bytes = await this.documents.giftMessage(
      requireContext(req, companyId),
      id,
      templateIdOf(queryRecord(req)),
      requestMeta(req),
    );
    return pdfFile(res, bytes, 'gift-message.pdf');
  }

  @Get('gift-message-templates')
  @RequirePermission('company.manage')
  @ApiOperation({ summary: 'Gift-message card templates for this company' })
  async listTemplates(@Req() req: Request, @Param('companyId') companyId: string) {
    return this.documents.listTemplates(requireContext(req, companyId));
  }

  @Post('gift-message-templates/:id/preview')
  @idParam
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @RequirePermission('company.manage')
  @ApiOperation({
    summary:
      'Render sample text with a saved template. Returns the PDF; X-Gift-Fits says whether it fit at or above the minimum font size.',
  })
  async previewTemplate(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    const parsed = previewBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    const rendered = await this.documents.previewTemplate(
      requireContext(req, companyId),
      id,
      parsed.data.text,
      requestMeta(req),
    );
    res.setHeader('X-Gift-Fits', rendered.fits ? 'true' : 'false');
    res.setHeader('X-Gift-Unsupported', String(rendered.omittedCount));
    return pdfFile(res, rendered.pdf, 'gift-card-preview.pdf');
  }

  @Patch('gift-message-templates/:id')
  @idParam
  @RequirePermission('company.manage')
  @ApiOperation({
    summary:
      'Update a gift-message template. Measurements are decimal strings. Setting isDefault clears the previous default.',
  })
  async updateTemplate(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    const parsed = templatePatch.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    return this.documents.updateTemplate(
      requireContext(req, companyId),
      id,
      parsed.data satisfies TemplatePatch,
      requestMeta(req),
    );
  }

  @Get('files/:id')
  @idParam
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @RequirePermission('document.download', { scope: fileResourceScope, anyOf: ['invoice.view'] })
  @ApiOperation({
    summary:
      'Download a stored file. The row is read under RLS first. invoice_pdf requires invoice.view. packing_slip and gift_message require document.download on the source order. test_print requires document.download at company scope.',
  })
  async file(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ): Promise<StreamableFile> {
    const file = await this.documents.readFile(
      requireContext(req, companyId),
      id,
      requestMeta(req),
    );
    const disposition = `inline; filename="${file.filename}"`;
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', disposition);
    return new StreamableFile(file.bytes, {
      type: file.contentType,
      disposition,
      length: file.bytes.length,
    });
  }
}

function templateIdOf(query: Record<string, unknown>): string | null {
  const value = query['templateId'];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new BadRequestException('templateId must be a uuid');
  }
  return value.toLowerCase();
}

function pdfFile(res: Response, bytes: Buffer, filename: string): StreamableFile {
  const disposition = `inline; filename="${filename}"`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', disposition);
  return new StreamableFile(bytes, {
    type: 'application/pdf',
    disposition,
    length: bytes.length,
  });
}
