const LEGAL_SUFFIX = /(?:\s*,)?\s+(?:ltd\.?|limited)\s*$/i;

/**
 * Comparison key only. Never store the result or write it back over stored text.
 * Upper case maps ß to SS and both sigma forms to Σ. Do not lower-case afterwards:
 * that would turn a final Σ back into ς.
 */
export function foldForComparison(value: string): string {
  return value.normalize('NFKC').toUpperCase();
}

/**
 * Duplicate-detection key only. Never write the result back over a stored name,
 * gift message or other customer text.
 */
export function normalizeForDuplicateCheck(value: string): string {
  const folded = value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return folded.replace(LEGAL_SUFFIX, '').trim();
}
