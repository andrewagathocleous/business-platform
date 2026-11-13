import { Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../authz/require-permission.decorator';
import { requireContext } from '../commerce/http';
import { requestMeta } from '../identity/request-meta';
import { InvoiceService } from './invoice.service';

@ApiTags('quotes')
@ApiParam({ name: 'companyId', required: true, schema: { type: 'string', format: 'uuid' } })
@Controller('c/:companyId/quotes')
export class QuoteController {
  constructor(@Inject(InvoiceService) private readonly invoices: InvoiceService) {}

  @Post(':id/convert')
  @HttpCode(200)
  @ApiParam({ name: 'id', required: true, schema: { type: 'string', format: 'uuid' } })
  @RequirePermission('invoice.draft')
  @ApiOperation({
    summary:
      'Convert a quote into a new draft invoice with its lines. A quote converts once (409 already_converted).',
  })
  async convert(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    const invoice = await this.invoices.convertQuote(
      requireContext(req, companyId),
      id,
      requestMeta(req),
    );
    return { invoice };
  }
}
