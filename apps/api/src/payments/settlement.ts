import { openBalance, paymentState, type DatedAmount } from '@bp/domain';
import { fixed, formatDateOnly } from '../commerce/format';

type Money = { toFixed(digits: number): string };
type Allocation = { amount: Money; effectiveOn: Date; reversedOn: Date | null };

export function day(date: Date | null): string {
  const result = formatDateOnly(date);
  if (!result) throw new Error('Settlement requires a business date');
  return result;
}

export function datedAllocation(row: Allocation): DatedAmount {
  return {
    amount: fixed(row.amount, 2),
    from: day(row.effectiveOn),
    until: formatDateOnly(row.reversedOn),
  };
}

export function datedRefund(row: {
  amount: Money;
  refundedOn: Date;
  status: string;
  voidedOn: Date | null;
}): DatedAmount {
  return {
    amount: fixed(row.amount, 2),
    from: day(row.refundedOn),
    until: row.status === 'voided' ? day(row.voidedOn) : null,
  };
}

export function invoiceBalance(
  row: { status: string; documentType: string; total: Money },
  allocations: readonly Allocation[],
) {
  if (row.status !== 'issued' || row.documentType !== 'invoice')
    return { openBalance: null, paymentState: null };
  const total = fixed(row.total, 2);
  const open = openBalance({ total, allocations: allocations.map(datedAllocation) });
  return { openBalance: open, paymentState: paymentState(total, open) };
}
