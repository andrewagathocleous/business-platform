import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, TenantDb, type TenantTransaction } from '@bp/db';
import { can, permittedScopeFilter } from '@bp/domain';
import {
  renderGiftMessage,
  renderPackingSlip,
  type DocumentLanguage,
  type GiftMessageTemplate,
} from '@bp/documents';
import {
  ProviderRejected,
  SIMULATED_PRINTING_LABEL,
  storageKey,
  type ListedPrinter,
  type PrintProviderName,
  type StorageAdapter,
} from '@bp/integrations';
import { AuditService } from '../audit/audit.service';
import { isUuid } from '../authz/company-path';
import type { RequestContext } from '../authz/request-context';
import { CommerceError, settleCommerceError } from '../commerce/errors';
import { fixed } from '../commerce/format';
import { requireActor } from '../commerce/http';
import { getCorrelationId, uuidv7 } from '../correlation/correlation';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';
import { orderScopes } from '../orders/order.scope';
import { PrintProviderRegistry } from './print-providers';
import { PrintNodeCredentials } from './printnode-credentials';
import { FIRST_PRINT_RELEASED_STATUSES } from './first-print';
import { printJobLabel } from './print-label';
import { STORAGE } from '../storage/storage.module';

/**
 * `printed` is allowed only from a status that reached the provider, or from
 * `uncertain`. `uncertain` is only written from `submitting`.
 * `not_printed` is also allowed from `failed`.
 */
const PRINTED_FROM = ['submitted', 'delivered_to_printer', 'done_reported', 'uncertain'] as const;
const NOT_PRINTED_FROM = [...PRINTED_FROM, 'failed'] as const;
const CANCEL_FROM = ['queued', 'held', 'uncertain'] as const;

const SUBMIT_ATTEMPTS = 1;
const SUBMIT_TIMEOUT_MS = 30_000;

export type PrintDocumentType = 'invoice' | 'packing_slip' | 'gift_message' | 'shipping_label';
export type PrintJobStatusName =
  | 'queued'
  | 'held'
  | 'submitting'
  | 'submitted'
  | 'delivered_to_printer'
  | 'done_reported'
  | 'confirmed_printed'
  | 'not_printed'
  | 'failed'
  | 'uncertain'
  | 'cancelled';

export type PrintRequestInput = {
  documentType: PrintDocumentType;
  sourceType: 'order' | 'invoice';
  sourceId: string;
  copies?: number;
  printerId?: string;
  /** Invoices only: the location whose `invoice` mapping to use, when several have one. */
  locationId?: string;
  reprint?: { ofPrintJobId: string; reason: string };
};

type NewPrintJob = {
  printJobId: string;
  printerId: string;
  documentType: PrintDocumentType;
  sourceType: 'order' | 'invoice';
  sourceId: string;
  sourceVersion: number;
  copies: number;
  paperSize: string;
  reprintOfId: string | null;
  reprintReason: string | null;
};

export type PrintJobView = {
  id: string;
  documentType: string;
  sourceType: string;
  sourceId: string;
  sourceVersion: number;
  copies: number;
  paperSize: string;
  status: string;
  label: string;
  provider: string;
  simulationLabel: string | null;
  isReprint: boolean;
  reprintOfId: string | null;
  reprintReason: string | null;
  providerJobId: string | null;
  providerState: string | null;
  lastError: string | null;
  fileId: string | null;
  requestedById: string;
  queueJobId: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  completedAt: string | null;
  confirmedAt: string | null;
  can?: { cancel: boolean; release: boolean };
};

export type PrinterView = {
  id: string;
  locationId: string;
  provider: string;
  externalPrinterId: string;
  name: string;
  description: string | null;
  paperSizes: string[];
  status: string;
  lastSeenAt: string | null;
  simulationLabel: string | null;
};

export type MappingInput = {
  locationId: string;
  documentType: PrintDocumentType;
  printerId: string;
  paperSize: string;
  copies?: number;
};

type PrintRow = {
  id: string;
  documentType: string;
  sourceType: string;
  sourceId: string;
  sourceVersion: number;
  copies: number;
  paperSize: string;
  status: string;
  isReprint: boolean;
  reprintOfId: string | null;
  reprintReason: string | null;
  providerJobId: string | null;
  providerState: string | null;
  lastError: string | null;
  fileId: string | null;
  requestedById: string;
  queueJobId: string | null;
  createdAt: Date;
  updatedAt: Date;
  submittedAt: Date | null;
  completedAt: Date | null;
  confirmedAt: Date | null;
  printer: { provider: string };
};

