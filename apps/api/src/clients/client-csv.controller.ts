import { Controller, Get, HttpCode, Inject, Logger, Param, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RequirePermission } from '../authz/require-permission.decorator';
import { requireContext, unknownBody } from '../commerce/http';
import { requestMeta } from '../identity/request-meta';
import { ClientCsvService } from './client-csv.service';

@ApiTags('clients')
@ApiParam({ name: 'companyId', required: true, schema: { type: 'string', format: 'uuid' } })
@Controller('c/:companyId/clients')
export class ClientCsvController {
  private readonly logger = new Logger(ClientCsvController.name);
  constructor(@Inject(ClientCsvService) private readonly csv: ClientCsvService) {}

  @Get('export.csv')
  @RequirePermission('client.export')
  @ApiOperation({
    summary: 'Export all clients, including archived clients, as spreadsheet-safe CSV (MFA)',
  })
  async export(@Req() req: Request, @Res() res: Response, @Param('companyId') companyId: string) {
    const ctx = requireContext(req, companyId);
    const result = await this.csv.export(ctx, requestMeta(req));
    let recorded = false;
    let bytesSent = 0;
    const recordTransfer = (completed: boolean) => {
      // finish is followed by close; errors and disconnects may also emit both events.
      if (recorded) return;
      recorded = true;
      void result.recordTransfer(completed, bytesSent).catch(() => {
        this.logger.error({
          message: 'Client CSV transfer audit failed',
          correlationId: ctx.correlationId,
        });
      });
    };
    res.once('finish', () => {
      recordTransfer(true);
    });
    res.once('close', () => {
      recordTransfer(false);
    });
    res.once('error', () => {
      recordTransfer(false);
    });
    if (res.destroyed) {
      recordTransfer(false);
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
    res.setHeader('Content-Length', String(result.length));
    res.setHeader('Cache-Control', 'no-store');
    try {
      for (const chunk of result.chunks) {
        // Count only flushed writes, with bounded buffering when a client disconnects.
        for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
          const bytes = chunk.subarray(offset, offset + 64 * 1024);
          await new Promise<void>((resolve, reject) => {
            res.write(bytes, (error: Error | null | undefined) => {
              if (error) reject(error);
              else {
                bytesSent += bytes.length;
                resolve();
              }
            });
          });
        }
      }
      res.end();
    } catch {
      recordTransfer(false);
      res.destroy();
    }
  }

  @Post('imports')
  @HttpCode(200)
  @RequirePermission('client.import')
  @ApiOperation({ summary: 'Preview a client CSV file, up to 5,000 data rows (MFA)' })
  async preview(@Req() req: Request, @Param('companyId') companyId: string) {
    return {
      import: await this.csv.preview(
        requireContext(req, companyId),
        unknownBody(req),
        requestMeta(req),
      ),
    };
  }

  @Get('imports/:id')
  @RequirePermission('client.import')
  @ApiOperation({ summary: 'Reload the stored client import preview' })
  async get(@Req() req: Request, @Param('companyId') companyId: string, @Param('id') id: string) {
    return { import: await this.csv.get(requireContext(req, companyId), id, requestMeta(req)) };
  }

  @Post('imports/:id/confirm')
  @HttpCode(200)
  @RequirePermission('client.import')
  @ApiOperation({ summary: 'Apply only the new rows of a preview once, within 24 hours (MFA)' })
  async confirm(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    return this.csv.confirm(requireContext(req, companyId), id, unknownBody(req), requestMeta(req));
  }
}
