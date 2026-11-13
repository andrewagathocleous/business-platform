import { convertToParamMap } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { invalidInvoiceFilters, invoicesHttpParams, parseInvoiceQuery } from './invoice-query';

describe('parseInvoiceQuery', () => {
  it('keeps only the money-owing payment filter', () => {
    const open = parseInvoiceQuery(convertToParamMap({ payment: 'open' }));
    expect(open.payment).toBe('open');
    expect(invoicesHttpParams(open).get('payment')).toBe('open');
    const invalid = convertToParamMap({ payment: 'paid' });
    expect(parseInvoiceQuery(invalid).payment).toBe('');
    expect(invalidInvoiceFilters(invalid)).toEqual(['payment']);
  });

  it('drops an impossible date and keeps the valid status', () => {
    const dated = convertToParamMap({ status: 'issued', from: '2026-13-01' });
    const parsed = parseInvoiceQuery(dated);
    expect(parsed.status).toBe('issued');
    expect(parsed.from).toBe('');
    expect(invoicesHttpParams(parsed).get('status')).toBe('issued');
    expect(invoicesHttpParams(parsed).get('from')).toBeNull();
  });

  it('drops a 201-character search and keeps the valid status', () => {
    const searched = convertToParamMap({ q: 'a'.repeat(201), status: 'issued' });
    const parsed = parseInvoiceQuery(searched);
    expect(parsed.q).toBe('');
    expect(parsed.status).toBe('issued');
    expect(invoicesHttpParams(parsed).get('q')).toBeNull();
    expect(invoicesHttpParams(parsed).get('status')).toBe('issued');
  });

  it('keeps a real calendar date', () => {
    const params = convertToParamMap({ from: '2026-10-21', to: '2026-10-21' });
    expect(parseInvoiceQuery(params)).toMatchObject({ from: '2026-10-21', to: '2026-10-21' });
  });

  it('keeps the not-delivered filter and reports any other delivery value', () => {
    const pending = parseInvoiceQuery(convertToParamMap({ delivery: 'pending' }));
    expect(pending.delivery).toBe('pending');
    expect(invoicesHttpParams(pending).get('delivery')).toBe('pending');
    const other = convertToParamMap({ delivery: 'late' });
    expect(parseInvoiceQuery(other).delivery).toBe('');
    expect(invalidInvoiceFilters(other)).toEqual(['delivery']);
  });
});
