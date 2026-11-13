import { Inject, Injectable } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { ageingReport, businessDateInZone, collectedReport, invoicedReport } from '@bp/domain';
import { z } from 'zod';
import type { RequestContext } from '../authz/request-context';
import { fixed, formatDateOnly } from '../commerce/format';
import { requireActor } from '../commerce/http';
import { PrismaService } from '../database/prisma.service';
import { datedAllocation, datedRefund, day } from '../payments/settlement';
import { invalidDate, reportDate, reportPeriod } from './report-dates';

const taxLabel = z.object({ code: z.string(), name: z.string() });
const clientSelect = { displayName: true } as const;

@Injectable()
export class ReportService {
  private readonly tenants: TenantDb;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.tenants = new TenantDb(prisma.client);
  }

  invoiced(ctx: RequestContext, from: unknown, to: unknown) {
    const { start, end } = reportPeriod(from, to);
    return this.read(ctx, async (tx) => {
      const rows = await tx.invoice.findMany({
        where: {
          companyId: ctx.companyId,
          status: 'issued',
          documentType: { in: ['invoice', 'credit_note'] },
          issueDate: { gte: start.date, lte: end.date },
        },
        select: { documentType: true, currency: true, taxSummary: true },
        orderBy: [{ issueDate: 'asc' }, { id: 'asc' }],
      });
      return {
        from: start.day,
        to: end.day,
        currencies: invoicedReport(
          rows.map((row) => ({
            documentType: row.documentType === 'credit_note' ? 'credit_note' : 'invoice',
            currency: row.currency,
            taxSummary: row.taxSummary.map((tax) => ({
              taxCodeId: tax.taxCodeId,
              ...taxLabel.parse(tax.taxSnapshot),
              net: fixed(tax.net, 2),
              tax: fixed(tax.tax, 2),
              gross: fixed(tax.gross, 2),
            })),
          })),
        ),
      };
    });
  }

  collected(ctx: RequestContext, from: unknown, to: unknown) {
    const { start, end } = reportPeriod(from, to);
    return this.read(ctx, async (tx) => {
      const payments = await tx.payment.findMany({
        where: {
          companyId: ctx.companyId,
          status: 'recorded',
          receivedOn: { gte: start.date, lte: end.date },
        },
        select: { currency: true, method: true, amount: true },
      });
      const refunds = await tx.refund.findMany({
        where: {
          companyId: ctx.companyId,
          status: 'recorded',
          refundedOn: { gte: start.date, lte: end.date },
        },
        select: {
          amount: true,
          method: true,
          payment: { select: { currency: true } },
          creditNote: { select: { currency: true } },
        },
      });
      return {
        from: start.day,
        to: end.day,
        currencies: collectedReport([
          ...payments.map((row) => ({
            kind: 'payment' as const,
            currency: row.currency,
            method: row.method,
            amount: fixed(row.amount, 2),
          })),
          ...refunds.map((row) => {
            const source = row.payment ?? row.creditNote;
            if (!source) throw new Error('Refund has no settlement source');
            return {
              kind: 'refund' as const,
              currency: source.currency,
              method: row.method,
              amount: fixed(row.amount, 2),
            };
          }),
        ]),
      };
    });
  }

  ageing(ctx: RequestContext, value: unknown) {
    const asOf = reportDate(value, 'asOf');
    return this.read(ctx, async (tx) => {
      const company = await tx.company.findUniqueOrThrow({ where: { id: ctx.companyId } });
      if (asOf.day > businessDateInZone(new Date(), company.timezone))
        return invalidDate('asOf must not be after today in the company timezone');
      const invoices = await tx.invoice.findMany({
        where: {
          companyId: ctx.companyId,
          status: 'issued',
          documentType: 'invoice',
          issueDate: { lte: asOf.date },
        },
        include: { client: { select: clientSelect }, allocations: true },
      });
      // Include payments voided later: their credit and allocations still count before the void.
      const payments = await tx.payment.findMany({
        where: { companyId: ctx.companyId, receivedOn: { lte: asOf.date } },
        include: { client: { select: clientSelect }, allocations: true, refunds: true },
      });
      const credits = await tx.invoice.findMany({
        where: {
          companyId: ctx.companyId,
          status: 'issued',
          documentType: 'credit_note',
          issueDate: { lte: asOf.date },
        },
        include: { client: { select: clientSelect }, creditAllocations: true, refunds: true },
      });
      return {
        asOf: asOf.day,
        currencies: ageingReport(
          invoices.map((row) => ({
            id: row.id,
            number: row.number,
            clientId: row.clientId,
            clientName: row.client.displayName,
            currency: row.currency,
            issueDate: day(row.issueDate),
            dueDate: day(row.dueDate),
            total: fixed(row.total, 2),
            allocations: row.allocations.map(datedAllocation),
          })),
          [
            ...payments.map((row) => ({
              id: row.id,
              type: 'payment' as const,
              clientId: row.clientId,
              clientName: row.client.displayName,
              currency: row.currency,
              date: day(row.receivedOn),
              voidedOn: formatDateOnly(row.voidedOn),
              amount: fixed(row.amount, 2),
              allocations: row.allocations.map(datedAllocation),
              refunds: row.refunds.map(datedRefund),
            })),
            ...credits.map((row) => ({
              id: row.id,
              type: 'credit_note' as const,
              clientId: row.clientId,
              clientName: row.client.displayName,
              currency: row.currency,
              date: day(row.issueDate),
              voidedOn: null,
              amount: fixed(row.total, 2),
              allocations: row.creditAllocations.map(datedAllocation),
              refunds: row.refunds.map(datedRefund),
            })),
          ],
          asOf.day,
        ),
      };
    });
  }

  private read<T>(ctx: RequestContext, fn: (tx: TenantTransaction) => Promise<T>) {
    return this.tenants.run(
      { companyId: ctx.companyId, actor: requireActor(ctx), correlationId: ctx.correlationId },
      fn,
      { isolation: 'repeatable_read' },
    );
  }
}
