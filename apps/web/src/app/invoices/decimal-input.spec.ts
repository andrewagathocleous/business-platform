import { describe, expect, it } from 'vitest';
import { decimalInput, isDecimalInput } from './decimal-input';

describe('decimalInput', () => {
  it('turns a comma decimal separator into a dot and leaves a dotted value unchanged', () => {
    expect(decimalInput('1,5')).toBe('1.5');
    expect(decimalInput('10.005')).toBe('10.005');
    expect(decimalInput('  10.005  ')).toBe('10.005');
    expect(isDecimalInput('1,5')).toBe(true);
    expect(isDecimalInput('10.005')).toBe(true);
    expect(isDecimalInput('10.00.5')).toBe(false);
    expect(isDecimalInput('1,5,0')).toBe(false);
  });
});
