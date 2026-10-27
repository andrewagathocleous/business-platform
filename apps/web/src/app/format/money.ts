const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Formats a decimal string with locale grouping and the currency code.
 * The integer and fraction are sliced as text, so the digits survive values
 * that `Number` cannot represent.
 */
export function formatMoney(amount: string, currency: string, locale: 'en' | 'el'): string {
  if (!CURRENCY.test(currency)) {
    throw new Error('currency must be a 3-letter code');
  }
  const match = DECIMAL.exec(amount);
  if (!match) {
    throw new Error('amount must be a decimal string');
  }
  const sign = match[1] ?? '';
  const whole = match[2] ?? '0';
  const fraction = match[3];
  const separator = locale === 'el' ? '.' : ',';
  const decimalMark = locale === 'el' ? ',' : '.';
  const grouped = groupDigits(whole, separator);
  const digits = fraction === undefined ? grouped : `${grouped}${decimalMark}${fraction}`;
  const body = sign === '-' ? `-${digits}` : digits;
  return `${body} ${currency}`;
}

function groupDigits(whole: string, separator: string): string {
  const trimmed = whole.replace(/^0+(?=\d)/, '');
  const normalized = trimmed.length === 0 ? '0' : trimmed;
  const parts: string[] = [];
  for (let end = normalized.length; end > 0; end -= 3) {
    const start = Math.max(0, end - 3);
    parts.unshift(normalized.slice(start, end));
  }
  return parts.join(separator);
}
