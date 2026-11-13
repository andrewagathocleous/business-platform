import { describe, expect, it } from 'vitest';
import { deliveryDeadline, printedUnitAmount, vatExclusiveUnitPrice } from './issue-rules';

describe('deliveryDeadline', () => {
  it('gives 30 days after the supply date', () => {
    expect(deliveryDeadline('2026-10-27', ['days_30'])).toBe('2026-11-26');
    expect(deliveryDeadline('2028-01-31', ['days_30'])).toBe('2028-03-01');
  });

  it('gives the 15th of the month after the supply', () => {
    expect(deliveryDeadline('2026-10-01', ['next_month_15'])).toBe('2026-11-15');
    expect(deliveryDeadline('2026-10-31', ['next_month_15'])).toBe('2026-11-15');
    expect(deliveryDeadline('2026-12-20', ['next_month_15'])).toBe('2027-01-15');
  });

  it('takes the strictest rule among the lines', () => {
    expect(deliveryDeadline('2026-10-27', ['days_30', 'next_month_15'])).toBe('2026-11-15');
    expect(deliveryDeadline('2026-10-01', ['next_month_15', 'days_30'])).toBe('2026-10-31');
    expect(deliveryDeadline('2026-10-16', ['days_30', 'next_month_15'])).toBe('2026-11-15');
  });

  it('refuses no rules and an invalid date', () => {
    expect(() => deliveryDeadline('2026-10-27', [])).toThrow(/at least one rule/);
    expect(() => deliveryDeadline('2026-02-30', ['next_month_15'])).toThrow();
    expect(() => deliveryDeadline('27/10/2026', ['days_30'])).toThrow();
  });
});

describe('vatExclusiveUnitPrice', () => {
  it('prints €11.90 at 19 % as €10.00', () => {
    expect(vatExclusiveUnitPrice('11.9000', '19.0000')).toBe('10.0000');
    expect(printedUnitAmount(vatExclusiveUnitPrice('11.90', '19'))).toBe('10.00');
  });

  it('rounds half-up to 4 decimals, away from zero', () => {
    expect(vatExclusiveUnitPrice('1', '19')).toBe('0.8403');
    expect(vatExclusiveUnitPrice('1.00005', '0')).toBe('1.0001');
    expect(vatExclusiveUnitPrice('-11.90', '19')).toBe('-10.0000');
    expect(vatExclusiveUnitPrice('5.25', '5')).toBe('5.0000');
  });

  it('refuses a negative rate', () => {
    expect(() => vatExclusiveUnitPrice('10', '-1')).toThrow();
  });
});

describe('printedUnitAmount', () => {
  it('keeps at least two decimals and drops trailing zeros after them', () => {
    expect(printedUnitAmount('10.0000')).toBe('10.00');
    expect(printedUnitAmount('1.5000')).toBe('1.50');
    expect(printedUnitAmount('3.3330')).toBe('3.333');
    expect(printedUnitAmount('0.8403')).toBe('0.8403');
    expect(printedUnitAmount('7')).toBe('7.00');
  });
});
