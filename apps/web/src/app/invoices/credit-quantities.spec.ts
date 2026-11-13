import { describe, expect, it } from 'vitest';
import { quantityText, quantityUnits, remainingUnits } from './credit-quantities';

describe('credit quantities', () => {
  it('reads quantities exactly, to 4 decimals, with a comma or a dot', () => {
    expect(quantityUnits('2')).toBe(20_000n);
    expect(quantityUnits(' 1,5 ')).toBe(15_000n);
    expect(quantityUnits('0.0001')).toBe(1n);
    expect(quantityUnits('0.00001')).toBeNull();
    expect(quantityUnits('-1')).toBeNull();
    expect(quantityUnits('')).toBeNull();
    expect(quantityUnits('1e3')).toBeNull();
  });

  it('leaves what issued credit notes have not credited, never below zero', () => {
    expect(quantityText(remainingUnits('2.0000', '0.5000'))).toBe('1.5');
    expect(quantityText(remainingUnits('0.3000', '0.1000'))).toBe('0.2');
    expect(quantityText(remainingUnits('1.0000', '1.0000'))).toBe('0');
    expect(quantityText(remainingUnits('1.0000', '2.0000'))).toBe('0');
  });
});
