import { HttpErrorResponse } from '@angular/common/http';
import { isVersionConflict, readApiError } from '../core/api-error';
import { decimalInput } from '../invoices/decimal-input';

export type PaymentState = 'unpaid' | 'partially_paid' | 'paid';
export type AllocationView = {
  id: string;
  amount: string;
  effectiveOn: string;
  reversedOn: string | null;
  reversalReason: string | null;
  source?:
    | { type: 'payment'; id: string; receivedOn: string; reference: string | null }
    | { type: 'credit_note'; id: string; number: string | null };
  invoice?: { id: string; number: string | null };
};
export type ClientCredit = { id: string; amount: string; remaining: string } & (
  | { type: 'payment'; receivedOn: string; reference: string | null }
  | { type: 'credit_note'; number: string | null; issueDate: string }
);
export type AccountView = {
  openInvoices: {
    id: string;
    number: string;
    issueDate: string;
    dueDate: string | null;
    total: string;
    openBalance: string;
  }[];
  credits: ClientCredit[];
  openTotal: string;
  creditTotal: string;
};
export type RefundView = {
  id: string;
  amount: string;
  refundedOn: string;
  status: string;
  version: number;
  voidReason: string | null;
};
export type PaymentDetail = {
  id: string;
  version: number;
  status: string;
  receivedOn: string;
  reference: string | null;
  amount: string;
  remaining: string;
  refunds: RefundView[];
};
export type Failure = { key: string; correlationId: string | null };

const ERRORS: Readonly<Record<string, string>> = {
  payment_refunded: 'payments.errors.refunded',
  over_allocation: 'payments.errors.overAllocation',
  not_allocatable: 'payments.errors.notAllocatable',
  idempotency_key_reused: 'payments.errors.keyReused',
  invalid_amount: 'payments.errors.amount',
  invalid_date: 'payments.errors.date',
  currency_not_supported: 'invoices.issue.errors.currency',
  already_reversed: 'payments.errors.reversed',
  not_recorded: 'payments.errors.notRecorded',
};
export function paymentFailure(error: unknown): Failure {
  const body = error instanceof HttpErrorResponse ? readApiError(error) : null;
  return {
    key: isVersionConflict(error)
      ? 'payments.errors.version'
      : (ERRORS[body?.code ?? ''] ?? 'payments.errors.failed'),
    correlationId: body?.correlationId ?? null,
  };
}

/** Minor-unit comparisons only: amounts remain decimal strings on the wire. */
export function positiveMoney(raw: string): string | null {
  const value = decimalInput(raw).replace(/^0+(?=\d)/, '');
  const cents = moneyCents(value);
  if (cents === null || cents === 0n) return null;
  return value;
}
export function smallerMoney(a: string, b: string): string {
  const left = moneyCents(a);
  const right = moneyCents(b);
  if (left === null || right === null) throw new Error('Invalid amount');
  return left <= right ? a : b;
}

/** Decimal(19,2), including zero for balance comparisons. Never rounds typed amounts. */
function moneyCents(raw: string): bigint | null {
  const value = decimalInput(raw).replace(/^0+(?=\d)/, '');
  if (!/^\d{1,17}(\.\d{1,2})?$/.test(value)) return null;
  const [whole = '0', part = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(part.padEnd(2, '0'));
}
