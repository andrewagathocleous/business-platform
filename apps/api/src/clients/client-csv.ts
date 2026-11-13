import { normalizeForDuplicateCheck } from '@bp/domain';
import { z } from 'zod';
import { CommerceError } from '../commerce/errors';
import { clientCreate } from './client-input';
import type { ClientWrite } from './client.service';

export const CLIENT_CSV_COLUMNS = [
  'kind',
  'display_name',
  'legal_name',
  'vat_number',
  'tax_id',
  'email',
  'phone',
  'website',
  'notes',
  'default_currency',
  'default_language',
  'payment_terms_days',
  'accepts_e_invoices',
  'billing_line1',
  'billing_line2',
  'billing_city',
  'billing_region',
  'billing_postal_code',
  'billing_country_code',
] as const;
export type ClientCsvColumn = (typeof CLIENT_CSV_COLUMNS)[number];
export type ClientCsvValues = Record<ClientCsvColumn, string>;
export type ImportMessage = { field: string; code: string; message: string };
export type ImportRow = {
  number: number;
  status: 'new' | 'duplicate' | 'error';
  values: ClientCsvValues;
  messages: ImportMessage[];
};
export type ImportCounts = { new: number; duplicate: number; error: number };
export type DuplicateClient = {
  id: string;
  nameNormalized: string | null;
  emailNormalized: string | null;
  vatNormalized: string | null;
};

// UTF-16 unit limits, matching the client schema, plus valid scalar CSV spelling lengths.
export const CLIENT_CSV_FIELD_LIMITS: Record<ClientCsvColumn, number> = {
  kind: 12,
  display_name: 500,
  legal_name: 500,
  vat_number: 40,
  tax_id: 40,
  email: 320,
  phone: 80,
  website: 300,
  notes: 20_000,
  default_currency: 3,
  default_language: 2,
  payment_terms_days: 4,
  accepts_e_invoices: 5,
  billing_line1: 300,
  billing_line2: 300,
  billing_city: 160,
  billing_region: 160,
  billing_postal_code: 40,
  billing_country_code: 2,
};
export const MAX_CLIENT_PREVIEW_BYTES = 16 * 1024 * 1024;

export function csvError(reason: string, message: string): CommerceError {
  return new CommerceError(422, reason, 'client_import', null, message, 'client.import_previewed');
}

/** RFC 4180 with LF records accepted too. Quoted line endings remain byte-for-byte. */
export function parseCsv(input: string, maxDataRows = 5000): string[][] {
  const content = input.startsWith('\uFEFF') ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  const finishRow = () => {
    row.push(cell);
    rows.push(row);
    if (rows.length > maxDataRows + 1) throw csvError('too_many_rows', 'At most 5,000 data rows');
    row = [];
    cell = '';
    state = 'start';
  };
  for (let i = 0; i < content.length; i++) {
    const ch = content.charAt(i);
    if (state === 'quoted') {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          cell += '"';
          i++;
        } else state = 'closed';
      } else cell += ch;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      state = 'start';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r') {
        if (content[i + 1] !== '\n') throw csvError('invalid_csv', 'Bare CR outside a quoted cell');
        i++;
      }
      finishRow();
    } else if (ch === '"' && state === 'start') {
      state = 'quoted';
    } else {
      if (ch === '"' || state === 'closed') throw csvError('invalid_csv', 'Malformed CSV quoting');
      cell += ch;
      state = 'plain';
    }
  }
  if (state === 'quoted') throw csvError('invalid_csv', 'Unclosed quoted cell');
  if (state !== 'start' || row.length > 0) finishRow();
  return rows;
}

