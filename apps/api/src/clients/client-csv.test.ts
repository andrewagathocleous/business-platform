import { describe, expect, it } from 'vitest';
import { CommerceError } from '../commerce/errors';
import {
  CLIENT_CSV_COLUMNS,
  CLIENT_CSV_FIELD_LIMITS,
  MAX_CLIENT_PREVIEW_BYTES,
  classifyRows,
  clientWriteFromCsv,
  parseClientCsv,
  parseCsv,
  undoFormulaPrefix,
  validateCsvRow,
} from './client-csv';

const values = (extra: Record<string, string> = {}) => {
  const row = parseClientCsv('kind,display_name\nperson,Client (fictional)')[0];
  if (!row) throw new Error('Missing fixture row');
  return { ...row, ...extra };
};

describe('RFC 4180 client CSV parser', () => {
  it.each(['\r\n', '\n'])(
    'accepts %j records, a BOM, Greek, commas, quotes and empty cells',
    (eol) => {
      expect(parseCsv(`\uFEFFa,b,c,d${eol}"Ελληνικά, κείμενο","a""b",,${eol}`)).toEqual([
        ['a', 'b', 'c', 'd'],
        ['Ελληνικά, κείμενο', 'a"b', '', ''],
      ]);
    },
  );
  it('keeps embedded LF, CRLF, CR, leading spaces and trailing whitespace', () => {
    expect(parseCsv('a\n"  α\nβ\r\nγ\rδ  "')).toEqual([['a'], ['  α\nβ\r\nγ\rδ  ']]);
  });
  it('keeps a quoted empty cell and the final empty cell', () => {
    expect(parseCsv('a,b\n"",')).toEqual([
      ['a', 'b'],
      ['', ''],
    ]);
  });
  it.each(['a\n"unclosed', 'a\nnot"quoted', 'a\n"closed"extra', 'a\rb'])(
    'rejects malformed quoting or records: %j',
    (text) => {
      expect(() => parseCsv(text)).toThrow(CommerceError);
    },
  );
  it('allows a header alone and counts records rather than embedded newlines', () => {
    expect(parseClientCsv('kind,display_name')).toEqual([]);
    expect(parseCsv('header\n"a\nb"', 1)).toHaveLength(2);
    expect(() => parseCsv('header\na\nb', 1)).toThrow('At most 5,000');
  });
  it('accepts free column order, optional columns and ignores archived', () => {
    expect(
      parseClientCsv('display_name,archived,kind\nClient (fictional),anything,person')[0],
    ).toMatchObject({ kind: 'person', display_name: 'Client (fictional)', email: '' });
  });
  it.each([
    ['', 'Header row required'],
    ['kind,display_name,wat,other', 'Unknown columns: wat, other'],
    ['kind,kind,display_name', 'Repeated header'],
    ['kind\nperson', 'Missing columns: display_name'],
    ['kind,display_name\nperson', 'wrong column count'],
    ['kind,display_name\nperson,Name,extra', 'wrong column count'],
  ])('rejects an invalid layout: %j', (text, message) => {
    expect(() => parseClientCsv(text)).toThrow(message);
  });
});

describe('formula-prefix undo', () => {
  it.each(['=', '+', '-', '@', '\t', '\r'])(
    'removes exactly one apostrophe before %j',
    (prefix) => {
      expect(undoFormulaPrefix(`'${prefix}Ελληνικά`)).toBe(`${prefix}Ελληνικά`);
    },
  );
  it.each(["'text", "''=formula", ' =formula', 'normal', "'", '\ntext'])('preserves %j', (text) => {
    expect(undoFormulaPrefix(text)).toBe(text);
  });
});

