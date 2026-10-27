const LEGAL_SUFFIX = /(?:\s*,)?\s+(?:ltd\.?|limited)\s*$/i;

/**
 * Duplicate-detection key only. Never write the result back over a stored name,
 * gift message or other customer text.
 */
export function normalizeForDuplicateCheck(value: string): string {
  const folded = value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return folded.replace(LEGAL_SUFFIX, '').trim();
}