export function undoFormulaPrefix(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

export function parseClientCsv(content: string): ClientCsvValues[] {
  const [header, ...rows] = parseCsv(content);
  if (!header || header.every((cell) => cell === ''))
    throw csvError('header_required', 'Header row required');
  const allowed = new Set<string>([...CLIENT_CSV_COLUMNS, 'archived']);
  const unknown = header.filter((name) => !allowed.has(name));
  if (unknown.length) throw csvError('unknown_columns', `Unknown columns: ${unknown.join(', ')}`);
  if (new Set(header).size !== header.length)
    throw csvError('duplicate_columns', 'Repeated header columns');
  const missing = ['kind', 'display_name'].filter((name) => !header.includes(name));
  if (missing.length) throw csvError('missing_columns', `Missing columns: ${missing.join(', ')}`);
  return rows.map((cells, index) => {
    if (cells.length !== header.length)
      throw csvError('invalid_csv', `Row ${String(index + 2)}: wrong column count`);
    const values = Object.fromEntries(
      CLIENT_CSV_COLUMNS.map((name) => [name, '']),
    ) as ClientCsvValues;
    header.forEach((name, i) => {
      if (name !== 'archived') values[name as ClientCsvColumn] = undoFormulaPrefix(cells[i] ?? '');
    });
    return values;
  });
}

/** No trimming or case conversion: only the specified CSV representation is decoded. */
export function clientWriteFromCsv(v: ClientCsvValues): ClientWrite {
  const nullable = (value: string) => (value === '' ? null : value);
  const hasAddress = CLIENT_CSV_COLUMNS.some(
    (name) => name.startsWith('billing_') && v[name] !== '',
  );
  return {
    kind: v.kind === 'person' ? 'individual' : (v.kind as ClientWrite['kind']),
    displayName: v.display_name,
    legalName: nullable(v.legal_name),
    vatNumber: nullable(v.vat_number),
    taxId: nullable(v.tax_id),
    email: nullable(v.email),
    phone: nullable(v.phone),
    website: nullable(v.website),
    notes: nullable(v.notes),
    defaultCurrency: nullable(v.default_currency),
    defaultLanguage: nullable(v.default_language),
    paymentTermsDays: v.payment_terms_days === '' ? null : Number(v.payment_terms_days),
    acceptsEInvoices: v.accepts_e_invoices === 'true',
    addresses: hasAddress
      ? [
          {
            kind: 'billing',
            line1: v.billing_line1,
            line2: nullable(v.billing_line2),
            city: v.billing_city,
            region: nullable(v.billing_region),
            postalCode: nullable(v.billing_postal_code),
            countryCode: v.billing_country_code,
            isDefault: true,
          },
        ]
      : [],
  };
}

const inputToColumn: Record<string, ClientCsvColumn> = {
  displayName: 'display_name',
  legalName: 'legal_name',
  vatNumber: 'vat_number',
  taxId: 'tax_id',
  defaultCurrency: 'default_currency',
  defaultLanguage: 'default_language',
  paymentTermsDays: 'payment_terms_days',
  acceptsEInvoices: 'accepts_e_invoices',
  line1: 'billing_line1',
  line2: 'billing_line2',
  city: 'billing_city',
  region: 'billing_region',
  postalCode: 'billing_postal_code',
  countryCode: 'billing_country_code',
};

const emailSchema = z.email();

export function validateCsvRow(v: ClientCsvValues): ImportMessage[] {
  const messages: ImportMessage[] = [];
  const add = (field: string, code: string, message = `${field}: ${code}`) => {
    if (!messages.some((m) => m.field === field)) messages.push({ field, code, message });
  };
  for (const field of CLIENT_CSV_COLUMNS) {
    if (/[\uD800-\uDFFF]/u.test(v[field])) add(field, 'invalid_unicode');
    if (v[field].length > CLIENT_CSV_FIELD_LIMITS[field]) add(field, 'too_long');
  }
  if (v.kind === '') add('kind', 'required');
  else if (v.kind !== 'organisation' && v.kind !== 'person') add('kind', 'invalid_kind');
  if (!normalizeForDuplicateCheck(v.display_name)) add('display_name', 'required');
  if (v.email && !emailSchema.safeParse(v.email).success) add('email', 'invalid_email');
  if (v.default_language && !['en', 'el'].includes(v.default_language))
    add('default_language', 'invalid_language');
  if (v.default_currency && !/^[A-Z]{3}$/.test(v.default_currency))
    add('default_currency', 'invalid_currency');
  if (
    v.payment_terms_days &&
    (!/^[0-9]+$/.test(v.payment_terms_days) || Number(v.payment_terms_days) > 3650)
  )
    add(
      'payment_terms_days',
      'invalid_payment_terms',
      'payment_terms_days: use whole days from 0 to 3650 (0 means due on receipt)',
    );
  if (v.accepts_e_invoices && !['true', 'false'].includes(v.accepts_e_invoices))
    add('accepts_e_invoices', 'invalid_boolean');
  const parsed = clientCreate.safeParse(clientWriteFromCsv(v));
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const key = String(issue.path.at(-1));
      const field = inputToColumn[key] ?? key;
      add(
        field,
        field === 'billing_country_code'
          ? v.billing_country_code
            ? 'invalid_country'
            : 'required'
          : 'invalid_value',
      );
    }
  return messages;
}

