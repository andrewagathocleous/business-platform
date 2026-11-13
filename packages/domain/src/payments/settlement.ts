import Decimal from '../money/decimal';
import { AmountError, parseAmount } from '../money/parse';

/** An amount that counts from `from` (inclusive) until `until` (exclusive), or for ever when null. */
export type DatedAmount = { amount: string; from: string; until: string | null };

export type InvoiceSettlement = { total: string; allocations: readonly DatedAmount[] };
export type SettlementSource = {
  amount: string;
  allocations: readonly DatedAmount[];
  refunds: readonly DatedAmount[];
};
export type DatedSettlementSource = SettlementSource & { date: string };
export type InvoicePaymentState = 'paid' | 'unpaid' | 'partially_paid';
export type AllocationEffectiveOnInput = {
  amount: string;
  today: string;
  source: DatedSettlementSource;
  invoice: InvoiceSettlement & { issueDate: string };
};
export type RefundAllowedInput = {
  amount: string;
  refundedOn: string;
  source: DatedSettlementSource;
};

function sum(items: readonly DatedAmount[], counts: (item: DatedAmount) => boolean): Decimal {
  return items.reduce((total, item) => {
    const amount = parseAmount(item.amount, 2);
    return counts(item) ? total.plus(amount) : total;
  }, new Decimal('0'));
}

export function countedOn(items: readonly DatedAmount[], date: string): string {
  return sum(
    items,
    (item) => item.from <= date && (item.until === null || item.until > date),
  ).toFixed(2);
}

export function currentTotal(items: readonly DatedAmount[]): string {
  return sum(items, (item) => item.until === null).toFixed(2);
}

export function openBalance(invoice: InvoiceSettlement, date?: string): string {
  const allocated =
    date === undefined ? currentTotal(invoice.allocations) : countedOn(invoice.allocations, date);
  return parseAmount(invoice.total, 2).minus(parseAmount(allocated, 2)).toFixed(2);
}

export function paymentState(total: string, open: string): InvoicePaymentState {
  const totalAmount = parseAmount(total, 2);
  const openAmount = parseAmount(open, 2);
  if (openAmount.lte('0')) return 'paid';
  return openAmount.eq(totalAmount) ? 'unpaid' : 'partially_paid';
}

export function sourceRemaining(source: SettlementSource): string {
  return parseAmount(source.amount, 2)
    .minus(parseAmount(currentTotal(source.allocations), 2))
    .minus(parseAmount(currentTotal(source.refunds), 2))
    .toFixed(2);
}

function positiveAmount(value: string): Decimal {
  const amount = parseAmount(value, 2);
  if (!amount.gt('0')) throw new AmountError('format', 'amount must be greater than zero');
  return amount;
}

function eventDates(items: readonly DatedAmount[], lowerBound: string): string[] {
  return [
    ...new Set([
      lowerBound,
      ...items.flatMap((item) => (item.until === null ? [item.from] : [item.from, item.until])),
    ]),
  ]
    .filter((date) => date >= lowerBound)
    .sort();
}

function sourceAllows(source: DatedSettlementSource, amount: Decimal, date: string): boolean {
  return parseAmount(countedOn(source.allocations, date), 2)
    .plus(parseAmount(countedOn(source.refunds, date), 2))
    .plus(amount)
    .lte(parseAmount(source.amount, 2));
}

export function allocationEffectiveOn(input: AllocationEffectiveOnInput): string | null {
  const amount = positiveAmount(input.amount);
  const lowerBound =
    input.source.date > input.invoice.issueDate ? input.source.date : input.invoice.issueDate;
  if (lowerBound > input.today) return null;
  const dates = eventDates(
    [...input.source.allocations, ...input.source.refunds, ...input.invoice.allocations],
    lowerBound,
  );
  // The proposed allocation persists from D onwards. A later start only removes checks.
  for (const candidate of dates) {
    if (candidate > input.today) break;
    if (
      dates
        .filter((date) => date >= candidate)
        .every(
          (date) =>
            parseAmount(openBalance(input.invoice, date), 2).gte(amount) &&
            sourceAllows(input.source, amount, date),
        )
    )
      return candidate;
  }
  return null;
}

export function refundAllowed(input: RefundAllowedInput): boolean {
  const amount = positiveAmount(input.amount);
  if (input.refundedOn < input.source.date) return false;
  return eventDates([...input.source.allocations, ...input.source.refunds], input.refundedOn).every(
    (date) => sourceAllows(input.source, amount, date),
  );
}
