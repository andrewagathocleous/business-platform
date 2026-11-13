import { describe, expect, it } from 'vitest';
import { documentTotalsSchema } from '../contracts/document';
import { currencyMinorDigits, isKnownCurrency } from './currency';
import { AmountError, parseAmount, round2 } from './parse';
import { calculateDocumentTotals, DocumentValidationError, type DocumentLineInput } from './totals';

function line(overrides: Partial<DocumentLineInput> = {}): DocumentLineInput {
  return {
    position: 1,
    quantity: '1',
    unitPrice: '0',
    discountPercent: '0',
    taxCode: 'T',
    taxRatePercent: '0',
    ...overrides,
  };
}

function totals(pricesIncludeTax: boolean, lines: DocumentLineInput[]) {
  return calculateDocumentTotals({ pricesIncludeTax, lines });
}

describe('isKnownCurrency', () => {
  it('accepts currencies Intl lists and rejects everything else', () => {
    expect(isKnownCurrency('EUR')).toBe(true);
    expect(isKnownCurrency('USD')).toBe(true);
    expect(isKnownCurrency('ZZZ')).toBe(false);
    expect(isKnownCurrency('EURO')).toBe(false);
  });
});

describe('currencyMinorDigits', () => {
  it('accepts two-digit currencies and rejects every other precision', () => {
    expect(currencyMinorDigits('EUR')).toBe(2);
    expect(currencyMinorDigits('USD')).toBe(2);
    expect(currencyMinorDigits('KWD')).toBe(3);
    expect(currencyMinorDigits('JPY')).toBe(0);
    expect(currencyMinorDigits('kwd')).toBeUndefined();
    expect(currencyMinorDigits('EURO')).toBeUndefined();
  });
});

describe('parseAmount and round2', () => {
  it('rounds half up away from zero', () => {
    expect(round2(parseAmount('0.125')).toFixed(2)).toBe('0.13');
    expect(round2(parseAmount('0.005', 3)).toFixed(2)).toBe('0.01');
    expect(round2(parseAmount('-0.125')).toFixed(2)).toBe('-0.13');
  });

  it('rejects numbers, non-finite input and more than 4 decimal places', () => {
    expect(() => parseAmount(1.25)).toThrow(AmountError);
    expect(() => parseAmount(Number.NaN)).toThrow(AmountError);
    expect(() => parseAmount('Infinity')).toThrow(AmountError);
    expect(() => parseAmount('1e2')).toThrow(AmountError);
    expect(() => parseAmount('1.23456')).toThrow(AmountError);
    expect(parseAmount('1.2345').toFixed(4)).toBe('1.2345');
  });
});

