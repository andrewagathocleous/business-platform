import { Inject, Injectable } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { type CreditLineRequest, type DocumentTotals } from '@bp/domain';
import { AuditService } from '../audit/audit.service';
import { isUuid } from '../authz/company-path';
import type { RequestContext } from '../authz/request-context';
import { CommerceError, settleCommerceError } from '../commerce/errors';
import { decimalField, fixed } from '../commerce/format';
import { requireActor } from '../commerce/http';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';
import { creditTotals, type Original } from './credit-totals';
import { creditedQuantitiesOf, InvoiceService, type InvoiceDetail } from './invoice.service';

export type CreditNoteCreate = {
  reason: string;
  full?: boolean;
  lines?: { invoiceLineId: string; quantity: unknown }[];
};

export type CreditNotePatch = {
  expectedVersion: number;
  reason?: string;
  lines?: { id: string; quantity: unknown }[];
};

/**
 * Credit-note drafts (docs/plan/release-2.md, R2-D). A draft credits an issued invoice: its
 * client, currency, pricing, prices, discounts and rates all come from the original, and only
 * the reason and the quantities change. Amounts follow calculateCreditTotals against what
 * issued credit notes have already credited; issuing checks them again under the locks.
 */
@Injectable()
export class CreditNoteService {
  private readonly tenants: TenantDb;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(InvoiceService) private readonly invoices: InvoiceService,
  ) {
    this.tenants = new TenantDb(prisma.client);
  }

  async create(
    ctx: RequestContext,
    invoiceId: string,
    input: CreditNoteCreate,
    meta: RequestMeta,
  ): Promise<InvoiceDetail> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const companyId = ctx.companyId;
        const original = await this.original(tx, companyId, invoiceId);
        const before = await creditedQuantitiesOf(tx, companyId, original.id);
        const requests = input.full
          ? fullCredit(original, before)
          : requested(original, input.lines ?? []);
        const totals = creditTotals(original, before, requests, {
          action: 'credit_note.created',
          objectId: original.id,
        });
        const created = await tx.invoice.create({
          data: {
            companyId,
            documentType: 'credit_note',
            status: 'draft',
            clientId: original.clientId,
            currency: original.currency,
            language: original.language,
            pricesIncludeTax: original.pricesIncludeTax,
            creditedInvoiceId: original.id,
            creditReason: input.reason,
            ...moneyFields(totals),
            createdById: actor,
          },
        });
        await this.writeLines(tx, companyId, created.id, original, requests, totals);
        await this.audit.record(tx, {
          companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'credit_note.created',
          objectType: 'invoice',
          objectId: created.id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: {
            creditedInvoiceId: original.id,
            total: totals.total,
            version: created.version,
          },
        });
        return this.invoices.detail(tx, companyId, created.id);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async update(
    ctx: RequestContext,
    creditNoteId: string,
    patch: CreditNotePatch,
    meta: RequestMeta,
  ): Promise<InvoiceDetail> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const companyId = ctx.companyId;
        if (!isUuid(creditNoteId)) {
          throw new CommerceError(404, 'invoice_not_found', 'invoice', null, 'Not found');
        }
        const id = creditNoteId.toLowerCase();
        const current = await tx.invoice.findFirst({
          where: { id, companyId, documentType: 'credit_note' },
          include: { lines: { orderBy: { position: 'asc' } } },
        });
        if (!current?.creditedInvoiceId) {
          throw new CommerceError(404, 'invoice_not_found', 'invoice', id, 'Not found');
        }
        if (current.status !== 'draft') {
          throw new CommerceError(
            409,
            'not_draft',
            'invoice',
            id,
            'Only a draft credit note is edited.',
            'credit_note.updated',
          );
        }
        if (current.version !== patch.expectedVersion) {
          throw new CommerceError(
            409,
            'version_conflict',
            'invoice',
            id,
            'version conflict',
            'credit_note.updated',
          );
        }
        const quantities = new Map(current.lines.map((line) => [line.id, fixed(line.quantity, 4)]));
        for (const change of patch.lines ?? []) {
          const lineId = change.id.toLowerCase();
          if (!quantities.has(lineId)) {
            throw new CommerceError(
              422,
              'invalid_credit_line',
              'invoice',
              id,
              'A credit note keeps its lines; only their quantities change.',
              'credit_note.updated',
            );
          }
          quantities.set(lineId, decimalField(change.quantity, 4, 'quantity'));
        }
        const original = await this.original(tx, companyId, current.creditedInvoiceId);
        const before = await creditedQuantitiesOf(tx, companyId, original.id);
        const requests: CreditLineRequest[] = current.lines.map((line) => ({
          position: line.position,
          sourceKey: line.creditedLineId ?? '',
          quantity: quantities.get(line.id) ?? fixed(line.quantity, 4),
        }));
        const totals = creditTotals(original, before, requests, {
          action: 'credit_note.updated',
          objectId: id,
        });
        const written = await tx.invoice.updateMany({
          where: { id, companyId, status: 'draft', version: patch.expectedVersion },
          data: {
            ...(patch.reason !== undefined ? { creditReason: patch.reason } : {}),
            ...moneyFields(totals),
            updatedById: actor,
            version: { increment: 1 },
          },
        });
        if (written.count !== 1) {
          throw new CommerceError(
            409,
            'version_conflict',
            'invoice',
            id,
            'version conflict',
            'credit_note.updated',
          );
        }
        const amounts = new Map(totals.lines.map((line) => [line.position, line]));
        for (const line of current.lines) {
          const computed = amounts.get(line.position);
          if (!computed) {
            throw new Error('credit line totals are missing');
          }
          await tx.invoiceLine.update({
            where: { id: line.id },
            data: {
              quantity: quantities.get(line.id) ?? fixed(line.quantity, 4),
              lineSubtotal: computed.lineSubtotal,
              lineDiscount: computed.lineDiscount,
              lineNet: computed.lineNet,
              lineGross: computed.lineGross,
            },
          });
        }
        await tx.invoiceTaxSummary.deleteMany({ where: { companyId, invoiceId: id } });
        await this.writeSummary(tx, companyId, id, original, totals);
        const saved = await this.invoices.detail(tx, companyId, id);
        await this.audit.record(tx, {
          companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'credit_note.updated',
          objectType: 'invoice',
          objectId: id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: { version: saved.version, total: saved.total },
        });
        return saved;
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  private context(ctx: RequestContext, actor: string) {
    return { companyId: ctx.companyId, actor, correlationId: ctx.correlationId };
  }

  /** The issued invoice being credited, with its lines. */
  private async original(
    tx: TenantTransaction,
    companyId: string,
    invoiceId: string,
  ): Promise<Original> {
    if (!isUuid(invoiceId)) {
      throw new CommerceError(404, 'invoice_not_found', 'invoice', null, 'Not found');
    }
    const id = invoiceId.toLowerCase();
    const row = await tx.invoice.findFirst({
      where: { id, companyId },
      include: { lines: { orderBy: { position: 'asc' } } },
    });
    if (!row) {
      throw new CommerceError(404, 'invoice_not_found', 'invoice', id, 'Not found');
    }
    if (row.documentType !== 'invoice') {
      throw new CommerceError(
        409,
        'not_creditable',
        'invoice',
        id,
        'Only an invoice is credited.',
        'credit_note.created',
      );
    }
    if (row.status !== 'issued') {
      throw new CommerceError(
        409,
        'not_issued',
        'invoice',
        id,
        'Only an issued invoice is credited.',
        'credit_note.created',
      );
    }
    return row;
  }

  private async writeLines(
    tx: TenantTransaction,
    companyId: string,
    creditNoteId: string,
    original: Original,
    requests: CreditLineRequest[],
    totals: DocumentTotals,
  ): Promise<void> {
    const sources = new Map(original.lines.map((line) => [line.id, line]));
    const amounts = new Map(totals.lines.map((line) => [line.position, line]));
    await tx.invoiceLine.createMany({
      data: requests.map((request) => {
        const source = sources.get(request.sourceKey);
        const computed = amounts.get(request.position);
        if (!source || !computed) {
          throw new Error('credit line source or totals are missing');
        }
        return {
          companyId,
          invoiceId: creditNoteId,
          position: request.position,
          kind: source.kind,
          productId: source.productId,
          description: source.description,
          quantity: request.quantity,
          unit: source.unit,
          unitPrice: fixed(source.unitPrice, 4),
          discountPercent: fixed(source.discountPercent, 2),
          taxCodeId: source.taxCodeId,
          taxRatePercent: fixed(source.taxRatePercent, 4),
          lineSubtotal: computed.lineSubtotal,
          lineDiscount: computed.lineDiscount,
          lineNet: computed.lineNet,
          lineGross: computed.lineGross,
          creditedLineId: source.id,
        };
      }),
    });
    await this.writeSummary(tx, companyId, creditNoteId, original, totals);
  }

  /** Groups are keyed by tax code id, so each row names the original's code. */
  private async writeSummary(
    tx: TenantTransaction,
    companyId: string,
    creditNoteId: string,
    original: Original,
    totals: DocumentTotals,
  ): Promise<void> {
    const rates = new Map(original.lines.map((line) => [line.taxCodeId, line.taxRatePercent]));
    await tx.invoiceTaxSummary.createMany({
      data: totals.taxSummary.map((group) => {
        const rate = rates.get(group.taxCode);
        if (!rate) {
          throw new Error('credit tax group has no original code');
        }
        return {
          companyId,
          invoiceId: creditNoteId,
          taxCodeId: group.taxCode,
          taxRatePercent: fixed(rate, 4),
          net: group.net,
          tax: group.tax,
          gross: group.gross,
        };
      }),
    });
  }

  private fail(ctx: RequestContext, meta: RequestMeta, error: unknown): Promise<never> {
    if (error instanceof CommerceError) {
      return settleCommerceError(this.audit, this.prisma, ctx, meta, error);
    }
    throw error;
  }
}

