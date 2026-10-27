import type { TranslocoService } from '@jsverse/transloco';

export const FULFILMENT_STATUSES = [
  'new',
  'review_required',
  'preparing',
  'ready',
  'handed_to_courier',
  'completed',
  'cancelled',
] as const;

export const PAYMENT_STATUSES = [
  'pending',
  'authorized',
  'paid',
  'partially_paid',
  'refunded',
  'partially_refunded',
  'voided',
  'unknown',
] as const;

export function translateCode(
  transloco: TranslocoService,
  prefix: string,
  code: string | null | undefined,
): string {
  if (!code) {
    return '';
  }
  const key = `${prefix}.${code}`;
  const translated = transloco.translate(key);
  if (translated.length === 0 || translated === key) {
    return code;
  }
  return translated;
}

export function reviewCodes(order: {
  reviewReason: string | null;
  attentionReasons: readonly string[];
}): string[] {
  const codes = [...order.attentionReasons];
  if (order.reviewReason && !codes.includes(order.reviewReason)) {
    codes.unshift(order.reviewReason);
  }
  return codes;
}