describe('row validation and classification', () => {
  it('maps person to individual and preserves customer text and billing address', () => {
    const v = values({
      notes: '  Ελληνικά\r\n  λέξεις  ',
      billing_line1: '  1 Fictional St ',
      billing_city: 'Λευκωσία',
      billing_country_code: 'CY',
      accepts_e_invoices: 'true',
    });
    expect(validateCsvRow(v)).toEqual([]);
    expect(clientWriteFromCsv(v)).toMatchObject({
      kind: 'individual',
      notes: v.notes,
      acceptsEInvoices: true,
      addresses: [
        {
          kind: 'billing',
          line1: v.billing_line1,
          city: v.billing_city,
          countryCode: 'CY',
          isDefault: true,
        },
      ],
    });
  });
  it.each([
    ['kind', '', 'required'],
    ['kind', 'individual', 'invalid_kind'],
    ['display_name', ' \t', 'required'],
    ['email', 'invalid', 'invalid_email'],
    ['email', 'two..dots@example.test', 'invalid_email'],
    ['email', 'user@-domain.test', 'invalid_email'],
    ['default_language', 'fr', 'invalid_language'],
    ['default_currency', 'EU', 'invalid_currency'],
    ['default_currency', 'eur', 'invalid_currency'],
    ['payment_terms_days', '-1', 'invalid_payment_terms'],
    ['payment_terms_days', '1.5', 'invalid_payment_terms'],
    ['payment_terms_days', '2e1', 'invalid_payment_terms'],
    ['payment_terms_days', '3651', 'invalid_payment_terms'],
    ['accepts_e_invoices', 'yes', 'invalid_boolean'],
    ['vat_number', 'X'.repeat(41), 'too_long'],
    ['email', `${'x'.repeat(320)}@example.test`, 'too_long'],
  ])('validates %s = %j', (field, value, code) => {
    expect(validateCsvRow(values({ [field]: value }))).toContainEqual(
      expect.objectContaining({ field, code }),
    );
  });
  it('requires a country, line1 and city when any address field is supplied', () => {
    expect(
      validateCsvRow(values({ billing_line2: 'extra' }))
        .map((m) => m.field)
        .sort(),
    ).toEqual(['billing_city', 'billing_country_code', 'billing_line1']);
  });
  it.each(['', '0', '1', '3650'])(
    'accepts whole payment terms including due on receipt: %j',
    (terms) => {
      expect(validateCsvRow(values({ payment_terms_days: terms }))).toEqual([]);
      expect(clientWriteFromCsv(values({ payment_terms_days: terms })).paymentTermsDays).toBe(
        terms === '' ? null : Number(terms),
      );
    },
  );
  it('explains the nonnegative payment terms rule', () => {
    expect(validateCsvRow(values({ payment_terms_days: '-1' }))).toContainEqual({
      field: 'payment_terms_days',
      code: 'invalid_payment_terms',
      message: 'payment_terms_days: use whole days from 0 to 3650 (0 means due on receipt)',
    });
  });
  it('accepts optional blanks, the language choices, three-letter currency and both booleans', () => {
    for (const default_language of ['en', 'el', ''])
      for (const accepts_e_invoices of ['true', 'false', '']) {
        expect(
          validateCsvRow(
            values({
              default_language,
              accepts_e_invoices,
              default_currency: 'EUR',
              payment_terms_days: '3650',
              vat_number: 'FICTIONAL',
            }),
          ),
        ).toEqual([]);
      }
  });
  it('reports existing and earlier-row matches by normalised name, email and VAT; errors take precedence', () => {
    const rows = classifyRows(
      [
        values({ display_name: 'Νέος (fictional)', email: 'new@example.test' }),
        values({ display_name: '  ΝΈΟΣ  (fictional)  ' }),
        values({ display_name: 'Other (fictional)', email: 'NEW@example.test' }),
        values({ display_name: 'Existing match (fictional)', vat_number: 'fictional-vat' }),
        values({ email: 'invalid' }),
      ],
      [
        {
          id: 'existing',
          nameNormalized: 'existing (fictional)',
          emailNormalized: null,
          vatNormalized: 'fictional-vat',
        },
      ],
    );
    expect(rows.map((row) => row.status)).toEqual([
      'new',
      'duplicate',
      'duplicate',
      'duplicate',
      'error',
    ]);
    expect(rows[1]?.messages[0]).toMatchObject({
      field: 'display_name',
      code: 'duplicate',
      message: 'Matches row 2',
    });
    expect(rows[2]?.messages[0]?.field).toBe('email');
    expect(rows[3]?.messages[0]?.message).toBe('Matches client existing');
    expect(rows[4]?.messages[0]?.code).toBe('invalid_email');
  });
  it('includes earlier invalid rows when detecting file duplicates', () => {
    const rows = classifyRows([values({ email: 'invalid' }), values()], []);
    expect(rows.map((row) => row.status)).toEqual(['error', 'duplicate']);
  });
  it.each(Object.entries(CLIENT_CSV_FIELD_LIMITS))(
    'marks an oversized %s as a row error and bounds its stored value to %i characters',
    (field, limit) => {
      const original = 'x'.repeat(limit + 1);
      const row = classifyRows([values({ [field]: original })], [])[0];
      expect(row).toMatchObject({
        status: 'error',
        values: { [field]: original.slice(0, limit) },
        messages: expect.arrayContaining([
          expect.objectContaining({ field, code: 'too_long' }),
        ]) as unknown,
      });
    },
  );
  it.each(['display_name', 'notes'] as const)(
    'caps %s before a surrogate pair that crosses the UTF-16 limit',
    (field) => {
      const prefix = 'x'.repeat(CLIENT_CSV_FIELD_LIMITS[field] - 1);
      const row = classifyRows([values({ [field]: `${prefix}😀` })], [])[0];
      expect(row).toMatchObject({
        status: 'error',
        values: { [field]: prefix },
        messages: [expect.objectContaining({ field, code: 'too_long' })],
      });
      expect(JSON.stringify(row)).not.toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/);
    },
  );
  it.each(['display_name', 'notes'] as const)(
    'keeps a complete surrogate pair within the %s UTF-16 limit',
    (field) => {
      const original = `${'x'.repeat(CLIENT_CSV_FIELD_LIMITS[field] - 2)}😀`;
      expect(classifyRows([values({ [field]: original })], [])[0]).toMatchObject({
        status: 'new',
        values: { [field]: original },
        messages: [],
      });
    },
  );
  it.each(CLIENT_CSV_COLUMNS)(
    'marks uploaded lone high and low surrogates in %s as a row error with JSON-safe preview text',
    (field) => {
      const original = '\uD800x\uDC00';
      const source = values({ [field]: original });
      const parsed = parseClientCsv(
        `${CLIENT_CSV_COLUMNS.join(',')}\n${CLIENT_CSV_COLUMNS.map((column) => source[column]).join(',')}`,
      );
      const row = classifyRows(parsed, [])[0];
      expect(row).toMatchObject({
        status: 'error',
        messages: expect.arrayContaining([
          expect.objectContaining({ field, code: 'invalid_unicode' }),
        ]) as unknown,
      });
      expect(row?.values[field]).toBe('\uFFFDx\uFFFD'.slice(0, CLIENT_CSV_FIELD_LIMITS[field]));
      expect(JSON.stringify(row)).not.toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/);
    },
  );
  it('bounds the 128 KiB name followed by 4,999 matches without repeating the matched values', () => {
    const display_name = 'x'.repeat(128 * 1024);
    const email = 'review-case@example.test';
    const rows = classifyRows(
      [
        values({ display_name, email }),
        ...Array.from({ length: 4999 }, (_, i) =>
          values({ display_name: `Review ${String(i)} (fictional)`, email }),
        ),
      ],
      [],
    );
    expect(rows[0]).toMatchObject({
      status: 'error',
      values: { display_name: display_name.slice(0, 500) },
    });
    expect(rows.slice(1).every((row) => row.status === 'duplicate')).toBe(true);
    expect(rows.slice(1).every((row) => row.messages[0]?.message === 'Matches row 2')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThan(4 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThan(MAX_CLIENT_PREVIEW_BYTES);
  });
  it.each([
    { character: '\u0001', count: 150, representation: 'JSON escapes' },
    { character: 'α', count: 450, representation: 'UTF-8 bytes' },
  ])('refuses more than 16 MiB of stored JSON counting $representation', ({ character, count }) => {
    // Each cell fits its schema limit; encoding expands controls sixfold and Greek twofold.
    const row = values({ notes: character.repeat(20_000) });
    try {
      classifyRows(
        Array.from({ length: count }, () => row),
        [],
      );
      expect.fail('Expected a preview size refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(CommerceError);
      expect(error).toMatchObject({ status: 422, reason: 'preview_too_large' });
    }
    expect(() =>
      classifyRows(
        Array.from({ length: 100 }, () => row),
        [],
      ),
    ).not.toThrow();
  });
});