/** Everything not yet credited by issued credit notes, line by line. */
function fullCredit(original: Original, before: ReadonlyMap<string, string>): CreditLineRequest[] {
  const requests: CreditLineRequest[] = [];
  for (const line of original.lines) {
    const remaining = subtractQuantity(fixed(line.quantity, 4), before.get(line.id) ?? '0');
    if (remaining !== null) {
      requests.push({ position: requests.length + 1, sourceKey: line.id, quantity: remaining });
    }
  }
  if (requests.length === 0) {
    throw new CommerceError(
      409,
      'nothing_to_credit',
      'invoice',
      original.id,
      'Everything on this invoice has been credited.',
      'credit_note.created',
    );
  }
  return requests;
}

function requested(
  original: Original,
  lines: readonly { invoiceLineId: string; quantity: unknown }[],
): CreditLineRequest[] {
  const known = new Set(original.lines.map((line) => line.id));
  return lines.map((line, index) => {
    const sourceKey = line.invoiceLineId.toLowerCase();
    if (!known.has(sourceKey)) {
      throw new CommerceError(
        422,
        'invalid_credit_line',
        'invoice',
        original.id,
        'A credit line must name a line of the invoice it credits.',
        'credit_note.created',
      );
    }
    return {
      position: index + 1,
      sourceKey,
      quantity: decimalField(line.quantity, 4, 'quantity'),
    };
  });
}

/** quantity − credited, or null when nothing is left. Both have at most 4 decimals. */
function subtractQuantity(quantity: string, credited: string): string | null {
  const scale = 10_000n;
  const left = toUnits(quantity, scale) - toUnits(credited, scale);
  if (left <= 0n) {
    return null;
  }
  const whole = left / scale;
  const part = (left % scale).toString().padStart(4, '0');
  return `${whole.toString()}.${part}`;
}

function toUnits(value: string, scale: bigint): bigint {
  const [whole = '0', part = ''] = value.split('.');
  return BigInt(whole) * scale + BigInt(part.padEnd(4, '0').slice(0, 4));
}

function moneyFields(totals: DocumentTotals) {
  return {
    subtotal: totals.subtotal,
    discountTotal: totals.discountTotal,
    netTotal: totals.netTotal,
    taxTotal: totals.taxTotal,
    total: totals.total,
  };
}
