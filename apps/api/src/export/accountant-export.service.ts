import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TenantDb } from '@bp/db';
import type { StorageAdapter } from '@bp/integrations';
import { z } from 'zod';
import { AuditService, type AuditOutcome } from '../audit/audit.service';
import type { RequestContext } from '../authz/request-context';
import { CommerceError, settleCommerceError } from '../commerce/errors';
import { formatDateOnly } from '../commerce/format';
import { requireActor } from '../commerce/http';
import { correlationStorage } from '../correlation/correlation';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';
import { reportPeriod } from '../reports/report-dates';
import { integrityFailed, isStorageMiss } from '../storage/file-errors';
import { STORAGE } from '../storage/storage.module';
import { FileIntegrityError, readVerifiedFile } from '../storage/verified-file';
import { decimalCell as d, textCell as t, writeCsv, type CsvCell } from './csv';
import { exportReadme } from './readme';
import { compressZipEntry, writeZip, ZipLimitError, type CompressedZipEntry } from './zip';

const buyerSnapshot = z.object({
  displayName: z.string(),
  legalName: z.string().nullable(),
  vatNumber: z.string().nullable(),
});
const taxSnapshot = z.object({ code: z.string(), name: z.string() });
const ACTION = 'invoice.exported';
const MAX_PDF_BYTES = 150 * 1024 * 1024;

