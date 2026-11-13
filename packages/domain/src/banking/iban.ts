/**
 * BBAN structure per SEPA country, from the ISO 13616 IBAN registry: n digits, a upper-case
 * letters, c letters or digits. An IBAN from another country gets the format and mod-97 checks only.
 */
const BBAN_FORMATS: Readonly<Record<string, string>> = {
  AD: '4n4n12c',
  AT: '5n11n',
  BE: '3n7n2n',
  BG: '4a4n2n8c',
  CH: '5n12c',
  CY: '3n5n16c',
  CZ: '4n6n10n',
  DE: '8n10n',
  DK: '4n9n1n',
  EE: '2n2n11n1n',
  ES: '4n4n1n1n10n',
  FI: '3n11n',
  FR: '5n5n11c2n',
  GB: '4a6n8n',
  GI: '4a15c',
  GR: '3n4n16c',
  HR: '7n10n',
  HU: '3n4n1n15n1n',
  IE: '4a6n8n',
  IS: '4n2n6n10n',
  IT: '1a5n5n12c',
  LI: '5n12c',
  LT: '5n11n',
  LU: '3n13c',
  LV: '4a13c',
  MC: '5n5n11c2n',
  MT: '4a5n18c',
  NL: '4a10n',
  NO: '4n6n1n',
  PL: '8n16n',
  PT: '4n4n11n2n',
  RO: '4a16c',
  SE: '3n16n1n',
  SI: '5n8n2n',
  SK: '4n6n10n',
  SM: '1a5n5n12c',
  VA: '3n15n',
};

const CHARACTER_CLASSES: Readonly<Record<string, string>> = {
  n: '[0-9]',
  a: '[A-Z]',
  c: '[A-Z0-9]',
};

const BBAN_PATTERNS: ReadonlyMap<string, RegExp> = new Map(
  Object.entries(BBAN_FORMATS).map(([country, format]) => [
    country,
    new RegExp(
      `^${[...format.matchAll(/(\d+)([nac])/g)]
        .map(
          ([, count, kind]) => `${CHARACTER_CLASSES[kind ?? 'c'] ?? '[A-Z0-9]'}{${count ?? '0'}}`,
        )
        .join('')}$`,
    ),
  ]),
);

/** Removes spaces and upper-cases, so "cy17 0020 …" and "CY170020…" store the same. */
export function normalizeIban(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

/** Checks a normalised IBAN: format, the SEPA country's BBAN structure, and the ISO 7064 mod-97 check digits. */
export function isValidIban(iban: string): boolean {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) {
    return false;
  }
  const bban = BBAN_PATTERNS.get(iban.slice(0, 2));
  if (bban && !bban.test(iban.slice(4))) {
    return false;
  }
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = String(Number.parseInt(char, 36));
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

export function normalizeBic(value: string): string {
  return value.trim().toUpperCase();
}

/** ISO 9362: bank code, country, location, and an optional branch. */
export function isValidBic(bic: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(bic);
}
