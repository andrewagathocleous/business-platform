/**
 * The checks an invoice passes before it is issued (docs/finance/invoice-requirements.md,
 * section 3). Each failure is a field code, so the screen can point at what to fix.
 */

export type IssueAddress = {
  line1: string | null;
  city: string | null;
  countryCode: string | null;
};

export type IssueLineCheck = {
  position: number;
  description: string;
  kind: string;
  noteEn: string | null;
  noteEl: string | null;
  taxCodeActive: boolean;
};

export type IssueCheckInput = {
  seller: { legalName: string; vatNumber: string | null; address: IssueAddress };
  buyer: { vatNumber: string | null; address: IssueAddress | null };
  lines: readonly IssueLineCheck[];
  /** The recalculated total, formatted with 2 decimals. */
  total: string;
  supplyDate: string;
  issueDate: string;
  seriesId: string | null;
};

/** EU member states (ISO 3166-1). Greece's VAT numbers use the prefix EL. */
const EU_COUNTRIES = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
]);

/** Tax kinds whose lines must carry the legal note in both languages. */
const NOTE_REQUIRED = new Set(['exempt', 'reverse_charge']);

export function issueProblems(input: IssueCheckInput): string[] {
  const fields: string[] = [];
  const { seller, buyer } = input;
  if (!present(seller.legalName)) {
    fields.push('seller.legalName');
  }
  if (!completeAddress(seller.address)) {
    fields.push('seller.address');
  }
  if (!present(seller.vatNumber)) {
    fields.push('seller.vatNumber');
  }
  if (!buyer.address || !completeAddress(buyer.address)) {
    fields.push('buyer.address');
  }
  if (input.lines.some((line) => line.kind === 'reverse_charge') && !present(buyer.vatNumber)) {
    fields.push('buyer.vatNumber');
  }
  // Reg. 12(1Α): to another member state, the seller's number carries CY and the buyer's
  // number, when there is one, its own country code.
  const country = buyer.address?.countryCode?.trim().toUpperCase() ?? '';
  if (country !== 'CY' && EU_COUNTRIES.has(country)) {
    if (present(seller.vatNumber) && !compact(seller.vatNumber).startsWith('CY')) {
      fields.push('seller.vatNumber.prefix');
    }
    const prefix = country === 'GR' ? 'EL' : country;
    if (present(buyer.vatNumber) && !compact(buyer.vatNumber).startsWith(prefix)) {
      fields.push('buyer.vatNumber.prefix');
    }
  }
  if (input.lines.length === 0) {
    fields.push('lines');
  }
  for (const line of input.lines) {
    if (!present(line.description)) {
      fields.push(`lines.${String(line.position)}.description`);
    }
    if (!line.taxCodeActive) {
      fields.push(`lines.${String(line.position)}.taxCodeInactive`);
    }
    if (NOTE_REQUIRED.has(line.kind) && (!present(line.noteEn) || !present(line.noteEl))) {
      fields.push(`lines.${String(line.position)}.legalNote`);
    }
  }
  if (isNegativeAmount(input.total)) {
    fields.push('total.negative');
  }
  if (input.supplyDate > input.issueDate) {
    fields.push('supplyDate.afterIssue');
  }
  if (!input.seriesId) {
    fields.push('series.missing');
  }
  return fields;
}

function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function completeAddress(address: IssueAddress): boolean {
  return present(address.line1) && present(address.city) && present(address.countryCode);
}

function compact(value: string): string {
  return value.replace(/[\s.-]/g, '').toUpperCase();
}

/** A formatted amount below zero. "-0.00" is not negative. */
function isNegativeAmount(amount: string): boolean {
  return amount.trim().startsWith('-') && /[1-9]/.test(amount);
}
