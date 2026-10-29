import { Inject, Injectable } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { businessDateInZone } from '@bp/domain';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { isUuid } from '../authz/company-path';
import type { RequestContext } from '../authz/request-context';
import { CommerceError, settleCommerceError } from '../commerce/errors';
import { requireActor } from '../commerce/http';
import { correlationStorage } from '../correlation/correlation';
import { PrismaService } from '../database/prisma.service';
import { textCell, writeCsv } from '../export/csv';
import type { RequestMeta } from '../identity/request-meta';
import {
  CLIENT_CSV_COLUMNS,
  ClientDuplicateIndex,
  classifyRows,
  importCounts,
  parseClientCsv,
  clientWriteFromCsv,
  type ImportRow,
  type ImportCounts,
} from './client-csv';
import { ClientService, lockClientWrites } from './client.service';

export type ClientImportView = {
  id: string;
  status: 'previewed' | 'applied' | 'expired';
  fileName: string;
  sha256: string;
  rowCount: number;
  counts: ImportCounts;
  rows: ImportRow[];
  createdAt: string;
  appliedAt: string | null;
  appliedCount: number | null;
};

const previewBody = z.strictObject({ fileName: z.string().min(1).max(255), content: z.string() });
const confirmBody = z.strictObject({ expectedSha256: z.string().regex(/^[0-9a-f]{64}$/) });
const duplicateSelect = {
  id: true,
  nameNormalized: true,
  emailNormalized: true,
  vatNormalized: true,
} as const;