/** Index all earlier file rows, including invalid ones, using their original values. */
export class ClientDuplicateIndex {
  private readonly fields = ['display_name', 'email', 'vat_number'] as const;
  private readonly matches = this.fields.map(() => new Map<string, string>());
  constructor(clients: DuplicateClient[]) {
    for (const client of clients) {
      [client.nameNormalized, client.emailNormalized, client.vatNormalized].forEach((key, i) => {
        if (key) this.matches[i]?.set(key, `client ${client.id}`);
      });
    }
  }
  find(values: ClientCsvValues): ImportMessage[] {
    return this.fields.flatMap((field, i) => {
      const match = this.matches[i]?.get(normalizeForDuplicateCheck(values[field]));
      return match ? [{ field, code: 'duplicate', message: `Matches ${match}` }] : [];
    });
  }
  add(values: ClientCsvValues, number: number): void {
    this.fields.forEach((field, i) => {
      const key = normalizeForDuplicateCheck(values[field]);
      const index = this.matches[i];
      if (key && !index?.has(key)) index?.set(key, `row ${String(number)}`);
    });
  }
}

/** Keep whole code points within the schema's UTF-16 limit; invalid cells are preview-only. */
function boundedCsvValue(value: string, limit: number): string {
  const splitsPair =
    /[\uD800-\uDBFF]/.test(value.charAt(limit - 1)) && /[\uDC00-\uDFFF]/.test(value.charAt(limit));
  return value.slice(0, splitsPair ? limit - 1 : limit).replace(/[\uD800-\uDFFF]/gu, '\uFFFD');
}

export function classifyRows(values: ClientCsvValues[], clients: DuplicateClient[]): ImportRow[] {
  const duplicates = new ClientDuplicateIndex(clients);
  let storedBytes = 2; // JSON array brackets; measure UTF-8 and JSON escapes, not string length.
  return values.map((value, i) => {
    const number = i + 2;
    const errors = validateCsvRow(value);
    const messages = errors.length ? errors : duplicates.find(value);
    const status = errors.length ? 'error' : messages.length ? 'duplicate' : 'new';
    duplicates.add(value, number);
    const boundedValues = Object.fromEntries(
      CLIENT_CSV_COLUMNS.map((field) => [
        field,
        boundedCsvValue(value[field], CLIENT_CSV_FIELD_LIMITS[field]),
      ]),
    ) as ClientCsvValues;
    const row: ImportRow = { number, status, values: boundedValues, messages };
    storedBytes += Buffer.byteLength(JSON.stringify(row), 'utf8') + (i === 0 ? 0 : 1);
    if (storedBytes > MAX_CLIENT_PREVIEW_BYTES)
      throw csvError('preview_too_large', 'The stored preview exceeds 16 MiB');
    return row;
  });
}

export function importCounts(rows: ImportRow[]): ImportCounts {
  return rows.reduce(
    (counts, row) => {
      counts[row.status]++;
      return counts;
    },
    { new: 0, duplicate: 0, error: 0 },
  );
}
