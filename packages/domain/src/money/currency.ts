/**
 * Minor digits for an ISO 4217 code, from `Intl`.
 * Returns undefined when the code is not a currency this runtime knows.
 * Phase 1 accepts only currencies with exactly two minor digits.
 */
export function currencyMinorDigits(code: string): number | undefined {
  if (!/^[A-Z]{3}$/.test(code)) {
    return undefined;
  }
  try {
    const digits = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: code,
    }).resolvedOptions().maximumFractionDigits;
    return typeof digits === 'number' ? digits : undefined;
  } catch {
    return undefined;
  }
}
