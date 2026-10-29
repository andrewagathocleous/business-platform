import { Controller, Get, Header, Inject, Logger, Param, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RequirePermission } from '../authz/require-permission.decorator';
import { requireContext } from '../commerce/http';
import { requestMeta } from '../identity/request-meta';
import { AccountantExportService } from './accountant-export.service';

@ApiTags('exports')
@ApiParam({ name: 'companyId', required: true, schema: { type: 'string', format: 'uuid' } })
@Controller('c/:companyId/exports')
export class ExportController {
  private readonly logger = new Logger(ExportController.name);

  constructor(@Inject(AccountantExportService) private readonly exports: AccountantExportService) {}

  @Get('accountant')
  @RequirePermission('invoice.export')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'no-store')
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiQuery({ name: 'pdfs', required: false, enum: ['true', 'false'] })
  @ApiProduces('application/zip')
  @ApiOperation({ summary: 'Accountant CSV export, optionally including verified issued PDFs.' })
  async accountant(
    @Req() req: Request,
    @Res() res: Response,
    @Param('companyId') companyId: string,
  ) {
    const ctx = requireContext(req, companyId);
    const file = await this.exports.export(
      ctx,
      req.query.from,
      req.query.to,
      req.query.pdfs,
      requestMeta(req),
    );
    let recorded = false;
    let bytesSent = 0;
    const recordTransfer = (completed: boolean) => {
      // finish is normally followed by close; errors can also precede close.
      if (recorded) return;
      recorded = true;
      void file.recordTransfer(completed, bytesSent).catch(() => {
        this.logger.error({
          message: 'Accountant export transfer audit failed',
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
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${file.fileName}"`,
      'Content-Length': String(file.length),
    });
    try {
      for (const chunk of file.chunks) {
        // Bound writes and wait for each flush. Reading ahead or counting an
        // entire compressed PDF would include bytes still buffered on an abort.
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
}
