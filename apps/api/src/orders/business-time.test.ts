import { describe, expect, it } from 'vitest';
import { businessDateBounds, isSupportedBusinessDate, startOfBusinessDate } from './business-time';

describe('startOfBusinessDate', () => {
  it('uses Asia/Nicosia standard time and summer time', () => {
    expect(startOfBusinessDate('2026-01-15', 'Asia/Nicosia').toISOString()).toBe('2026-01-14T22:00:00.000Z');
    expect(startOfBusinessDate('2026-07-15', 'Asia/Nicosia').toISOString()).toBe('2026-07-14T21:00:00.000Z');
  });

  it('treats the end date as inclusive', () => {
    const bounds = businessDateBounds('2026-03-01', '2026-03-01', 'Asia/Nicosia');
    expect(bounds.from?.toISOString()).toBe('2026-02-28T22:00:00.000Z');
    expect(bounds.to?.toISOString()).toBe('2026-03-01T22:00:00.000Z');
  });

  it('accepts 2000-01-01 and 2999-12-31 and rejects the dates outside that range', () => {
    expect(isSupportedBusinessDate('1999-12-31')).toBe(false);
    expect(isSupportedBusinessDate('2000-01-01')).toBe(true);
    expect(isSupportedBusinessDate('2999-12-31')).toBe(true);
    expect(isSupportedBusinessDate('3000-01-01')).toBe(false);
    expect(isSupportedBusinessDate('9999-12-31')).toBe(false);
    expect(isSupportedBusinessDate('2026-02-31')).toBe(false);
    const bounds = businessDateBounds('2000-01-01', '2999-12-31', 'Asia/Nicosia');
    expect(bounds.from?.toISOString()).toBe('1999-12-31T22:00:00.000Z');
    expect(bounds.to?.toISOString()).toBe('2999-12-31T22:00:00.000Z');
  });
});