describe('calculateDocumentTotals worked examples', () => {
  it('E1 exclusive 3 × 0.3333 @19%', () => {
    const result = totals(false, [
      line({ quantity: '3', unitPrice: '0.3333', taxCode: 'STD', taxRatePercent: '19' }),
    ]);
    expect(result).toMatchObject({
      subtotal: '1.00',
      taxTotal: '0.19',
      total: '1.19',
      netTotal: '1.00',
    });
  });

  it('E2 exclusive 1 × 0.125 @0% rounds half up', () => {
    const result = totals(false, [line({ unitPrice: '0.125', taxRatePercent: '0' })]);
    expect(result).toMatchObject({ netTotal: '0.13', taxTotal: '0.00', total: '0.13' });
  });

  it('E3 exclusive 1 × 0.005 @0%', () => {
    const result = totals(false, [line({ unitPrice: '0.005', taxRatePercent: '0' })]);
    expect(result).toMatchObject({ netTotal: '0.01', total: '0.01' });
  });

  it('E4 exclusive 2 × 10.00 with 15% discount @19%', () => {
    const result = totals(false, [
      line({ quantity: '2', unitPrice: '10.00', discountPercent: '15', taxRatePercent: '19' }),
    ]);
    expect(result).toMatchObject({
      subtotal: '20.00',
      discountTotal: '3.00',
      netTotal: '17.00',
      taxTotal: '3.23',
      total: '20.23',
    });
  });

  it('E5 exclusive two tax rates', () => {
    const result = totals(false, [
      line({ position: 1, unitPrice: '10.00', taxCode: 'STD', taxRatePercent: '19' }),
      line({ position: 2, unitPrice: '5.00', taxCode: 'RED', taxRatePercent: '9' }),
    ]);
    expect(result.taxSummary.map((group) => group.tax)).toEqual(['0.45', '1.90']);
    expect(result).toMatchObject({ taxTotal: '2.35', total: '17.35' });
  });

  it('E6 inclusive 1 × 11.90 @19%', () => {
    const result = totals(true, [line({ unitPrice: '11.90', taxRatePercent: '19' })]);
    expect(result).toMatchObject({ netTotal: '10.00', taxTotal: '1.90', total: '11.90' });
    expect(result.lines[0]).toMatchObject({ lineNet: '10.00', lineGross: '11.90' });
  });

  it('E7 inclusive three 0.99 lines allocate the extra cent to the lowest position', () => {
    const result = totals(true, [
      line({ position: 1, unitPrice: '0.99', taxRatePercent: '19' }),
      line({ position: 2, unitPrice: '0.99', taxRatePercent: '19' }),
      line({ position: 3, unitPrice: '0.99', taxRatePercent: '19' }),
    ]);
    expect(result).toMatchObject({ total: '2.97', netTotal: '2.50', taxTotal: '0.47' });
    expect(result.lines.map((item) => item.lineNet)).toEqual(['0.84', '0.83', '0.83']);
  });

  it('E13 inclusive remainders that are exactly equal go to the lower position', () => {
    // 0.27 and 0.06 at 5 % both leave 0.0071428… of a cent; division at 40 digits used to
    // make them unequal and give the cent to position 2.
    const result = totals(true, [
      line({ position: 1, unitPrice: '0.27', taxRatePercent: '5' }),
      line({ position: 2, unitPrice: '0.06', taxRatePercent: '5' }),
    ]);
    expect(result.taxSummary[0]).toMatchObject({ net: '0.31', tax: '0.02', gross: '0.33' });
    expect(result.lines.map((item) => item.lineNet)).toEqual(['0.26', '0.05']);
  });

  it('E8 exclusive tax is rounded once per group', () => {
    const result = totals(false, [
      line({ position: 1, unitPrice: '0.05', taxRatePercent: '19' }),
      line({ position: 2, unitPrice: '0.05', taxRatePercent: '19' }),
      line({ position: 3, unitPrice: '0.05', taxRatePercent: '19' }),
    ]);
    expect(result.taxSummary[0]).toMatchObject({ net: '0.15', tax: '0.03' });
    expect(result.total).toBe('0.18');
  });

  it('E9 exclusive 100% discount', () => {
    const result = totals(false, [
      line({ unitPrice: '50.00', discountPercent: '100', taxRatePercent: '19' }),
    ]);
    expect(result).toMatchObject({ netTotal: '0.00', taxTotal: '0.00', total: '0.00' });
  });

  it('E10 exclusive stays exact at the numeric(19,2) ceiling', () => {
    const result = totals(false, [
      line({ quantity: '1000000', unitPrice: '9999999.9999', taxRatePercent: '19' }),
    ]);
    expect(result).toMatchObject({
      subtotal: '9999999999900.00',
      taxTotal: '1899999999981.00',
      total: '11899999999881.00',
    });
  });

  it('E12 exclusive groups by tax code, not by rate', () => {
    const result = totals(false, [
      line({ position: 1, unitPrice: '0.03', taxCode: 'STD19', taxRatePercent: '19' }),
      line({ position: 2, unitPrice: '0.03', taxCode: 'ALT19', taxRatePercent: '19' }),
    ]);
    expect(result.taxSummary.map((group) => group.tax)).toEqual(['0.01', '0.01']);
    expect(result).toMatchObject({ taxTotal: '0.02', total: '0.08', netTotal: '0.06' });
  });

  it('E11 rejects quantity 0, a negative price, discount 101 and a 5-dp quantity', () => {
    expect(codeOf(() => totals(false, [line({ quantity: '0' })]))).toBe('quantity_not_positive');
    expect(codeOf(() => totals(false, [line({ unitPrice: '-1.00' })]))).toBe('unit_price_negative');
    expect(codeOf(() => totals(false, [line({ discountPercent: '101' })]))).toBe(
      'discount_out_of_range',
    );
    expect(codeOf(() => totals(false, [line({ quantity: '1.00000' })]))).toBe('quantity_scale');
  });
});

describe('document totals schema', () => {
  it('rejects a JSON number in a money field', () => {
    const parsed = documentTotalsSchema.safeParse({
      pricesIncludeTax: false,
      lines: [{ ...line(), quantity: 1 }],
    });
    expect(parsed.success).toBe(false);
  });
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentValidationError);
    return (error as DocumentValidationError).code;
  }
  throw new Error('expected a validation error');
}
