import { describe, expect, it } from 'vitest';
import { addDaysToBusinessDate } from '../time/business-date';
import {
  ageingBucket,
  ageingReport,
  collectedReport,
  invoicedReport,
  type AgeingInvoice,
  type AgeingSource,
  type InvoicedDocument,
} from './finance';

const asOf = '2026-03-31';
const client = { clientId: 'client-a', clientName: 'Fictional client A', currency: 'EUR' };
const allocation = { amount: '40.00', from: asOf, until: '2026-04-01' };
const invoice = (fields: Partial<AgeingInvoice> = {}): AgeingInvoice => ({
  ...client,
  id: 'invoice-a',
  number: 'F-1',
  issueDate: '2026-01-01',
  dueDate: asOf,
  total: '100.00',
  allocations: [],
  ...fields,
});
const source = (fields: Partial<AgeingSource> = {}): AgeingSource => ({
  ...client,
  id: 'payment-a',
  type: 'payment',
  date: '2026-01-01',
  voidedOn: null,
  amount: '100.00',
  allocations: [],
  refunds: [],
  ...fields,
});

describe('finance reports', () => {
  it.each([
    [-1, 'current'],
    [0, 'current'],
    [1, 'days1To30'],
    [30, 'days1To30'],
    [31, 'days31To60'],
    [60, 'days31To60'],
    [61, 'days61To90'],
    [90, 'days61To90'],
    [91, 'over90'],
  ] as const)('buckets %i days past due', (days, expected) => {
    expect(ageingBucket(addDaysToBusinessDate(asOf, -days), asOf)).toBe(expected);
    expect(
      ageingReport([invoice({ dueDate: addDaysToBusinessDate(asOf, -days) })], [], asOf)[0],
    ).toMatchObject({
      buckets: { [expected]: { amount: '100.00' } },
      openTotal: { amount: '100.00' },
    });
  });

  it('counts an allocation on D and its reversal only from the reversal date', () => {
    const rows = [invoice({ allocations: [allocation] })];
    expect(ageingReport(rows, [], '2026-03-30')[0]?.openTotal.amount).toBe('100.00');
    expect(ageingReport(rows, [], asOf)[0]?.openTotal.amount).toBe('60.00');
    expect(ageingReport(rows, [], '2026-04-01')[0]?.openTotal.amount).toBe('100.00');
  });

  it('keeps a payment voided after D as credit on D, with historical allocations and refunds', () => {
    const rows = [
      source({
        voidedOn: '2026-04-02',
        allocations: [allocation],
        refunds: [{ amount: '10.00', from: asOf, until: '2026-04-01' }],
      }),
    ];
    expect(ageingReport([], rows, '2026-03-30')[0]?.creditTotal.amount).toBe('100.00');
    expect(ageingReport([], rows, asOf)[0]?.creditTotal.amount).toBe('50.00');
    expect(ageingReport([], rows, '2026-04-01')[0]?.creditTotal.amount).toBe('100.00');
    expect(ageingReport([], rows, '2026-04-02')).toEqual([]);
  });

  it('omits future invoices and sources and fully used sources; retains credit-only clients', () => {
    const report = ageingReport(
      [
        invoice({ issueDate: '2026-04-01' }),
        invoice({ id: 'paid', allocations: [{ ...allocation, amount: '100.00' }] }),
      ],
      [
        source({ date: '2026-04-01' }),
        source({ id: 'used', amount: '40.00', allocations: [allocation] }),
        source({ id: 'credit', type: 'credit_note', amount: '20.01' }),
      ],
      asOf,
    );
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({
      openTotal: { amount: '0.00' },
      creditTotal: { amount: '20.01' },
      clients: [{ invoices: [], credits: [{ id: 'credit', remaining: { amount: '20.01' } }] }],
    });
  });

  it('subtracts credit notes per tax code id and retains snapshot labels when codes are renamed', () => {
    const standard = {
      taxCodeId: 'standard',
      code: 'STD19',
      name: 'Fictional standard VAT',
      net: '100.00',
      tax: '19.00',
      gross: '119.00',
    };
    const reduced = {
      taxCodeId: 'reduced',
      code: 'RED9',
      name: 'Fictional reduced VAT',
      net: '100.00',
      tax: '9.00',
      gross: '109.00',
    };
    const documents: InvoicedDocument[] = [
      { documentType: 'invoice', currency: 'EUR', taxSummary: [standard, reduced] },
      {
        documentType: 'invoice',
        currency: 'EUR',
        taxSummary: [{ ...standard, code: 'RENAMED', name: 'Renamed standard' }],
      },
      {
        documentType: 'credit_note',
        currency: 'EUR',
        taxSummary: [{ ...standard, net: '20.00', tax: '3.80', gross: '23.80' }],
      },
    ];
    expect(invoicedReport(documents)).toMatchObject([
      {
        currency: 'EUR',
        invoiced: { count: 2, net: '300.00', tax: '47.00', gross: '347.00' },
        credited: { count: 1, net: '20.00', tax: '3.80', gross: '23.80' },
        totals: { net: '280.00', tax: '43.20', gross: '323.20' },
        taxCodes: [
          {
            taxCodeId: 'reduced',
            code: 'RED9',
            totals: { net: '100.00', tax: '9.00', gross: '109.00' },
          },
          {
            taxCodeId: 'standard',
            code: 'STD19',
            name: 'Fictional standard VAT',
            totals: { net: '180.00', tax: '34.20', gross: '214.20' },
          },
        ],
      },
    ]);
  });

  it('groups refunds by their own method, even when there are no payments in that method', () => {
    expect(
      collectedReport([
        { kind: 'payment', currency: 'EUR', method: 'bank_transfer', amount: '100.01' },
        { kind: 'refund', currency: 'EUR', method: 'cash', amount: '20.02' },
      ]),
    ).toMatchObject([
      {
        payments: { amount: '100.01', count: 1 },
        refunds: { amount: '20.02', count: 1 },
        total: { amount: '79.99' },
        methods: [
          { method: 'bank_transfer', total: { amount: '100.01' } },
          { method: 'cash', total: { amount: '-20.02' } },
        ],
      },
    ]);
  });

  it('keeps currencies separate and preserves cents beyond JS safe integers', () => {
    const report = ageingReport(
      [
        invoice({
          total: '99999999999999999.99',
          allocations: [{ ...allocation, amount: '0.01' }],
        }),
        invoice({ currency: 'USD', total: '0.02' }),
      ],
      [source({ amount: '0.03' }), source({ currency: 'USD', amount: '0.01' })],
      asOf,
    );
    expect(
      report.map((row) => [row.currency, row.openTotal.amount, row.creditTotal.amount]),
    ).toEqual([
      ['EUR', '99999999999999999.98', '0.03'],
      ['USD', '0.02', '0.01'],
    ]);
    expect(
      collectedReport([
        { kind: 'payment', currency: 'EUR', method: 'cash', amount: '99999999999999999.99' },
        { kind: 'refund', currency: 'EUR', method: 'cash', amount: '0.01' },
        { kind: 'payment', currency: 'USD', method: 'cash', amount: '0.02' },
      ]).map((row) => [row.currency, row.total.amount]),
    ).toEqual([
      ['EUR', '99999999999999999.98'],
      ['USD', '0.02'],
    ]);
  });

  it('returns no currency groups for empty input', () => {
    expect(invoicedReport([])).toEqual([]);
    expect(collectedReport([])).toEqual([]);
    expect(ageingReport([], [], asOf)).toEqual([]);
  });
});
