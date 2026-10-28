import { Inject, Injectable } from '@nestjs/common';
import { Prisma, TenantDb, type TenantTransaction } from '@bp/db';
import {
  allocationEffectiveOn,
  businessDateInZone,
  parseAmount,
  refundAllowed,
  sourceRemaining,
  type DatedAmount,
  type DatedSettlementSource,
} from '@bp/domain';
import { AuditService } from '../audit/audit.service';
import { isUuid } from '../authz/company-path';
import type { RequestContext } from '../authz/request-context';
import { CommerceError, settleCommerceError } from '../commerce/errors';
import { decimalField, fixed, formatDateOnly, parseDateOnly } from '../commerce/format';
import { requireActor } from '../commerce/http';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';
import { idempotencyKey, idempotent } from './idempotency';

type Method = 'bank_transfer' | 'card' | 'cash' | 'store' | 'other';
type SourceInput = { paymentId?: string; creditNoteId?: string };
type PaymentInput = {
  clientId: string;
  receivedOn: string;
  amount: unknown;
  method: Method;
  reference?: string;
  notes?: string;
};
type AllocationInput = SourceInput & { invoiceId: string; amount: unknown };
type RefundInput = SourceInput & {
  amount: unknown;
  refundedOn: string;
  method: Method;
  reference?: string;
  notes?: string;
};
type VoidInput = { expectedVersion: number; reason: string };
type PaymentRow = Awaited<ReturnType<TenantTransaction['payment']['findFirstOrThrow']>>;
type InvoiceRow = Awaited<ReturnType<TenantTransaction['invoice']['findFirstOrThrow']>>;
type AllocationRow = Awaited<ReturnType<TenantTransaction['allocation']['findFirstOrThrow']>>;
type RefundRow = Awaited<ReturnType<TenantTransaction['refund']['findFirstOrThrow']>>;
type Source = {
  paymentId: string | null;
  creditNoteId: string | null;
  clientId: string;
  currency: string;
  amount: string;
  date: string;
};
const paymentInclude = {
  allocations: {
    include: { invoice: { select: { number: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
  refunds: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.PaymentInclude;
type PaymentDetailRow = Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>;
type MoneyRecordView = {
  id: string;
  amount: string;
  method: Method;
  reference: string | null;
  notes: string | null;
  status: 'recorded' | 'voided';
  voidedOn: string | null;
  voidReason: string | null;
  createdBy: string;
  voidedBy: string | null;
  version: number;
  createdAt: string;
};
export type RefundView = MoneyRecordView & {
  paymentId: string | null;
  creditNoteId: string | null;
  refundedOn: string;
};
export type PaymentView = MoneyRecordView & {
  clientId: string;
  receivedOn: string;
  currency: string;
  updatedAt: string;
  allocations: (ReturnType<typeof allocationView> & { invoiceNumber: string | null })[];
  refunds: RefundView[];
  remaining: string;
};

@Injectable()
export class PaymentService {
  private readonly tenants: TenantDb;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.tenants = new TenantDb(prisma.client);
  }

  record(ctx: RequestContext, input: PaymentInput, header: unknown, meta: RequestMeta) {
    return this.run(ctx, meta, 'payment.recorded', async (tx, actor) => {
      const key = idempotencyKey(header);
      return idempotent(tx, ctx.companyId, actor, 'payment.record', key, input, async () => {
        const company = await this.company(tx, ctx);
        if (company.defaultCurrency !== 'EUR') {
          throw new CommerceError(
            422,
            'currency_not_supported',
            'payment',
            null,
            'Only EUR payments are supported',
          );
        }
        const clientId = await this.client(tx, ctx, input.clientId);
        const amount = positiveAmount(input.amount);
        const receivedOn = validDate(input.receivedOn, company.today, 'receivedOn');
        const payment = await tx.payment.create({
          data: {
            companyId: ctx.companyId,
            clientId,
            receivedOn,
            amount,
            currency: company.defaultCurrency,
            method: input.method,
            reference: input.reference,
            notes: input.notes,
            createdById: actor,
          },
          include: paymentInclude,
        });
        await this.success(tx, ctx, meta, 'payment.recorded', 'payment', payment.id);
        return { payment: paymentView(payment) };
      });
    });
  }

  allocate(ctx: RequestContext, input: AllocationInput, header: unknown, meta: RequestMeta) {
    return this.run(ctx, meta, 'allocation.created', async (tx, actor) => {
      const key = idempotencyKey(header);
      return idempotent(tx, ctx.companyId, actor, 'allocation.create', key, input, async () => {
        const company = await this.company(tx, ctx);
        const amount = positiveAmount(input.amount);
        const invoiceId = objectId(input.invoiceId, 'invoice');
        const { source, invoices } = await this.lockSource(tx, ctx, input, [invoiceId]);
        const invoice = invoices.find((row) => row.id === invoiceId);
        if (!invoice) throw missing('invoice', invoiceId);
        if (
          invoice.status !== 'issued' ||
          invoice.documentType !== 'invoice' ||
          invoice.clientId !== source.clientId ||
          invoice.currency !== source.currency
        ) {
          throw notAllocatable('invoice', invoiceId);
        }
        const settlement = await this.settlement(tx, ctx, source);
        const targetAllocations = await tx.allocation.findMany({
          where: { companyId: ctx.companyId, invoiceId },
        });
        const effectiveOn = allocationEffectiveOn({
          amount,
          today: company.today,
          source: settlement,
          invoice: {
            total: fixed(invoice.total, 2),
            issueDate: day(invoice.issueDate),
            allocations: targetAllocations.map(datedAllocation),
          },
        });
        if (effectiveOn === null) throw overAllocation('invoice', invoiceId);
        const allocation = await tx.allocation.create({
          data: {
            companyId: ctx.companyId,
            paymentId: source.paymentId,
            creditNoteId: source.creditNoteId,
            invoiceId,
            amount,
            effectiveOn: parseDateOnly(effectiveOn, 'effectiveOn'),
            createdById: actor,
          },
        });
        await this.success(tx, ctx, meta, 'allocation.created', 'allocation', allocation.id);
        return { allocation: allocationView(allocation) };
      });
    });
  }

  reverse(ctx: RequestContext, id: string, input: { reason: string }, meta: RequestMeta) {
    return this.run(ctx, meta, 'allocation.reversed', async (tx, actor) => {
      id = objectId(id, 'allocation');
      const company = await this.company(tx, ctx);
      // The source and target ids are immutable. Read them without taking a child lock first.
      const initial = await tx.allocation.findFirst({ where: { companyId: ctx.companyId, id } });
      if (!initial) throw missing('allocation', id);
      await this.lockSource(tx, ctx, sourceInput(initial), [initial.invoiceId], false);
      const allocation = await tx.allocation.findFirstOrThrow({
        where: { companyId: ctx.companyId, id },
      });
      if (allocation.reversedOn)
        throw new CommerceError(409, 'already_reversed', 'allocation', id, 'already_reversed');
      const reversed = await tx.allocation.update({
        where: { id },
        data: {
          reversedOn: parseDateOnly(company.today, 'today'),
          reversalReason: input.reason,
          reversedById: actor,
        },
      });
      await this.success(tx, ctx, meta, 'allocation.reversed', 'allocation', id);
      return { allocation: allocationView(reversed) };
    });
  }

  get(ctx: RequestContext, id: string, meta: RequestMeta) {
    return this.run(ctx, meta, 'payment.view', async (tx) => {
      id = objectId(id, 'payment');
      const payment = await tx.payment.findFirst({
        where: { companyId: ctx.companyId, id },
        include: paymentInclude,
      });
      if (!payment) throw missing('payment', id);
      return paymentView(payment);
    });
  }

  list(ctx: RequestContext, clientId: string | undefined, meta: RequestMeta) {
    return this.run(ctx, meta, 'payment.view', async (tx) => {
      if (clientId !== undefined) clientId = await this.client(tx, ctx, clientId);
      const payments = await tx.payment.findMany({
        where: { companyId: ctx.companyId, ...(clientId ? { clientId } : {}) },
        orderBy: [{ receivedOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        include: paymentInclude,
      });
      return payments.map(paymentView);
    });
  }

  voidPayment(ctx: RequestContext, id: string, input: VoidInput, meta: RequestMeta) {
    return this.run(ctx, meta, 'payment.voided', async (tx, actor) => {
      id = objectId(id, 'payment');
      const company = await this.company(tx, ctx);
      const payment = await this.lockPayment(tx, ctx, id);
      const allocations = await tx.allocation.findMany({
        where: { companyId: ctx.companyId, paymentId: id, reversedOn: null },
        orderBy: { id: 'asc' },
      });
      await this.lockInvoices(
        tx,
        ctx,
        allocations.map((row) => row.invoiceId),
      );
      if (
        await tx.refund.findFirst({
          where: { companyId: ctx.companyId, paymentId: id, status: 'recorded' },
        })
      ) {
        throw new CommerceError(409, 'payment_refunded', 'payment', id, 'payment_refunded');
      }
      if (payment.status !== 'recorded') throw notRecorded('payment', id);
      checkVersion(payment.version, input.expectedVersion, 'payment', id);
      const today = parseDateOnly(company.today, 'today');
      await tx.allocation.updateMany({
        where: { companyId: ctx.companyId, paymentId: id, reversedOn: null },
        data: { reversedOn: today, reversalReason: input.reason, reversedById: actor },
      });
      const voided = await tx.payment.update({
        where: { id },
        data: {
          status: 'voided',
          voidedOn: today,
          voidReason: input.reason,
          voidedById: actor,
          version: { increment: 1 },
        },
        include: paymentInclude,
      });
      await this.success(tx, ctx, meta, 'payment.voided', 'payment', id, {
        reversedAllocationIds: allocations.map((row) => row.id),
      });
      return { payment: paymentView(voided) };
    });
  }

  refund(ctx: RequestContext, input: RefundInput, header: unknown, meta: RequestMeta) {
    return this.run(ctx, meta, 'refund.recorded', async (tx, actor) => {
      const key = idempotencyKey(header);
      return idempotent(tx, ctx.companyId, actor, 'refund.record', key, input, async () => {
        const company = await this.company(tx, ctx);
        const amount = positiveAmount(input.amount);
        const { source } = await this.lockSource(tx, ctx, input);
        const refundedOn = validDate(input.refundedOn, company.today, 'refundedOn', source.date);
        if (
          !refundAllowed({
            amount,
            refundedOn: day(refundedOn),
            source: await this.settlement(tx, ctx, source),
          })
        )
          throw overAllocation(
            source.paymentId ? 'payment' : 'invoice',
            source.paymentId ?? source.creditNoteId,
          );
        const refund = await tx.refund.create({
          data: {
            companyId: ctx.companyId,
            paymentId: source.paymentId,
            creditNoteId: source.creditNoteId,
            amount,
            refundedOn,
            method: input.method,
            reference: input.reference,
            notes: input.notes,
            createdById: actor,
          },
        });
        await this.success(tx, ctx, meta, 'refund.recorded', 'refund', refund.id);
        return { refund: refundView(refund) };
      });
    });
  }

  voidRefund(ctx: RequestContext, id: string, input: VoidInput, meta: RequestMeta) {
    return this.run(ctx, meta, 'refund.voided', async (tx, actor) => {
      id = objectId(id, 'refund');
      const company = await this.company(tx, ctx);
      const initial = await tx.refund.findFirst({ where: { companyId: ctx.companyId, id } });
      if (!initial) throw missing('refund', id);
      await this.lockSource(tx, ctx, sourceInput(initial), [], false);
      const refund = await tx.refund.findFirstOrThrow({ where: { companyId: ctx.companyId, id } });
      if (refund.status !== 'recorded') throw notRecorded('refund', id);
      checkVersion(refund.version, input.expectedVersion, 'refund', id);
      const voided = await tx.refund.update({
        where: { id },
        data: {
          status: 'voided',
          voidedOn: parseDateOnly(company.today, 'today'),
          voidReason: input.reason,
          voidedById: actor,
          version: { increment: 1 },
        },
      });
      await this.success(tx, ctx, meta, 'refund.voided', 'refund', id);
      return { refund: refundView(voided) };
    });
  }

  private async run<T>(
    ctx: RequestContext,
    meta: RequestMeta,
    action: string,
    fn: (tx: TenantTransaction, actor: string) => Promise<T>,
  ): Promise<T> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(
        { companyId: ctx.companyId, actor, correlationId: ctx.correlationId },
        (tx) => fn(tx, actor),
      );
    } catch (error) {
      if (error instanceof CommerceError) {
        return settleCommerceError(
          this.audit,
          this.prisma,
          ctx,
          meta,
          new CommerceError(
            error.status,
            error.reason,
            error.objectType,
            error.objectId,
            error.message,
            action,
            error.details,
          ),
        );
      }
      throw error;
    }
  }

  private async company(tx: TenantTransaction, ctx: RequestContext) {
    const rows = await tx.$queryRaw<{ defaultCurrency: string; timezone: string }[]>`
      SELECT default_currency AS "defaultCurrency", timezone FROM company WHERE id = ${ctx.companyId}::uuid FOR SHARE
    `;
    const company = rows[0];
    if (!company) throw missing('company', ctx.companyId);
    return { ...company, today: businessDateInZone(new Date(), company.timezone) };
  }

  private async client(tx: TenantTransaction, ctx: RequestContext, value: string): Promise<string> {
    const id = objectId(value, 'client');
    if (
      !(await tx.client.findFirst({
        where: { companyId: ctx.companyId, id },
        select: { id: true },
      }))
    )
      throw missing('client', id);
    return id;
  }

  private async lockPayment(
    tx: TenantTransaction,
    ctx: RequestContext,
    id: string,
  ): Promise<PaymentRow> {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM payment WHERE company_id = ${ctx.companyId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw missing('payment', id);
    return tx.payment.findFirstOrThrow({ where: { companyId: ctx.companyId, id } });
  }

  private async lockInvoices(
    tx: TenantTransaction,
    ctx: RequestContext,
    ids: string[],
  ): Promise<InvoiceRow[]> {
    if (!ids.length) return [];
    const unique = [...new Set(ids)];
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM invoice WHERE company_id = ${ctx.companyId}::uuid
      AND id IN (${Prisma.join(unique.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE
    `);
    for (const id of unique) if (!rows.some((row) => row.id === id)) throw missing('invoice', id);
    return tx.invoice.findMany({ where: { companyId: ctx.companyId, id: { in: unique } } });
  }

  private async lockSource(
    tx: TenantTransaction,
    ctx: RequestContext,
    input: SourceInput,
    targets: string[] = [],
    checkStatus = true,
  ): Promise<{ source: Source; invoices: InvoiceRow[] }> {
    if ((input.paymentId !== undefined) === (input.creditNoteId !== undefined)) {
      throw new CommerceError(
        400,
        'invalid_source',
        'allocation',
        null,
        'exactly one source is required',
      );
    }
    const paymentId = input.paymentId === undefined ? null : objectId(input.paymentId, 'payment');
    const creditNoteId =
      input.creditNoteId === undefined ? null : objectId(input.creditNoteId, 'invoice');
    const payment = paymentId ? await this.lockPayment(tx, ctx, paymentId) : null;
    const invoices = await this.lockInvoices(
      tx,
      ctx,
      creditNoteId ? [...targets, creditNoteId] : targets,
    );
    if (payment) {
      if (checkStatus && payment.status !== 'recorded') throw notAllocatable('payment', payment.id);
      return {
        source: {
          paymentId: payment.id,
          creditNoteId: null,
          clientId: payment.clientId,
          currency: payment.currency,
          amount: fixed(payment.amount, 2),
          date: day(payment.receivedOn),
        },
        invoices,
      };
    }
    const credit = invoices.find((invoice) => invoice.id === creditNoteId);
    if (!credit) throw missing('invoice', creditNoteId);
    if (checkStatus && (credit.documentType !== 'credit_note' || credit.status !== 'issued'))
      throw notAllocatable('invoice', credit.id);
    return {
      source: {
        paymentId: null,
        creditNoteId: credit.id,
        clientId: credit.clientId,
        currency: credit.currency,
        amount: fixed(credit.total, 2),
        date: day(credit.issueDate),
      },
      invoices,
    };
  }

  private async settlement(
    tx: TenantTransaction,
    ctx: RequestContext,
    source: Source,
  ): Promise<DatedSettlementSource> {
    const where = {
      companyId: ctx.companyId,
      ...(source.paymentId
        ? { paymentId: source.paymentId }
        : { creditNoteId: source.creditNoteId }),
    };
    const allocations = await tx.allocation.findMany({ where });
    const refunds = await tx.refund.findMany({ where });
    return {
      amount: source.amount,
      date: source.date,
      allocations: allocations.map(datedAllocation),
      refunds: refunds.map(datedRefund),
    };
  }

  private success(
    tx: TenantTransaction,
    ctx: RequestContext,
    meta: RequestMeta,
    action: string,
    objectType: string,
    objectId: string,
    details?: Record<string, unknown>,
  ) {
    return this.audit.record(tx, {
      companyId: ctx.companyId,
      actorType: 'user',
      actorId: requireActor(ctx),
      actorLabel: ctx.actorLabel,
      action,
      objectType,
      objectId,
      outcome: 'success',
      ...meta,
      details,
    });
  }
}

function objectId(value: string, objectType: string): string {
  if (!isUuid(value)) throw missing(objectType, null);
  return value.toLowerCase();
}
function missing(type: string, id: string | null) {
  return new CommerceError(404, 'not_found', type, id, 'Not found');
}
function notAllocatable(type: string, id: string) {
  return new CommerceError(409, 'not_allocatable', type, id, 'not_allocatable');
}
function notRecorded(type: string, id: string) {
  return new CommerceError(409, 'not_recorded', type, id, 'not_recorded');
}
function overAllocation(type: string, id: string | null) {
  return new CommerceError(409, 'over_allocation', type, id, 'over_allocation');
}
function checkVersion(actual: number, expected: number, type: string, id: string): void {
  if (actual !== expected)
    throw new CommerceError(409, 'version_conflict', type, id, 'version_conflict');
}
function positiveAmount(value: unknown): string {
  const amount = decimalField(value, 2, 'amount');
  const decimal = parseAmount(amount, 2);
  if (!decimal.gt('0') || decimal.gte('100000000000000000'))
    throw new CommerceError(
      400,
      'invalid_amount',
      'amount',
      null,
      'amount must be positive and fit Decimal(19,2)',
    );
  return amount;
}
function validDate(value: string, today: string, field: string, earliest?: string): Date {
  let date: Date;
  try {
    date = parseDateOnly(value, field);
  } catch (error) {
    if (error instanceof CommerceError)
      throw new CommerceError(
        422,
        'invalid_date',
        field,
        null,
        `${field} must be a real YYYY-MM-DD date`,
      );
    throw error;
  }
  if (value > today || (earliest !== undefined && value < earliest))
    throw new CommerceError(
      422,
      'invalid_date',
      field,
      null,
      `${field} is outside the allowed dates`,
    );
  return date;
}
function day(date: Date | null): string {
  const result = formatDateOnly(date);
  if (!result) throw new Error('Settlement requires a business date');
  return result;
}
function sourceInput(row: { paymentId: string | null; creditNoteId: string | null }): SourceInput {
  return row.paymentId
    ? { paymentId: row.paymentId }
    : { creditNoteId: row.creditNoteId ?? undefined };
}
function datedAllocation(row: AllocationRow): DatedAmount {
  return {
    amount: fixed(row.amount, 2),
    from: day(row.effectiveOn),
    until: formatDateOnly(row.reversedOn),
  };
}
function datedRefund(row: RefundRow): DatedAmount {
  return {
    amount: fixed(row.amount, 2),
    from: day(row.refundedOn),
    until: row.status === 'voided' ? day(row.voidedOn) : null,
  };
}
function allocationView(row: AllocationRow) {
  return {
    id: row.id,
    paymentId: row.paymentId,
    creditNoteId: row.creditNoteId,
    invoiceId: row.invoiceId,
    amount: fixed(row.amount, 2),
    effectiveOn: day(row.effectiveOn),
    reversedOn: formatDateOnly(row.reversedOn),
    reversalReason: row.reversalReason,
    createdBy: row.createdById,
    reversedBy: row.reversedById,
    createdAt: row.createdAt.toISOString(),
  };
}
function refundView(row: RefundRow): RefundView {
  return {
    id: row.id,
    paymentId: row.paymentId,
    creditNoteId: row.creditNoteId,
    amount: fixed(row.amount, 2),
    refundedOn: day(row.refundedOn),
    method: row.method,
    reference: row.reference,
    notes: row.notes,
    status: row.status,
    voidedOn: formatDateOnly(row.voidedOn),
    voidReason: row.voidReason,
    createdBy: row.createdById,
    voidedBy: row.voidedById,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}
function paymentView(row: PaymentDetailRow): PaymentView {
  return {
    id: row.id,
    clientId: row.clientId,
    receivedOn: day(row.receivedOn),
    amount: fixed(row.amount, 2),
    currency: row.currency,
    method: row.method,
    reference: row.reference,
    notes: row.notes,
    status: row.status,
    voidedOn: formatDateOnly(row.voidedOn),
    voidReason: row.voidReason,
    createdBy: row.createdById,
    voidedBy: row.voidedById,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    allocations: row.allocations.map((allocation) => ({
      ...allocationView(allocation),
      invoiceNumber: allocation.invoice.number,
    })),
    refunds: row.refunds.map(refundView),
    remaining: sourceRemaining({
      amount: fixed(row.amount, 2),
      allocations: row.allocations.map(datedAllocation),
      refunds: row.refunds.map(datedRefund),
    }),
  };
}
