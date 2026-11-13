import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../authz/require-permission.decorator';
import { requireContext } from '../commerce/http';
import { ReportService } from './report.service';

@ApiTags('reports')
@ApiParam({ name: 'companyId', required: true, schema: { type: 'string', format: 'uuid' } })
@Controller('c/:companyId/reports')
export class ReportController {
  constructor(@Inject(ReportService) private readonly reports: ReportService) {}

  @Get('invoiced')
  @RequirePermission('report.finance.view')
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiOperation({
    summary: 'Issued invoices minus issued credit notes, by issue date and tax code.',
  })
  invoiced(@Req() req: Request, @Param('companyId') companyId: string) {
    return this.reports.invoiced(requireContext(req, companyId), req.query.from, req.query.to);
  }

  @Get('collected')
  @RequirePermission('report.finance.view')
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiOperation({
    summary: 'Recorded payments minus recorded refunds, by receipt/refund date and method.',
  })
  collected(@Req() req: Request, @Param('companyId') companyId: string) {
    return this.reports.collected(requireContext(req, companyId), req.query.from, req.query.to);
  }

  @Get('ageing')
  @RequirePermission('report.finance.view')
  @ApiQuery({ name: 'asOf', required: true, type: String })
  @ApiOperation({
    summary: 'Open invoices by due date and separate client credit as of a business date.',
  })
  ageing(@Req() req: Request, @Param('companyId') companyId: string) {
    return this.reports.ageing(requireContext(req, companyId), req.query.asOf);
  }
}
