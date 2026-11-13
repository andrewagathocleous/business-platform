import { describe, expect, it } from 'vitest';
import { AmountError } from '../money/parse';
import {
  allocationEffectiveOn,
  countedOn,
  currentTotal,
  openBalance,
  paymentState,
  refundAllowed,
  sourceRemaining,
  type DatedAmount,
  type DatedSettlementSource,
} from './settlement';

const february = '2026-02-01';
const march = '2026-03-10';
const today = '2026-03-20';
const item = (amount: string, from = february, until: string | null = null): DatedAmount => ({
  amount,
  from,
  until,
});
const source = (fields: Partial<DatedSettlementSource> = {}): DatedSettlementSource => ({
  amount: '100.00',
  date: february,
  allocations: [],
  refunds: [],
  ...fields,
});
const invoice = (allocations: DatedAmount[] = [], total = '100.00', issueDate = february) => ({
  total,
  issueDate,
  allocations,
});

describe('settlement', () => {
  it('counts from inclusive and until exclusive, and current ignores the start date', () => {
    const items = [
      item('40.01', february, march),
      item('59.99', march),
      item('0.01', '2026-04-01'),
    ];
    expect(countedOn(items, '2026-01-31')).toBe('0.00');
    expect(countedOn(items, february)).toBe('40.01');
    expect(countedOn(items, march)).toBe('59.99');
    expect(currentTotal(items)).toBe('60.00');
    expect(countedOn([], today)).toBe('0.00');
    expect(currentTotal([])).toBe('0.00');
  });

  it('a February payment allocated then voided in March makes its February replacement effective in March', () => {
    const oldAllocation = item('100.00', february, march);
    expect(
      allocationEffectiveOn({
        amount: '100.00',
        today,
        source: source(),
        invoice: invoice([oldAllocation]),
      }),
    ).toBe(march);
  });

  it('credit moved from invoice A in March becomes effective on invoice B in March', () => {
    const oldAllocation = item('100.00', february, march);
    expect(
      allocationEffectiveOn({
        amount: '100.00',
        today,
        source: source({ allocations: [oldAllocation] }),
        invoice: invoice(),
      }),
    ).toBe(march);
  });

  it('refunding a payment’s unallocated 100.00 leaves nothing to allocate', () => {
    const refunded = source({ refunds: [item('100.00')] });
    expect(sourceRemaining(refunded)).toBe('0.00');
    expect(
      allocationEffectiveOn({ amount: '0.01', today, source: refunded, invoice: invoice() }),
    ).toBeNull();
  });

  it('two 80.00 refunds from one 100.00 source: the second is not allowed', () => {
    expect(refundAllowed({ amount: '80.00', refundedOn: february, source: source() })).toBe(true);
    expect(
      refundAllowed({
        amount: '80.00',
        refundedOn: march,
        source: source({ refunds: [item('80.00')] }),
      }),
    ).toBe(false);
  });

  it('a 40.00 credit note after a 100.00 invoice was fully paid leaves 40.00 of source remaining', () => {
    const credit = source({ amount: '40.00', date: march });
    expect(openBalance(invoice([item('100.00')]))).toBe('0.00');
    expect(
      allocationEffectiveOn({
        amount: '40.00',
        today,
        source: credit,
        invoice: invoice([item('100.00')]),
      }),
    ).toBeNull();
    expect(sourceRemaining(credit)).toBe('40.00');
  });

  it('a void restores the open balance today but not on earlier dates', () => {
    const paidThenVoided = invoice([item('100.00', february, march)]);
    expect(openBalance(paidThenVoided)).toBe('100.00');
    expect(openBalance(paidThenVoided, february)).toBe('0.00');
    expect(openBalance(paidThenVoided, '2026-03-09')).toBe('0.00');
    expect(openBalance(paidThenVoided, march)).toBe('100.00');
    expect(openBalance(paidThenVoided, today)).toBe('100.00');
  });

  it('derives paid, unpaid and partially paid, including a zero total and overpayment', () => {
    expect(paymentState('100.00', '100')).toBe('unpaid');
    expect(paymentState('100.00', '40.00')).toBe('partially_paid');
    expect(paymentState('100.00', '0.00')).toBe('paid');
    expect(paymentState('100.00', '-0.01')).toBe('paid');
    expect(paymentState('0.00', '0.00')).toBe('paid');
    expect(
      sourceRemaining(source({ allocations: [item('20.01')], refunds: [item('30.02')] })),
    ).toBe('49.97');
  });

  it('exactly equal amounts are allowed; one cent over is refused for source and invoice', () => {
    expect(
      allocationEffectiveOn({ amount: '100.00', today, source: source(), invoice: invoice() }),
    ).toBe(february);
    expect(
      allocationEffectiveOn({
        amount: '100.01',
        today,
        source: source(),
        invoice: invoice([], '200.00'),
      }),
    ).toBeNull();
    expect(
      allocationEffectiveOn({
        amount: '100.01',
        today,
        source: source({ amount: '200.00' }),
        invoice: invoice(),
      }),
    ).toBeNull();
    expect(refundAllowed({ amount: '100.00', refundedOn: february, source: source() })).toBe(true);
    expect(refundAllowed({ amount: '100.01', refundedOn: february, source: source() })).toBe(false);
  });

  it.each(['-100.00', '0.00'])('%s allocation and refund amounts are refused', (amount) => {
    expect(() =>
      allocationEffectiveOn({ amount, today, source: source(), invoice: invoice() }),
    ).toThrow(AmountError);
    expect(() => refundAllowed({ amount, refundedOn: today, source: source() })).toThrow(
      AmountError,
    );
  });

  it('JS numbers are refused for every monetary input', () => {
    const number = 100 as unknown as string;
    const invalidItem = item(number);
    for (const calculate of [
      () => countedOn([invalidItem], today),
      () => currentTotal([invalidItem]),
      () => openBalance(invoice([], number)),
      () => paymentState(number, '0'),
      () => paymentState('100', number),
      () => sourceRemaining(source({ amount: number })),
      () => allocationEffectiveOn({ amount: number, today, source: source(), invoice: invoice() }),
      () => refundAllowed({ amount: number, refundedOn: today, source: source() }),
      () =>
        refundAllowed({
          amount: '1',
          refundedOn: today,
          source: source({ refunds: [invalidItem] }),
        }),
    ])
      expect(calculate).toThrow(AmountError);
  });

  it('rejects excess decimal places instead of rounding allocation and refund amounts', () => {
    expect(() =>
      allocationEffectiveOn({ amount: '0.001', today, source: source(), invoice: invoice() }),
    ).toThrow(AmountError);
    expect(() => refundAllowed({ amount: '0.001', refundedOn: today, source: source() })).toThrow(
      AmountError,
    );
  });

  it('uses the later source or invoice date and refuses a lower bound after today', () => {
    expect(
      allocationEffectiveOn({
        amount: '1',
        today,
        source: source({ date: march }),
        invoice: invoice(),
      }),
    ).toBe(march);
    expect(
      allocationEffectiveOn({
        amount: '1',
        today,
        source: source(),
        invoice: invoice([], '100', march),
      }),
    ).toBe(march);
    expect(
      allocationEffectiveOn({
        amount: '1',
        today,
        source: source({ date: '2026-04-01' }),
        invoice: invoice(),
      }),
    ).toBeNull();
    expect(
      allocationEffectiveOn({
        amount: '1',
        today,
        source: source(),
        invoice: invoice([], '100', '2026-04-01'),
      }),
    ).toBeNull();
    expect(refundAllowed({ amount: '1', refundedOn: '2026-01-31', source: source() })).toBe(false);
  });

  it('checks future event dates too, including an allocation that ends after today', () => {
    const future = item('100.00', '2026-04-01', '2026-05-01');
    expect(
      allocationEffectiveOn({ amount: '1', today, source: source(), invoice: invoice([future]) }),
    ).toBeNull();
    expect(
      allocationEffectiveOn({
        amount: '1',
        today,
        source: source({ allocations: [future] }),
        invoice: invoice(),
      }),
    ).toBeNull();
    expect(
      refundAllowed({ amount: '1', refundedOn: today, source: source({ allocations: [future] }) }),
    ).toBe(false);
  });

  it('checks all later starts and ends, and returns the first feasible event date', () => {
    const used = source({
      allocations: [item('70', february, '2026-03-05'), item('50', '2026-03-05', march)],
      refunds: [item('10', february, '2026-03-12')],
    });
    expect(allocationEffectiveOn({ amount: '100', today, source: used, invoice: invoice() })).toBe(
      '2026-03-12',
    );
    expect(refundAllowed({ amount: '100', refundedOn: '2026-03-11', source: used })).toBe(false);
    expect(refundAllowed({ amount: '100', refundedOn: '2026-03-12', source: used })).toBe(true);
  });

  it('can begin on today when a reversal frees the last amount today', () => {
    expect(
      allocationEffectiveOn({
        amount: '100',
        today,
        source: source(),
        invoice: invoice([item('100', february, today)]),
      }),
    ).toBe(today);
  });
});