@Injectable()
export class ClientCsvService {
  private readonly tenants: TenantDb;
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ClientService) private readonly clients: ClientService,
  ) {
    this.tenants = new TenantDb(prisma.client);
  }

  async export(ctx: RequestContext, meta: RequestMeta) {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(
        this.context(ctx, actor),
        async (tx) => {
          if ((await tx.client.count({ where: { companyId: ctx.companyId } })) > 20_000) {
            throw this.error(
              422,
              'export_too_large',
              null,
              'At most 20,000 clients can be exported',
              'client.exported',
            );
          }
          const company = await tx.company.findUniqueOrThrow({
            where: { id: ctx.companyId },
            select: { timezone: true },
          });
          const header = writeCsv([[...CLIENT_CSV_COLUMNS, 'archived'].map(textCell)]);
          const chunks = [header];
          let length = header.length;
          let rowCount = 0;
          let lastId: string | undefined;
          for (;;) {
            const clients = await tx.client.findMany({
              where: { companyId: ctx.companyId, ...(lastId ? { id: { gt: lastId } } : {}) },
              orderBy: { id: 'asc' },
              take: 500,
              include: {
                addresses: {
                  where: { kind: 'billing', isDefault: true },
                  orderBy: { id: 'asc' },
                  take: 1,
                },
              },
            });
            const lastClient = clients.at(-1);
            if (!lastClient) break;
            const rows = clients.map((client) => {
              const address = client.addresses[0];
              return [
                client.kind === 'individual' ? 'person' : client.kind,
                client.displayName,
                client.legalName,
                client.vatNumber,
                client.taxId,
                client.email,
                client.phone,
                client.website,
                client.notes,
                client.defaultCurrency,
                client.defaultLanguage,
                client.paymentTermsDays?.toString(),
                String(client.acceptsEInvoices),
                address?.line1,
                address?.line2,
                address?.city,
                address?.region,
                address?.postalCode,
                address?.countryCode,
                String(client.archivedAt !== null),
              ].map(textCell);
            });
            // Only the header chunk carries a BOM; keep the shared writer's encoding for every batch.
            const chunk = writeCsv(rows).subarray(3);
            length += chunk.length;
            if (length > 64 * 1024 * 1024)
              throw this.error(
                422,
                'export_too_large',
                null,
                'The client CSV exceeds 64 MiB',
                'client.exported',
              );
            chunks.push(chunk);
            rowCount += clients.length;
            lastId = lastClient.id;
            if (clients.length < 500) break;
          }
          const details = { rowCount, totalSizeBytes: length };
          await this.record(tx, ctx, meta, 'client.export_prepared', null, details);
          return {
            chunks,
            length,
            fileName: `clients-${businessDateInZone(new Date(), company.timezone)}.csv`,
            recordTransfer: (completed: boolean, bytesSent: number) =>
              // Response events can outlive the request's async context and snapshot transaction.
              correlationStorage.run({ correlationId: ctx.correlationId }, () =>
                this.tenants.run(
                  this.context(ctx, actor),
                  (transferTx) =>
                    this.record(
                      transferTx,
                      ctx,
                      meta,
                      'client.exported',
                      null,
                      completed
                        ? details
                        : { ...details, reason: 'transfer_interrupted', bytesSent },
                      completed ? 'success' : 'failure',
                    ),
                  { timeoutMs: 5000 },
                ),
              ),
          };
        },
        { isolation: 'repeatable_read' },
      );
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async preview(ctx: RequestContext, body: unknown, meta: RequestMeta) {
    const actor = requireActor(ctx);
    try {
      const parsed = previewBody.safeParse(body);
      if (!parsed.success)
        throw this.error(400, 'invalid_body', null, 'Expected fileName and CSV content');
      // PostgreSQL text/jsonb cannot store NUL. Reject rather than silently changing customer text.
      if (parsed.data.content.includes('\0') || parsed.data.fileName.includes('\0'))
        throw this.error(422, 'invalid_csv', null, 'NUL is not supported');
      const values = parseClientCsv(parsed.data.content);
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const existing = await tx.client.findMany({
          where: { companyId: ctx.companyId },
          select: duplicateSelect,
          orderBy: { id: 'asc' },
        });
        const rows = classifyRows(values, existing);
        const saved = await tx.clientImport.create({
          data: {
            companyId: ctx.companyId,
            fileName: parsed.data.fileName,
            sha256: createHash('sha256').update(parsed.data.content, 'utf8').digest('hex'),
            rowCount: rows.length,
            rows,
            createdById: actor,
          },
        });
        await this.record(tx, ctx, meta, 'client.import_previewed', saved.id, {
          rowCount: rows.length,
          counts: importCounts(rows),
        });
        return this.view(saved);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async get(ctx: RequestContext, id: string, meta: RequestMeta) {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) =>
        this.view(await this.load(tx, ctx.companyId, id)),
      );
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async confirm(ctx: RequestContext, id: string, body: unknown, meta: RequestMeta) {
    const actor = requireActor(ctx);
    try {
      const parsed = confirmBody.safeParse(body);
      if (!parsed.success)
        throw this.error(
          400,
          'invalid_body',
          isUuid(id) ? id : null,
          'Expected expectedSha256',
          'client.imported',
        );
      const result = await this.tenants.run(
        this.context(ctx, actor),
        async (tx) => {
          if (!isUuid(id)) throw this.notFound(null);
          const locked = await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM client_import WHERE company_id = ${ctx.companyId}::uuid AND id = ${id}::uuid FOR UPDATE`;
          if (!locked.length) throw this.notFound(id);
          const preview = await this.load(tx, ctx.companyId, id);
          if (preview.status === 'applied')
            throw this.error(
              409,
              'already_applied',
              preview.id,
              'This preview has already been applied',
              'client.imported',
            );
          if (
            preview.status === 'expired' ||
            Date.now() - preview.createdAt.getTime() > 24 * 60 * 60 * 1000
          ) {
            await tx.clientImport.update({
              where: { id: preview.id },
              data: { status: 'expired' },
            });
            // Commit expiry before settling the audited refusal outside this transaction.
            return { expired: true } as const;
          }
          if (preview.sha256 !== parsed.data.expectedSha256)
            throw this.error(
              409,
              'preview_changed',
              preview.id,
              'The file hash does not match the preview',
              'client.imported',
            );
          await lockClientWrites(tx, ctx.companyId);
          const existing = await tx.client.findMany({
            where: { companyId: ctx.companyId },
            select: duplicateSelect,
            orderBy: { id: 'asc' },
          });
          const duplicates = new ClientDuplicateIndex(existing);
          const rows = storedRows(preview.rows);
          let appliedCount = 0;
          for (const row of rows) {
            if (row.status !== 'new') continue;
            const messages = duplicates.find(row.values);
            if (messages.length) {
              row.status = 'duplicate';
              row.messages = messages;
              continue;
            }
            await this.clients.createInTransaction(
              tx,
              ctx.companyId,
              actor,
              clientWriteFromCsv(row.values),
            );
            duplicates.add(row.values, row.number);
            appliedCount++;
          }
          await tx.clientImport.update({
            where: { id: preview.id },
            data: {
              status: 'applied',
              rows,
              appliedById: actor,
              appliedAt: new Date(),
              appliedCount,
            },
          });
          const counts = importCounts(rows);
          // One summary, rather than up to 5,000 client.created events; includes e-invoice consent evidence.
          await this.record(tx, ctx, meta, 'client.imported', preview.id, {
            rowCount: preview.rowCount,
            appliedCount,
            counts,
            acceptsEInvoicesCount: rows.filter(
              (row) => row.status === 'new' && row.values.accepts_e_invoices === 'true',
            ).length,
          });
          return { expired: false, appliedCount, counts } as const;
        },
        { timeoutMs: 120_000, maxWaitMs: 120_000 },
      );
      if (result.expired)
        throw this.error(
          409,
          'preview_expired',
          id,
          'This preview is older than 24 hours',
          'client.imported',
        );
      return { appliedCount: result.appliedCount, counts: result.counts };
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  private async load(tx: TenantTransaction, companyId: string, id: string) {
    if (!isUuid(id)) throw this.notFound(null);
    const row = await tx.clientImport.findFirst({ where: { companyId, id: id.toLowerCase() } });
    if (!row) throw this.notFound(id);
    return row;
  }
  private view(row: Awaited<ReturnType<ClientCsvService['load']>>): ClientImportView {
    const rows = storedRows(row.rows);
    return {
      id: row.id,
      status: row.status,
      fileName: row.fileName,
      sha256: row.sha256,
      rowCount: row.rowCount,
      counts: importCounts(rows),
      rows,
      createdAt: row.createdAt.toISOString(),
      appliedAt: row.appliedAt?.toISOString() ?? null,
      appliedCount: row.appliedCount,
    };
  }
  private context(ctx: RequestContext, actor: string) {
    return { companyId: ctx.companyId, actor, correlationId: ctx.correlationId };
  }
  private notFound(id: string | null) {
    return new CommerceError(404, 'import_not_found', 'client_import', id, 'Not found');
  }
  private error(
    status: 400 | 409 | 422,
    reason: string,
    id: string | null,
    message: string,
    action = 'client.import_previewed',
  ) {
    return new CommerceError(
      status,
      reason,
      action === 'client.exported' ? 'client' : 'client_import',
      id,
      message,
      action,
    );
  }
  private record(
    tx: TenantTransaction,
    ctx: RequestContext,
    meta: RequestMeta,
    action: string,
    id: string | null,
    details: Record<string, unknown>,
    outcome: 'success' | 'failure' = 'success',
  ) {
    return this.audit.record(tx, {
      companyId: ctx.companyId,
      actorType: 'user',
      actorId: requireActor(ctx),
      actorLabel: ctx.actorLabel,
      action,
      objectType: id ? 'client_import' : 'client',
      objectId: id,
      outcome,
      ip: meta.ip,
      userAgent: meta.userAgent,
      details,
    });
  }
  private fail(ctx: RequestContext, meta: RequestMeta, error: unknown): Promise<never> {
    if (error instanceof CommerceError)
      return settleCommerceError(this.audit, this.prisma, ctx, meta, error);
    throw error;
  }
}

/** Only server-classified rows are stored in this JSON column; no client can supply a preview. */
function storedRows(value: unknown): ImportRow[] {
  return value as ImportRow[];
}
