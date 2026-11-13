import { describe, expect, it } from 'vitest';
import { positiveMoney, smallerMoney } from './payment-view';

describe('whole-cent amounts', () => {
  it('accepts comma or dot and the smallest and largest positive amounts without rounding', () => {
    expect(positiveMoney(' 0010,50 ')).toBe('10.50');
    expect(positiveMoney('0.01')).toBe('0.01');
    expect(positiveMoney('0000,01')).toBe('0.01');
    expect(positiveMoney('1')).toBe('1');
    expect(positiveMoney('1.2')).toBe('1.2');
    expect(positiveMoney('99999999999999999.99')).toBe('99999999999999999.99');
  });

  it('refuses zero, negative amounts, fractional cents, invalid text and out-of-range amounts', () => {
    for (const bad of [
      '0',
      '0.00',
      '000,00',
      '-1',
      '-0.01',
      '1.001',
      '1.000',
      '0.001',
      'NaN',
      '1e2',
      '',
      '.01',
      '1.',
      '1,2.3',
      '100000000000000000.00',
    ])
      expect(positiveMoney(bad), bad).toBeNull();
  });

  it('compares exact cents beyond Number precision, including zero balances and equal amounts', () => {
    expect(smallerMoney('99999999999999999.99', '99999999999999999.98')).toBe(
      '99999999999999999.98',
    );
    expect(smallerMoney('99999999999999999.98', '99999999999999999.99')).toBe(
      '99999999999999999.98',
    );
    expect(smallerMoney('10.00', '9.99')).toBe('9.99');
    expect(smallerMoney('0.01', '0.00')).toBe('0.00');
    expect(smallerMoney('1,20', '1.2')).toBe('1,20');
    expect(() => smallerMoney('1.001', '1.00')).toThrow('Invalid amount');
    expect(() => smallerMoney('1.00', '-1')).toThrow('Invalid amount');
  });
});