@Injectable()
export class AccountantExportService {
  private readonly tenants: TenantDb;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(STORAGE) private readonly storage: StorageAdapter,
  ) {
    this.tenants = new TenantDb(prisma.client);
  }

  async export(ctx: RequestContext, from: unknown, to: unknown, pdfs: unknown, meta: RequestMeta) {
    const details = {
      from: auditDate(from),
      to: auditDate(to),
      pdfsIncluded: pdfs === 'true',
      pdfSizeBytes: 0,
      fileCounts: { csv: 0, pdfs: 0, total: 0 },
      rowCounts: {
        invoices: 0,
        invoiceLines: 0,
        taxSummary: 0,
        payments: 0,
        allocations: 0,
        refunds: 0,
      },
    };
    try {
      const { start, end } = exportPeriod(from, to);
      if (pdfs !== undefined && pdfs !== 'true' && pdfs !== 'false') {
        throw new CommerceError(
          400,
          'invalid_pdfs',
          'accountant_export',
          null,
          'pdfs must be true or false.',
          ACTION,
        );
      }
      const includePdfs = pdfs === 'true';
      const period = { gte: start.date, lte: end.date };
      const data = await this.tenants.run(
        { companyId: ctx.companyId, actor: requireActor(ctx), correlationId: ctx.correlationId },
        async (tx) => {
          const documents = await tx.invoice.findMany({
            where: {
              companyId: ctx.companyId,
              status: 'issued',
              documentType: { in: ['invoice', 'credit_note'] },
              issueDate: period,
            },
            include: {
              series: { select: { code: true } },
              creditedInvoice: { select: { number: true } },
              lines: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
              taxSummary: { orderBy: { taxCodeId: 'asc' } },
              pdfFile: includePdfs,
            },
            orderBy: [{ issueDate: 'asc' }, { id: 'asc' }],
          });
          // Voids and reversals are exported as well as active entries for reconciliation.
          const payments = await tx.payment.findMany({
            where: { companyId: ctx.companyId, receivedOn: period },
            include: { client: { select: { displayName: true } } },
            orderBy: [{ receivedOn: 'asc' }, { id: 'asc' }],
          });
          const allocations = await tx.allocation.findMany({
            where: {
              companyId: ctx.companyId,
              OR: [{ effectiveOn: period }, { reversedOn: period }],
            },
            include: {
              creditNote: { select: { number: true } },
              invoice: { select: { number: true } },
            },
            orderBy: [{ effectiveOn: 'asc' }, { id: 'asc' }],
          });
          const refunds = await tx.refund.findMany({
            where: { companyId: ctx.companyId, OR: [{ refundedOn: period }, { voidedOn: period }] },
            include: { creditNote: { select: { number: true } } },
            orderBy: [{ refundedOn: 'asc' }, { id: 'asc' }],
          });
          return { documents, payments, allocations, refunds };
        },
        { isolation: 'repeatable_read' },
      );
      const { documents, payments, allocations, refunds } = data;
      if (includePdfs)
        details.pdfSizeBytes = documents.reduce(
          (sum, row) => sum + (row.pdfFile?.sizeBytes ?? 0),
          0,
        );
      details.rowCounts = {
        invoices: documents.length,
        invoiceLines: documents.reduce((sum, row) => sum + row.lines.length, 0),
        taxSummary: documents.reduce((sum, row) => sum + row.taxSummary.length, 0),
        payments: payments.length,
        allocations: allocations.length,
        refunds: refunds.length,
      };
      if (includePdfs && documents.length > 1000)
        throw tooLarge('An export can include at most 1,000 PDFs. Choose a shorter period.');
      if (details.pdfSizeBytes > MAX_PDF_BYTES)
        throw tooLarge(
          'The selected PDFs exceed 150 MiB. Choose a shorter period or export without PDFs.',
        );

      const entries: CompressedZipEntry[] = [
        compressZipEntry({
          name: 'README.txt',
          bytes: exportReadme(start.day, end.day, includePdfs),
        }),
        csv(
          'invoices.csv',
          [
            'id',
            'document_type',
            'number',
            'series_code',
            'issue_date',
            'supply_date',
            'due_date',
            'client_id',
            'buyer_name',
            'buyer_vat_number',
            'currency',
            'prices_include_tax',
            'net',
            'tax',
            'total',
            'credited_invoice_number',
            'credit_reason',
            'issued_at',
          ],
          documents.map((row) => {
            const buyer = buyerSnapshot.parse(row.buyerSnapshot);
            return [
              t(row.id),
              t(row.documentType),
              t(row.number),
              t(row.series?.code),
              t(formatDateOnly(row.issueDate)),
              t(formatDateOnly(row.supplyDate)),
              t(formatDateOnly(row.dueDate)),
              t(row.clientId),
              t(buyer.legalName ?? buyer.displayName),
              t(buyer.vatNumber),
              t(row.currency),
              t(String(row.pricesIncludeTax)),
              d(row.netTotal, 2),
              d(row.taxTotal, 2),
              d(row.total, 2),
              t(row.creditedInvoice?.number),
              t(row.creditReason),
              t(row.issuedAt?.toISOString()),
            ];
          }),
        ),
        csv(
          'invoice_lines.csv',
          [
            'document_number',
            'position',
            'description',
            'quantity',
            'unit',
            'unit_price',
            'discount_percent',
            'tax_code',
            'tax_rate',
            'line_net',
            'line_amount_incl_vat',
          ],
          documents.flatMap((row) =>
            row.lines.map((line) => [
              t(row.number),
              t(String(line.position)),
              t(line.description),
              d(line.quantity, 4),
              t(line.unit),
              d(line.unitPrice, 4),
              d(line.discountPercent, 2),
              t(taxSnapshot.parse(line.taxSnapshot).code),
              d(line.taxRatePercent, 4),
              d(line.lineNet, 2),
              row.pricesIncludeTax ? d(line.lineGross, 2) : t(''),
            ]),
          ),
        ),
        csv(
          'tax_summary.csv',
          ['document_number', 'tax_code', 'tax_name', 'tax_rate', 'net', 'tax', 'gross'],
          documents.flatMap((row) =>
            row.taxSummary.map((tax) => {
              const label = taxSnapshot.parse(tax.taxSnapshot);
              return [
                t(row.number),
                t(label.code),
                t(label.name),
                d(tax.taxRatePercent, 4),
                d(tax.net, 2),
                d(tax.tax, 2),
                d(tax.gross, 2),
              ];
            }),
          ),
        ),
        csv(
          'payments.csv',
          [
            'id',
            'client_id',
            'client_name',
            'received_on',
            'amount',
            'currency',
            'method',
            'reference',
            'status',
            'voided_on',
            'void_reason',
          ],
          payments.map((row) => [
            t(row.id),
            t(row.clientId),
            t(row.client.displayName),
            t(formatDateOnly(row.receivedOn)),
            d(row.amount, 2),
            t(row.currency),
            t(row.method),
            t(row.reference),
            t(row.status),
            t(formatDateOnly(row.voidedOn)),
            t(row.voidReason),
          ]),
        ),
        csv(
          'allocations.csv',
          [
            'id',
            'source_type',
            'payment_id',
            'credit_note_number',
            'invoice_number',
            'amount',
            'effective_on',
            'reversed_on',
            'reversal_reason',
          ],
          allocations.map((row) => [
            t(row.id),
            t(row.paymentId ? 'payment' : 'credit_note'),
            t(row.paymentId),
            t(row.creditNote?.number),
            t(row.invoice.number),
            d(row.amount, 2),
            t(formatDateOnly(row.effectiveOn)),
            t(formatDateOnly(row.reversedOn)),
            t(row.reversalReason),
          ]),
        ),
        csv(
          'refunds.csv',
          [
            'id',
            'source_type',
            'payment_id',
            'credit_note_number',
            'amount',
            'refunded_on',
            'method',
            'reference',
            'status',
            'voided_on',
          ],
          refunds.map((row) => [
            t(row.id),
            t(row.paymentId ? 'payment' : 'credit_note'),
            t(row.paymentId),
            t(row.creditNote?.number),
            d(row.amount, 2),
            t(formatDateOnly(row.refundedOn)),
            t(row.method),
            t(row.reference),
            t(row.status),
            t(formatDateOnly(row.voidedOn)),
          ]),
        ),
      ];
      if (includePdfs) {
        for (const document of documents) {
          if (!document.pdfFile || !document.number)
            throw new Error('Issued document has no PDF or number');
          let bytes: Buffer;
          try {
            bytes = await readVerifiedFile(this.storage, document.pdfFile);
          } catch (error) {
            if (error instanceof FileIntegrityError)
              throw integrityFailed(document.pdfFile.id, error);
            if (isStorageMiss(error))
              throw new CommerceError(
                404,
                'pdf_not_found',
                'stored_file',
                document.pdfFile.id,
                'Not found',
              );
            // Adapter errors can contain storage keys or filesystem paths.
            throw new Error('Storage read failed');
          }
          entries.push(
            compressZipEntry({ name: `pdfs/${encodeURIComponent(document.number)}.pdf`, bytes }),
          );
        }
      }
      const chunks = writeZip(entries);
      const fileCounts = {
        csv: 6,
        pdfs: includePdfs ? documents.length : 0,
        total: entries.length,
      };
      const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const exportDetails = { ...details, fileCounts, totalSizeBytes: length };
      await this.record(ctx, meta, exportDetails, 'success', 'invoice.export_prepared');
      return {
        chunks,
        length,
        fileName: `accountant-export-${start.day}-${end.day}.zip`,
        recordTransfer: (completed: boolean, bytesSent: number) =>
          this.record(
            ctx,
            meta,
            completed
              ? exportDetails
              : { ...exportDetails, reason: 'transfer_interrupted', bytesSent },
            completed ? 'success' : 'failure',
          ),
      };
    } catch (error) {
      const failure =
        error instanceof ZipLimitError
          ? tooLarge('The export reaches the ZIP size limit. Choose a shorter period.')
          : error;
      await this.record(
        ctx,
        meta,
        { ...details, reason: failure instanceof CommerceError ? failure.reason : 'export_failed' },
        'failure',
      );
      if (failure instanceof CommerceError) {
        // The export refusal above and the existing tampered-file audit both survive rollback.
        if (failure.reason === 'file_integrity_failed' || failure.status === 404)
          return settleCommerceError(this.audit, this.prisma, ctx, meta, failure);
        if (failure.status === 422)
          throw new UnprocessableEntityException({
            code: failure.reason,
            message: failure.message,
          });
        throw new BadRequestException({ code: failure.reason, message: failure.message });
      }
      throw new InternalServerErrorException('Accountant export failed');
    }
  }

  private record(
    ctx: RequestContext,
    meta: RequestMeta,
    details: Record<string, unknown>,
    outcome: AuditOutcome,
    action = ACTION,
  ) {
    // Response events can run after the request's async context has ended.
    return correlationStorage.run({ correlationId: ctx.correlationId }, () =>
      this.tenants.run(
        { companyId: ctx.companyId, actor: requireActor(ctx), correlationId: ctx.correlationId },
        (tx) =>
          this.audit.record(tx, {
            companyId: ctx.companyId,
            actorType: 'user',
            actorId: ctx.userId,
            actorLabel: ctx.actorLabel,
            action,
            objectType: 'accountant_export',
            outcome,
            ip: meta.ip,
            userAgent: meta.userAgent,
            details,
          }),
        { timeoutMs: 5000 },
      ),
    );
  }
}

function csv(name: string, headers: string[], rows: CsvCell[][]): CompressedZipEntry {
  return compressZipEntry({ name, bytes: writeCsv([headers.map(t), ...rows]) });
}

function tooLarge(message: string): CommerceError {
  return new CommerceError(422, 'export_too_large', 'accountant_export', null, message, ACTION);
}

function exportPeriod(from: unknown, to: unknown) {
  try {
    return reportPeriod(from, to);
  } catch (error) {
    if (error instanceof UnprocessableEntityException)
      throw new CommerceError(
        422,
        'invalid_date',
        'accountant_export',
        null,
        'Use valid business dates YYYY-MM-DD, from on or before to, at most 366 days inclusive.',
        ACTION,
      );
    throw error;
  }
}

/** Do not copy arbitrary query content into the audit log. */
function auditDate(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}
