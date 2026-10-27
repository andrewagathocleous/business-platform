import { describe, expect, it } from 'vitest';
import { isIanaTimeZone } from './iana-zone';

describe('isIanaTimeZone', () => {
  it('accepts IANA names and rejects offsets and untrimmed text', () => {
    expect(isIanaTimeZone('Asia/Nicosia')).toBe(true);
    expect(isIanaTimeZone('UTC')).toBe(true);
    expect(isIanaTimeZone('Etc/GMT-3')).toBe(true);
    expect(isIanaTimeZone('+03:00')).toBe(false);
    expect(isIanaTimeZone('-0300')).toBe(false);
    expect(isIanaTimeZone('')).toBe(false);
    expect(isIanaTimeZone(' Asia/Nicosia')).toBe(false);
  });
});