@Injectable()
export class PrintService {
  private readonly tenants: TenantDb;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(STORAGE) private readonly storage: StorageAdapter,
    @Inject(PrintProviderRegistry) private readonly providers: PrintProviderRegistry,
    @Inject(PrintNodeCredentials) private readonly printNodeKeys: PrintNodeCredentials,
  ) {
    this.tenants = new TenantDb(prisma.client);
  }

  async request(
    ctx: RequestContext,
    input: PrintRequestInput,
    meta: RequestMeta,
  ): Promise<{ printJob: PrintJobView }> {
    const actor = requireActor(ctx);
    const correlationId = this.correlation();
    try {
      const printJob = await this.tenants.run(this.context(ctx, actor, correlationId), (tx) =>
        this.insertRequest(tx, ctx, actor, correlationId, input, meta),
      );
      return { printJob };
    } catch (error) {
      if (isFirstPrintConflict(error)) {
        const existingId = await this.existingFirstPrint(ctx, actor, correlationId, input);
        return this.fail(
          ctx,
          meta,
          new CommerceError(
            409,
            'already_printed',
            'print_job',
            existingId,
            'already_printed',
            'print_job.requested',
            { printJobId: existingId },
          ),
        );
      }
      return this.fail(ctx, meta, error);
    }
  }

  async list(
    ctx: RequestContext,
    query: { status?: PrintJobStatusName; sourceId?: string; page: number; pageSize: number },
    meta: RequestMeta,
  ): Promise<{ printJobs: PrintJobView[]; page: number; pageSize: number; total: number }> {
    try {
      return await this.tenants.run(this.context(ctx), async (tx) => {
        const scope = this.listScope(ctx);
        if (scope.kind === 'none') {
          return { printJobs: [], page: query.page, pageSize: query.pageSize, total: 0 };
        }
        const totalRows = await tx.$queryRaw<{ total: number }[]>`
          SELECT count(*)::int AS total
          FROM print_job pj
          LEFT JOIN sales_order o
            ON pj.source_type = 'order'::"print_source_type"
           AND o.company_id = pj.company_id
           AND o.id = pj.source_id
          LEFT JOIN store s ON s.company_id = o.company_id AND s.id = o.store_id
          WHERE ${this.listWhere(ctx.companyId, query, scope)}
        `;
        const offset = (query.page - 1) * query.pageSize;
        const rows = await tx.$queryRaw<
          { id: string; storeId: string | null; locationId: string | null }[]
        >`
          SELECT pj.id, o.store_id AS "storeId", s.location_id AS "locationId"
          FROM print_job pj
          LEFT JOIN sales_order o
            ON pj.source_type = 'order'::"print_source_type"
           AND o.company_id = pj.company_id
           AND o.id = pj.source_id
          LEFT JOIN store s ON s.company_id = o.company_id AND s.id = o.store_id
          WHERE ${this.listWhere(ctx.companyId, query, scope)}
          ORDER BY pj.created_at DESC, pj.id DESC
          LIMIT ${query.pageSize} OFFSET ${offset}
        `;
        const jobs: PrintJobView[] = [];
        for (const row of rows) {
          const loaded = await this.loadJob(tx, ctx.companyId, row.id);
          if (loaded) {
            jobs.push({
              ...loaded,
              can: printJobCapabilities(ctx.grants, loaded.sourceType, row.storeId, row.locationId),
            });
          }
        }
        return {
          printJobs: jobs,
          page: query.page,
          pageSize: query.pageSize,
          total: totalRows[0]?.total ?? 0,
        };
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async get(
    ctx: RequestContext,
    id: string,
    meta: RequestMeta,
  ): Promise<{ printJob: PrintJobView }> {
    try {
      const printJob = await this.tenants.run(this.context(ctx), async (tx) => {
        const job = await this.loadJob(tx, ctx.companyId, id);
        if (!job) {
          throw new CommerceError(
            404,
            'not_found',
            'print_job',
            isUuid(id) ? id.toLowerCase() : null,
            'Not found',
          );
        }
        return job;
      });
      return { printJob };
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async confirm(
    ctx: RequestContext,
    id: string,
    outcome: 'printed' | 'not_printed',
    meta: RequestMeta,
  ): Promise<{ printJob: PrintJobView }> {
    const actor = requireActor(ctx);
    const next = outcome === 'printed' ? 'confirmed_printed' : 'not_printed';
    const allowed = outcome === 'printed' ? PRINTED_FROM : NOT_PRINTED_FROM;
    try {
      const printJob = await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const jobId = this.jobId(id);
        const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
          SELECT id, status::text AS status
          FROM print_job
          WHERE company_id = ${ctx.companyId}::uuid
            AND id = ${jobId}::uuid
          FOR UPDATE
        `;
        const current = locked[0];
        if (!current) {
          throw new CommerceError(404, 'not_found', 'print_job', jobId, 'Not found');
        }
        if (!includesStatus(allowed, current.status)) {
          if (outcome === 'printed') {
            throw new CommerceError(
              422,
              'confirm_not_allowed',
              'print_job',
              jobId,
              'confirm_not_allowed',
              'print_job.confirmed',
            );
          }
          throw new CommerceError(
            409,
            'print_not_confirmable',
            'print_job',
            jobId,
            'print_not_confirmable',
            'print_job.confirmed',
          );
        }
        const updated = await tx.$queryRaw<{ id: string }[]>`
          UPDATE print_job
          SET status = ${next}::"print_job_status",
              confirmed_by = ${actor}::uuid,
              confirmed_at = clock_timestamp(),
              updated_at = clock_timestamp()
          WHERE company_id = ${ctx.companyId}::uuid
            AND id = ${jobId}::uuid
            AND status::text = ANY(${[...allowed]})
          RETURNING id
        `;
        if (updated.length === 0) {
          throw new CommerceError(
            outcome === 'printed' ? 422 : 409,
            outcome === 'printed' ? 'confirm_not_allowed' : 'print_not_confirmable',
            'print_job',
            jobId,
            outcome === 'printed' ? 'confirm_not_allowed' : 'print_not_confirmable',
            'print_job.confirmed',
          );
        }
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'print_job.confirmed',
          objectType: 'print_job',
          objectId: jobId,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: { outcome, status: next },
        });
        return this.mustLoad(tx, ctx.companyId, id);
      });
      return { printJob };
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async release(
    ctx: RequestContext,
    id: string,
    meta: RequestMeta,
  ): Promise<{ printJob: PrintJobView }> {
    const actor = requireActor(ctx);
    try {
      const printJob = await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const jobId = this.jobId(id);
        const locked = await tx.$queryRaw<
          { id: string; status: string; queueJobId: string | null }[]
        >`
          SELECT id, status::text AS status, queue_job_id AS "queueJobId"
          FROM print_job
          WHERE company_id = ${ctx.companyId}::uuid
            AND id = ${jobId}::uuid
          FOR UPDATE
        `;
        const current = locked[0];
        if (!current) {
          throw new CommerceError(404, 'not_found', 'print_job', jobId, 'Not found');
        }
        if (current.status !== 'held') {
          throw new CommerceError(
            409,
            'print_not_held',
            'print_job',
            jobId,
            'print_not_held',
            'print_job.release',
          );
        }
        const updated = await tx.$queryRaw<{ id: string }[]>`
          UPDATE print_job
          SET status = 'queued'::"print_job_status",
              last_error = NULL,
              updated_at = clock_timestamp()
          WHERE company_id = ${ctx.companyId}::uuid
            AND id = ${jobId}::uuid
            AND status = 'held'::"print_job_status"
          RETURNING id
        `;
        if (updated.length === 0) {
          throw new CommerceError(
            409,
            'print_not_held',
            'print_job',
            jobId,
            'print_not_held',
            'print_job.release',
          );
        }
        if (current.queueJobId) {
          await tx.$queryRaw`
            SELECT id FROM job
            WHERE company_id = ${ctx.companyId}::uuid AND id = ${current.queueJobId}::uuid
            FOR UPDATE
          `;
          await tx.$executeRaw`
            UPDATE job
            SET status = 'queued'::"job_status",
                attempts = 0,
                last_error = NULL,
                locked_by = NULL,
                locked_until = NULL,
                finished_at = NULL,
                run_after = clock_timestamp(),
                payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{releasedById}', to_jsonb(${actor}::text), true),
                updated_at = clock_timestamp()
            WHERE company_id = ${ctx.companyId}::uuid
              AND id = ${current.queueJobId}::uuid
          `;
        }
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'print_job.released',
          objectType: 'print_job',
          objectId: current.id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: { queueJobId: current.queueJobId },
        });
        return this.mustLoad(tx, ctx.companyId, id);
      });
      return { printJob };
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async cancel(
    ctx: RequestContext,
    id: string,
    meta: RequestMeta,
  ): Promise<{ printJob: PrintJobView }> {
    const actor = requireActor(ctx);
    try {
      const printJob = await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const jobId = this.jobId(id);
        const locked = await tx.$queryRaw<{ id: string; queueJobId: string | null }[]>`
          SELECT id, queue_job_id AS "queueJobId"
          FROM print_job
          WHERE company_id = ${ctx.companyId}::uuid
            AND id = ${jobId}::uuid
          FOR UPDATE
        `;
        const current = locked[0];
        if (!current) {
          throw new CommerceError(404, 'not_found', 'print_job', jobId, 'Not found');
        }
        const updated = await tx.$queryRaw<{ id: string }[]>`
          UPDATE print_job
          SET status = 'cancelled'::"print_job_status",
              updated_at = clock_timestamp()
          WHERE company_id = ${ctx.companyId}::uuid
            AND id = ${jobId}::uuid
            AND status::text = ANY(${[...CANCEL_FROM]})
          RETURNING id
        `;
        if (updated.length === 0) {
          throw new CommerceError(
            409,
            'print_not_cancellable',
            'print_job',
            jobId,
            'print_not_cancellable',
            'print_job.cancel',
          );
        }
        if (current.queueJobId) {
          await tx.$queryRaw`
            SELECT id FROM job
            WHERE company_id = ${ctx.companyId}::uuid AND id = ${current.queueJobId}::uuid
            FOR UPDATE
          `;
          await tx.$executeRaw`
            UPDATE job
            SET status = 'cancelled'::"job_status",
                finished_at = clock_timestamp(),
                locked_by = NULL,
                locked_until = NULL,
                updated_at = clock_timestamp()
            WHERE company_id = ${ctx.companyId}::uuid
              AND id = ${current.queueJobId}::uuid
              AND status::text = ANY(${['queued', 'held', 'uncertain']})
          `;
        }
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'print_job.cancelled',
          objectType: 'print_job',
          objectId: current.id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: { queueJobId: current.queueJobId },
        });
        return this.mustLoad(tx, ctx.companyId, id);
      });
      return { printJob };
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async listMappings(
    ctx: RequestContext,
    meta: RequestMeta,
  ): Promise<{
    mappings: {
      locationId: string;
      documentType: string;
      printerId: string;
      paperSize: string;
      copies: number;
    }[];
  }> {
    try {
      const mappings = await this.tenants.run(this.context(ctx), (tx) =>
        tx.printerMapping.findMany({
          where: { companyId: ctx.companyId },
          orderBy: [{ locationId: 'asc' }, { documentType: 'asc' }, { id: 'asc' }],
          select: {
            locationId: true,
            documentType: true,
            printerId: true,
            paperSize: true,
            copies: true,
          },
        }),
      );
      return { mappings };
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async printers(ctx: RequestContext, meta: RequestMeta): Promise<{ printers: PrinterView[] }> {
    try {
      const printers = await this.tenants.run(this.context(ctx), async (tx) => {
        const rows = await tx.printer.findMany({
          where: { companyId: ctx.companyId },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        });
        const allowed = this.allowedLocations(ctx);
        return rows
          .filter((row) => allowed === 'all' || allowed.has(row.locationId))
          .map(printerView);
      });
      return { printers };
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async discover(
    ctx: RequestContext,
    locationId: string | undefined,
    provider: PrintProviderName | undefined,
    meta: RequestMeta,
  ): Promise<{ printers: PrinterView[] }> {
    const actor = requireActor(ctx);
    try {
      const chosen = await this.chooseProvider(ctx.companyId, provider);
      let listed: readonly ListedPrinter[];
      try {
        listed = await this.providers.get(chosen).listPrinters({ companyId: ctx.companyId });
      } catch (error) {
        if (error instanceof ProviderRejected) {
          throw discoveryError(error);
        }
        throw error;
      }
      const printers = await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const locations = await this.discoverLocations(tx, ctx.companyId, locationId);
        const saved: PrinterView[] = [];
        for (const location of locations) {
          for (const printer of listed) {
            saved.push(await this.upsertPrinter(tx, ctx, location, printer, chosen));
          }
        }
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'printer.discovered',
          objectType: 'printer',
          objectId: null,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: {
            provider: chosen,
            locationIds: locations,
            count: saved.length,
          },
        });
        return saved;
      });
      return { printers };
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async putMapping(
    ctx: RequestContext,
    input: MappingInput,
    meta: RequestMeta,
  ): Promise<{
    mapping: {
      id: string;
      locationId: string;
      documentType: string;
      printerId: string;
      paperSize: string;
      copies: number;
    };
  }> {
    const actor = requireActor(ctx);
    const copies = input.copies ?? 1;
    try {
      const mapping = await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const location = await tx.location.findFirst({
          where: { id: input.locationId.toLowerCase(), companyId: ctx.companyId },
          select: { id: true },
        });
        if (!location) {
          throw new CommerceError(
            404,
            'not_found',
            'location',
            input.locationId.toLowerCase(),
            'Not found',
          );
        }
        const printer = await tx.printer.findFirst({
          where: { id: input.printerId.toLowerCase(), companyId: ctx.companyId },
        });
        if (!printer) {
          throw new CommerceError(
            404,
            'not_found',
            'printer',
            input.printerId.toLowerCase(),
            'Not found',
          );
        }
        if (!printer.paperSizes.includes(input.paperSize)) {
          throw new CommerceError(
            422,
            'paper_size_not_supported',
            'printer_mapping',
            printer.id,
            'paper_size_not_supported',
            'printer_mapping.updated',
            { paperSize: input.paperSize, paperSizes: printer.paperSizes },
          );
        }
        const saved = await tx.printerMapping.upsert({
          where: {
            companyId_locationId_documentType: {
              companyId: ctx.companyId,
              locationId: location.id,
              documentType: input.documentType,
            },
          },
          create: {
            companyId: ctx.companyId,
            locationId: location.id,
            documentType: input.documentType,
            printerId: printer.id,
            paperSize: input.paperSize,
            copies,
          },
          update: { printerId: printer.id, paperSize: input.paperSize, copies },
        });
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'printer_mapping.updated',
          objectType: 'printer_mapping',
          objectId: saved.id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: {
            locationId: location.id,
            documentType: input.documentType,
            printerId: printer.id,
            paperSize: input.paperSize,
            copies,
          },
        });
        return {
          id: saved.id,
          locationId: saved.locationId,
          documentType: saved.documentType,
          printerId: saved.printerId,
          paperSize: saved.paperSize,
          copies: saved.copies,
        };
      });
      return { mapping };
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  private async insertRequest(
    tx: TenantTransaction,
    ctx: RequestContext,
    actor: string,
    correlationId: string,
    input: PrintRequestInput,
    meta: RequestMeta,
  ): Promise<PrintJobView> {
    if (input.sourceType === 'invoice') {
      return this.insertInvoiceRequest(tx, ctx, actor, correlationId, input, meta);
    }
    const documentType = input.documentType;
    if (documentType !== 'packing_slip' && documentType !== 'gift_message') {
      throw new CommerceError(
        422,
        'document_not_printable',
        'print_job',
        null,
        'document_not_printable',
        'print_job.requested',
        { documentType },
      );
    }
    const orderId = input.sourceId.toLowerCase();
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM sales_order
      WHERE company_id = ${ctx.companyId}::uuid AND id = ${orderId}::uuid
      FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new CommerceError(404, 'not_found', 'sales_order', orderId, 'Not found');
    }
    const order = await tx.salesOrder.findFirst({
      where: { id: orderId, companyId: ctx.companyId },
      select: {
        id: true,
        version: true,
        externalNumber: true,
        deliveryMethod: true,
        giftMessage: true,
        recipient: true,
        storeId: true,
      },
    });
    if (!order) {
      throw new CommerceError(404, 'not_found', 'sales_order', orderId, 'Not found');
    }
    const store = await tx.store.findFirst({
      where: { id: order.storeId, companyId: ctx.companyId },
      select: { id: true, name: true, locationId: true },
    });
    if (!store) {
      throw new CommerceError(404, 'not_found', 'sales_order', orderId, 'Not found');
    }
    const company = await tx.company.findFirst({
      where: { id: ctx.companyId },
      select: { legalName: true, tradingName: true, documentLanguage: true },
    });
    if (!company) {
      throw new CommerceError(404, 'not_found', 'company', ctx.companyId, 'Not found');
    }
    const mapping = await tx.printerMapping.findFirst({
      where: {
        companyId: ctx.companyId,
        locationId: store.locationId,
        documentType: input.documentType,
      },
    });
    if (!mapping) {
      throw new CommerceError(
        422,
        'printer_not_mapped',
        'printer_mapping',
        null,
        'printer_not_mapped',
        'print_job.requested',
        { documentType: input.documentType, locationId: store.locationId },
      );
    }
    const printer = await tx.printer.findFirst({
      where: {
        id: (input.printerId ?? mapping.printerId).toLowerCase(),
        companyId: ctx.companyId,
      },
    });
    if (!printer) {
      throw new CommerceError(
        404,
        'not_found',
        'printer',
        input.printerId?.toLowerCase() ?? null,
        'Not found',
      );
    }
    if (!printer.paperSizes.includes(mapping.paperSize)) {
      throw new CommerceError(
        422,
        'paper_size_not_supported',
        'printer',
        printer.id,
        'paper_size_not_supported',
        'print_job.requested',
        { paperSize: mapping.paperSize, paperSizes: printer.paperSizes },
      );
    }
    const copies = input.copies ?? mapping.copies;
    if (!Number.isInteger(copies) || copies < 1 || copies > 5) {
      throw new CommerceError(
        422,
        'copies_not_allowed',
        'print_job',
        null,
        'copies_not_allowed',
        'print_job.requested',
      );
    }
    let reprintOfId: string | null = null;
    if (input.reprint) {
      const prior = await tx.printJob.findFirst({
        where: { id: input.reprint.ofPrintJobId.toLowerCase(), companyId: ctx.companyId },
        select: { id: true, sourceType: true, sourceId: true, documentType: true },
      });
      if (
        !prior ||
        prior.sourceType !== 'order' ||
        prior.sourceId !== order.id ||
        prior.documentType !== input.documentType
      ) {
        throw new CommerceError(
          404,
          'not_found',
          'print_job',
          input.reprint.ofPrintJobId.toLowerCase(),
          'Not found',
        );
      }
      reprintOfId = prior.id;
    }
    const lines = await tx.salesOrderLine.findMany({
      where: { companyId: ctx.companyId, orderId: order.id },
      orderBy: { id: 'asc' },
      select: { sku: true, title: true, variantTitle: true, quantity: true },
    });
    const template =
      documentType === 'gift_message' ? await this.loadTemplate(tx, ctx.companyId) : null;
    const rendered = await this.render(documentType, order, store.name, company, lines, template);
    if (rendered.review) {
      throw new CommerceError(
        422,
        'gift_message_needs_review',
        'print_job',
        order.id,
        'gift_message_needs_review',
        'print_job.requested',
        { fits: rendered.review.fits, unsupportedChars: rendered.review.unsupportedChars },
      );
    }
    const printJobId = uuidv7();
    const fileId = uuidv7();
    const at = new Date();
    const key = storageKey({
      companyId: ctx.companyId,
      kind: documentType,
      id: fileId,
      at,
    });
    const job: NewPrintJob = {
      printJobId,
      printerId: printer.id,
      documentType,
      sourceType: 'order',
      sourceId: order.id,
      sourceVersion: order.version,
      copies,
      paperSize: mapping.paperSize,
      reprintOfId,
      reprintReason: input.reprint?.reason ?? null,
    };
    await this.insertPrintJob(tx, ctx.companyId, actor, correlationId, job);
    await this.storage.put(key, rendered.pdf);
    const digest = createHash('sha256').update(rendered.pdf).digest('hex');
    await tx.storedFile.create({
      data: {
        id: fileId,
        companyId: ctx.companyId,
        kind: documentType,
        storageKey: key,
        contentType: 'application/pdf',
        sizeBytes: rendered.pdf.length,
        sha256: digest,
        sourceType: 'order',
        sourceId: order.id,
        sourceVersion: order.version,
        createdById: actor,
      },
    });
    await this.attachAndQueue(tx, ctx.companyId, actor, correlationId, job, fileId, input);
    await this.audit.record(tx, {
      companyId: ctx.companyId,
      actorType: 'user',
      actorId: actor,
      actorLabel: ctx.actorLabel,
      action: 'print_job.requested',
      objectType: 'print_job',
      objectId: printJobId,
      outcome: 'success',
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: {
        documentType: input.documentType,
        sourceId: order.id,
        sourceVersion: order.version,
        copies,
        paperSize: mapping.paperSize,
        printerId: printer.id,
        isReprint: input.reprint != null,
        reprintOfId,
        provider: printer.provider,
      },
    });
    return this.mustLoad(tx, ctx.companyId, printJobId);
  }

  /**
   * Queues an issued document's sealed PDF. Nothing is rendered: the stored file is the
   * legal document, and the processor verifies it before sending. Paper delivery (a client
   * who has not accepted e-invoices) prints two copies by default: one for the client and
   * one for the company's file (reg. 11Γ(4)).
   */
  private async insertInvoiceRequest(
    tx: TenantTransaction,
    ctx: RequestContext,
    actor: string,
    correlationId: string,
    input: PrintRequestInput,
    meta: RequestMeta,
  ): Promise<PrintJobView> {
    const invoiceId = input.sourceId.toLowerCase();
    if (input.documentType !== 'invoice') {
      throw new CommerceError(
        422,
        'document_not_printable',
        'print_job',
        null,
        'document_not_printable',
        'print_job.requested',
        { documentType: input.documentType },
      );
    }
    if (!can(ctx.grants, 'invoice.view')) {
      throw new CommerceError(403, 'permission_missing', 'invoice', invoiceId, 'Forbidden');
    }
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, companyId: ctx.companyId },
      select: { id: true, status: true, version: true, pdfFileId: true, clientId: true },
    });
    if (!invoice) {
      throw new CommerceError(404, 'not_found', 'invoice', invoiceId, 'Not found');
    }
    if (invoice.status !== 'issued' || !invoice.pdfFileId) {
      throw new CommerceError(
        409,
        'not_issued',
        'invoice',
        invoice.id,
        'Only an issued document is printed.',
        'print_job.requested',
      );
    }
    const mappings = await tx.printerMapping.findMany({
      where: {
        companyId: ctx.companyId,
        documentType: 'invoice',
        ...(input.locationId ? { locationId: input.locationId.toLowerCase() } : {}),
      },
      orderBy: { id: 'asc' },
    });
    const mapping = mappings[0];
    if (!mapping) {
      throw new CommerceError(
        422,
        'printer_not_mapped',
        'printer_mapping',
        null,
        'printer_not_mapped',
        'print_job.requested',
        { documentType: 'invoice', locationId: input.locationId?.toLowerCase() ?? null },
      );
    }
    if (mappings.length > 1) {
      throw new CommerceError(
        422,
        'location_required',
        'printer_mapping',
        null,
        'Several locations print invoices. Choose one.',
        'print_job.requested',
      );
    }
    const printer = await tx.printer.findFirst({
      where: { id: (input.printerId ?? mapping.printerId).toLowerCase(), companyId: ctx.companyId },
    });
    if (!printer) {
      throw new CommerceError(
        404,
        'not_found',
        'printer',
        input.printerId?.toLowerCase() ?? null,
        'Not found',
      );
    }
    if (!printer.paperSizes.includes(mapping.paperSize)) {
      throw new CommerceError(
        422,
        'paper_size_not_supported',
        'printer',
        printer.id,
        'paper_size_not_supported',
        'print_job.requested',
        { paperSize: mapping.paperSize, paperSizes: printer.paperSizes },
      );
    }
    const client = await tx.client.findFirst({
      where: { id: invoice.clientId, companyId: ctx.companyId },
      select: { acceptsEInvoices: true },
    });
    const paperDelivery = client?.acceptsEInvoices !== true;
    // Paper delivery: one copy for the client, one for the company's file. No more by default.
    const copies = input.copies ?? (paperDelivery ? 2 : mapping.copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > 5) {
      throw new CommerceError(
        422,
        'copies_not_allowed',
        'print_job',
        null,
        'copies_not_allowed',
        'print_job.requested',
      );
    }
    let reprintOfId: string | null = null;
    if (input.reprint) {
      const prior = await tx.printJob.findFirst({
        where: { id: input.reprint.ofPrintJobId.toLowerCase(), companyId: ctx.companyId },
        select: { id: true, sourceType: true, sourceId: true, documentType: true },
      });
      if (
        !prior ||
        prior.sourceType !== 'invoice' ||
        prior.sourceId !== invoice.id ||
        prior.documentType !== 'invoice'
      ) {
        throw new CommerceError(
          404,
          'not_found',
          'print_job',
          input.reprint.ofPrintJobId.toLowerCase(),
          'Not found',
        );
      }
      reprintOfId = prior.id;
    }
    const printJobId = uuidv7();
    const job: NewPrintJob = {
      printJobId,
      printerId: printer.id,
      documentType: 'invoice',
      sourceType: 'invoice',
      sourceId: invoice.id,
      sourceVersion: invoice.version,
      copies,
      paperSize: mapping.paperSize,
      reprintOfId,
      reprintReason: input.reprint?.reason ?? null,
    };
    await this.insertPrintJob(tx, ctx.companyId, actor, correlationId, job);
    await this.attachAndQueue(
      tx,
      ctx.companyId,
      actor,
      correlationId,
      job,
      invoice.pdfFileId,
      input,
    );
    await this.audit.record(tx, {
      companyId: ctx.companyId,
      actorType: 'user',
      actorId: actor,
      actorLabel: ctx.actorLabel,
      action: 'print_job.requested',
      objectType: 'print_job',
      objectId: printJobId,
      outcome: 'success',
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: {
        documentType: 'invoice',
        sourceType: 'invoice',
        sourceId: invoice.id,
        sourceVersion: invoice.version,
        copies,
        paperDelivery,
        paperSize: mapping.paperSize,
        printerId: printer.id,
        isReprint: input.reprint != null,
        reprintOfId,
        provider: printer.provider,
      },
    });
    return this.mustLoad(tx, ctx.companyId, printJobId);
  }

  /** One `print_job` row, queued, with no file yet. Shared by orders and invoices. */
  private async insertPrintJob(
    tx: TenantTransaction,
    companyId: string,
    actor: string,
    correlationId: string,
    job: NewPrintJob,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO print_job (
        id, company_id, printer_id, document_type, source_type, source_id, source_version,
        copies, paper_size, status, is_reprint, reprint_of_id, reprint_reason, idempotency_key,
        requested_by, correlation_id, created_at, updated_at
      ) VALUES (
        ${job.printJobId}::uuid,
        ${companyId}::uuid,
        ${job.printerId}::uuid,
        ${job.documentType}::"print_document_type",
        ${job.sourceType}::"print_source_type",
        ${job.sourceId}::uuid,
        ${job.sourceVersion},
        ${job.copies},
        ${job.paperSize},
        'queued'::"print_job_status",
        ${job.reprintOfId !== null},
        ${job.reprintOfId}::uuid,
        ${job.reprintReason},
        ${`pj_${job.printJobId}`},
        ${actor}::uuid,
        ${correlationId},
        clock_timestamp(),
        clock_timestamp()
      )
    `;
  }

  /** Points the job at its file and queues one `print.submit`. */
  private async attachAndQueue(
    tx: TenantTransaction,
    companyId: string,
    actor: string,
    correlationId: string,
    job: NewPrintJob,
    fileId: string,
    input: PrintRequestInput,
  ): Promise<void> {
    const queueJobId = uuidv7();
    await tx.$executeRaw`
      UPDATE print_job
      SET file_id = ${fileId}::uuid, updated_at = clock_timestamp()
      WHERE company_id = ${companyId}::uuid AND id = ${job.printJobId}::uuid
    `;
    const payload = JSON.stringify({
      printJobId: job.printJobId,
      requestedById: actor,
      releasedById: null,
      isReprint: input.reprint != null,
    });
    await tx.$executeRaw`
      INSERT INTO job (
        id, company_id, type, payload, status, attempts, max_attempts, run_after,
        timeout_ms, correlation_id, idempotency_key, created_at, updated_at
      ) VALUES (
        ${queueJobId}::uuid,
        ${companyId}::uuid,
        'print.submit',
        ${payload}::jsonb,
        'queued'::"job_status",
        0,
        ${SUBMIT_ATTEMPTS},
        clock_timestamp(),
        ${SUBMIT_TIMEOUT_MS},
        ${correlationId},
        ${`print.submit:${job.printJobId}`},
        clock_timestamp(),
        clock_timestamp()
      )
    `;
    await tx.$executeRaw`
      UPDATE print_job
      SET queue_job_id = ${queueJobId}::uuid, updated_at = clock_timestamp()
      WHERE company_id = ${companyId}::uuid AND id = ${job.printJobId}::uuid
    `;
  }

  private async loadTemplate(
    tx: TenantTransaction,
    companyId: string,
  ): Promise<GiftMessageTemplate> {
    const row = await tx.giftMessageTemplate.findFirst({
      where: { companyId, isDefault: true },
      orderBy: { id: 'asc' },
    });
    if (!row) {
      throw new CommerceError(
        404,
        'template_not_found',
        'gift_message_template',
        null,
        'Not found',
      );
    }
    return {
      pageWidthMm: fixed(row.pageWidthMm, 2),
      pageHeightMm: fixed(row.pageHeightMm, 2),
      marginTopMm: fixed(row.marginTopMm, 2),
      marginRightMm: fixed(row.marginRightMm, 2),
      marginBottomMm: fixed(row.marginBottomMm, 2),
      marginLeftMm: fixed(row.marginLeftMm, 2),
      fontSizePt: fixed(row.fontSizePt, 2),
      minFontSizePt: fixed(row.minFontSizePt, 2),
      lineHeight: fixed(row.lineHeight, 3),
      align: row.align,
      verticalAlign: row.verticalAlign,
    };
  }

  private async render(
    documentType: PrintDocumentType,
    order: {
      externalNumber: string;
      deliveryMethod: string;
      giftMessage: string | null;
      recipient: unknown;
    },
    storeName: string,
    company: { legalName: string; tradingName: string; documentLanguage: string },
    lines: {
      sku: string | null;
      title: string;
      variantTitle: string | null;
      quantity: { toFixed(digits: number): string };
    }[],
    template: GiftMessageTemplate | null,
  ): Promise<{ pdf: Buffer; review: { fits: boolean; unsupportedChars: string[] } | null }> {
    if (documentType === 'gift_message') {
      if (order.giftMessage === null) {
        throw new CommerceError(404, 'gift_message_missing', 'sales_order', null, 'Not found');
      }
      if (!template) {
        throw new CommerceError(
          404,
          'template_not_found',
          'gift_message_template',
          null,
          'Not found',
        );
      }
      const card = await renderGiftMessage(order.giftMessage, template);
      if (!card.fits || card.unsupportedChars.length > 0) {
        return {
          pdf: card.pdf,
          review: { fits: card.fits, unsupportedChars: card.unsupportedChars },
        };
      }
      return { pdf: card.pdf, review: null };
    }
    const recipient = recipientOf(order.recipient);
    const language: DocumentLanguage = company.documentLanguage === 'el' ? 'el' : 'en';
    const pdf = await renderPackingSlip(
      {
        orderNumber: order.externalNumber,
        storeName,
        deliveryMethod: order.deliveryMethod,
        recipientName: recipient.name,
        recipientLines: recipient.lines,
        items: lines.map((line) => ({
          sku: line.sku,
          title: line.title,
          variantTitle: line.variantTitle,
          quantity: fixed(line.quantity, 4),
        })),
        hasGiftMessage: order.giftMessage !== null,
      },
      { legalName: company.legalName, tradingName: company.tradingName },
      language,
    );
    return { pdf, review: null };
  }

  private async existingFirstPrint(
    ctx: RequestContext,
    actor: string,
    correlationId: string,
    input: PrintRequestInput,
  ): Promise<string | null> {
    return this.tenants.run(this.context(ctx, actor, correlationId), async (tx) => {
      const row = await tx.printJob.findFirst({
        where: {
          companyId: ctx.companyId,
          sourceType: input.sourceType,
          sourceId: input.sourceId.toLowerCase(),
          documentType: input.documentType,
          isReprint: false,
          status: { notIn: [...FIRST_PRINT_RELEASED_STATUSES] },
        },
        select: { id: true },
      });
      return row?.id ?? null;
    });
  }

  private listWhere(
    companyId: string,
    query: { status?: string; sourceId?: string },
    scope: { kind: 'all' } | { kind: 'ids'; storeIds: string[]; locationIds: string[] },
  ): Prisma.Sql {
    const status = query.status ?? null;
    const sourceId = query.sourceId ?? null;
    const scopeSql =
      scope.kind === 'all' ? Prisma.sql`TRUE` : scopeFilter(scope.storeIds, scope.locationIds);
    return Prisma.sql`
      pj.company_id = ${companyId}::uuid
      AND (${status}::text IS NULL OR pj.status::text = ${status})
      AND (${sourceId}::uuid IS NULL OR pj.source_id = ${sourceId}::uuid)
      AND ${scopeSql}
    `;
  }

  private listScope(
    ctx: RequestContext,
  ):
    | { kind: 'all' }
    | { kind: 'none' }
    | { kind: 'ids'; storeIds: string[]; locationIds: string[] } {
    if (can(ctx.grants, 'automation.view') || can(ctx.grants, 'print.submit')) {
      return { kind: 'all' };
    }
    const stores = permittedScopeFilter(ctx.grants, 'print.submit', 'store');
    const locations = permittedScopeFilter(ctx.grants, 'print.submit', 'location');
    const storeIds = stores.kind === 'ids' ? [...stores.ids] : [];
    // Location ids come only from location grants. A store grant does not add that store's location.
    const locationIds = locations.kind === 'ids' ? [...locations.ids] : [];
    if (storeIds.length === 0 && locationIds.length === 0) {
      return { kind: 'none' };
    }
    return { kind: 'ids', storeIds, locationIds };
  }

  private allowedLocations(ctx: RequestContext): 'all' | Set<string> {
    if (can(ctx.grants, 'printer.manage') || can(ctx.grants, 'print.submit')) {
      return 'all';
    }
    const locations = permittedScopeFilter(ctx.grants, 'print.submit', 'location');
    if (locations.kind !== 'ids') {
      return new Set();
    }
    return new Set(locations.ids);
  }

  private async discoverLocations(
    tx: TenantTransaction,
    companyId: string,
    locationId: string | undefined,
  ): Promise<string[]> {
    if (locationId) {
      const location = await tx.location.findFirst({
        where: { id: locationId.toLowerCase(), companyId },
        select: { id: true },
      });
      if (!location) {
        throw new CommerceError(
          404,
          'not_found',
          'location',
          locationId.toLowerCase(),
          'Not found',
        );
      }
      return [location.id];
    }
    const rows = await tx.location.findMany({
      where: { companyId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => row.id);
  }

  private async chooseProvider(
    companyId: string,
    requested: PrintProviderName | undefined,
  ): Promise<PrintProviderName> {
    if (requested) {
      if (!this.providers.available().includes(requested)) {
        throw new CommerceError(
          400,
          'print_provider_unavailable',
          'printer',
          null,
          'print_provider_unavailable',
          'printer.discovered',
        );
      }
      return requested;
    }
    if (await this.printNodeKeys.hasUsableKey(companyId)) {
      return 'printnode';
    }
    if (this.providers.available().includes('mock')) {
      return 'mock';
    }
    throw new CommerceError(
      409,
      'print_provider_not_configured',
      'printer',
      null,
      'print_provider_not_configured',
      'printer.discovered',
    );
  }

  private async upsertPrinter(
    tx: TenantTransaction,
    ctx: RequestContext,
    locationId: string,
    printer: ListedPrinter,
    provider: PrintProviderName,
  ): Promise<PrinterView> {
    const saved = await tx.printer.upsert({
      where: {
        companyId_provider_externalPrinterId: {
          companyId: ctx.companyId,
          provider,
          externalPrinterId: printer.externalPrinterId,
        },
      },
      create: {
        companyId: ctx.companyId,
        locationId,
        provider,
        externalPrinterId: printer.externalPrinterId,
        name: printer.name,
        description: printer.description,
        paperSizes: [...printer.paperSizes],
        status: printer.status,
        lastSeenAt: new Date(),
      },
      update: {
        locationId,
        name: printer.name,
        description: printer.description,
        paperSizes: [...printer.paperSizes],
        status: printer.status,
        lastSeenAt: new Date(),
      },
    });
    return printerView(saved);
  }

  private jobId(id: string): string {
    if (!isUuid(id)) {
      throw new CommerceError(404, 'not_found', 'print_job', null, 'Not found');
    }
    return id.toLowerCase();
  }

  private async mustLoad(
    tx: TenantTransaction,
    companyId: string,
    id: string,
  ): Promise<PrintJobView> {
    const job = await this.loadJob(tx, companyId, id);
    if (!job) {
      throw new CommerceError(404, 'not_found', 'print_job', id.toLowerCase(), 'Not found');
    }
    return job;
  }

  private async loadJob(
    tx: TenantTransaction,
    companyId: string,
    id: string,
  ): Promise<PrintJobView | null> {
    if (!isUuid(id)) {
      return null;
    }
    const row = await tx.printJob.findFirst({
      where: { id: id.toLowerCase(), companyId },
      include: { printer: { select: { provider: true } } },
    });
    return row ? jobView(row) : null;
  }

  private context(
    ctx: RequestContext,
    actor = requireActor(ctx),
    correlationId = this.correlation(),
  ) {
    return { companyId: ctx.companyId, actor, correlationId };
  }

  private correlation(): string {
    const correlationId = getCorrelationId();
    if (!correlationId) {
      throw new Error('correlation id is missing');
    }
    return correlationId;
  }

  private fail(ctx: RequestContext, meta: RequestMeta, error: unknown): Promise<never> {
    if (error instanceof CommerceError) {
      return settleCommerceError(this.audit, this.prisma, ctx, meta, error);
    }
    throw error;
  }
}

function printJobCapabilities(
  grants: RequestContext['grants'],
  sourceType: string,
  storeId: string | null,
  locationId: string | null,
): { cancel: boolean; release: boolean } {
  const scopes =
    sourceType === 'order' && storeId && locationId
      ? orderScopes(storeId, locationId)
      : [{ type: 'company' as const, id: null }];
  return {
    cancel: can(grants, 'print.submit', scopes),
    release: can(grants, 'automation.replay', scopes),
  };
}

function jobView(row: PrintRow): PrintJobView {
  const mock = row.printer.provider === 'mock';
  return {
    id: row.id,
    documentType: row.documentType,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    copies: row.copies,
    paperSize: row.paperSize,
    status: row.status,
    label: printJobLabel(row.status),
    provider: row.printer.provider,
    simulationLabel: mock ? SIMULATED_PRINTING_LABEL : null,
    isReprint: row.isReprint,
    reprintOfId: row.reprintOfId,
    reprintReason: row.reprintReason,
    providerJobId: row.providerJobId,
    providerState: row.providerState,
    lastError: row.lastError,
    fileId: row.fileId,
    requestedById: row.requestedById,
    queueJobId: row.queueJobId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
  };
}

function printerView(row: {
  id: string;
  locationId: string;
  provider: string;
  externalPrinterId: string;
  name: string;
  description: string | null;
  paperSizes: string[];
  status: string;
  lastSeenAt: Date | null;
}): PrinterView {
  return {
    id: row.id,
    locationId: row.locationId,
    provider: row.provider,
    externalPrinterId: row.externalPrinterId,
    name: row.name,
    description: row.description,
    paperSizes: row.paperSizes,
    status: row.status,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    simulationLabel: row.provider === 'mock' ? SIMULATED_PRINTING_LABEL : null,
  };
}

function discoveryError(error: ProviderRejected): CommerceError {
  if (error.message === 'not_configured') {
    return new CommerceError(
      409,
      'print_provider_not_configured',
      'printer',
      null,
      'print_provider_not_configured',
      'printer.discovered',
    );
  }
  return new CommerceError(
    422,
    error.message,
    'printer',
    null,
    error.message,
    'printer.discovered',
  );
}

function recipientOf(value: unknown): { name: string; lines: string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { name: '', lines: [] };
  }
  const record = value as Record<string, unknown>;
  const first = stringField(record, 'firstName');
  const last = stringField(record, 'lastName');
  const name = first.length > 0 && last.length > 0 ? `${first} ${last}` : `${first}${last}`;
  const lines: string[] = [];
  for (const key of ['address1', 'address2'] as const) {
    const line = stringField(record, key);
    if (line.length > 0) {
      lines.push(line);
    }
  }
  const place = [stringField(record, 'zip'), stringField(record, 'city')]
    .filter((part) => part.length > 0)
    .join(' ');
  if (place.length > 0) {
    lines.push(place);
  }
  const country = stringField(record, 'countryCodeV2');
  if (country.length > 0) {
    lines.push(country);
  }
  const phone = stringField(record, 'phone');
  if (phone.length > 0) {
    lines.push(phone);
  }
  return { name, lines };
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function includesStatus(allowed: readonly string[], status: string): boolean {
  return allowed.includes(status);
}

function scopeFilter(storeIds: string[], locationIds: string[]): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (storeIds.length > 0) {
    parts.push(Prisma.sql`o.store_id::text IN (${Prisma.join(storeIds)})`);
  }
  if (locationIds.length > 0) {
    parts.push(Prisma.sql`s.location_id::text IN (${Prisma.join(locationIds)})`);
  }
  if (parts.length === 0) {
    return Prisma.sql`FALSE`;
  }
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

function isFirstPrintConflict(error: unknown): boolean {
  return errorText(error).includes('print_job_one_first_print_key');
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value == null || seen.has(value)) {
      return;
    }
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (typeof value !== 'object') {
      return;
    }
    seen.add(value);
    if (value instanceof Error) {
      parts.push(value.message);
      visit(value.cause, depth + 1);
    }
    for (const nested of Object.values(value)) {
      visit(nested, depth + 1);
    }
  };
  visit(error, 0);
  return parts.join('\n');
}
