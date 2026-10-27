const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Trim spaces and turn one comma decimal separator into a dot.
 * `10.005` is returned unchanged. This never uses `Number`.
 */
export function decimalInput(raw: string): string {
  const compact = raw.trim().replace(/ /g, '');
  let commas = 0;
  for (const char of compact) {
    if (char === ',') {
      commas += 1;
    }
  }
  if (commas === 1 && !compact.includes('.')) {
    return compact.replace(',', '.');
  }
  return compact;
}

export function isDecimalInput(raw: string): boolean {
  return DECIMAL.test(decimalInput(raw));
}
