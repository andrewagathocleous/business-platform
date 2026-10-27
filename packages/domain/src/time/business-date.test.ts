import { describe, expect, it } from 'vitest';
import { addDaysToBusinessDate, businessDateInZone } from './business-date';

describe('business dates', () => {
  it('keeps 2026-10-25 00:30 UTC on 2026-10-25 in Asia/Nicosia', () => {
    expect(businessDateInZone(new Date('2026-10-25T00:30:00.000Z'), 'Asia/Nicosia')).toBe('2026-10-25');
    // 21:30 UTC is still 24 October in UTC and already 25 October in Nicosia (EEST, UTC+3).
    expect(businessDateInZone(new Date('2026-10-24T21:30:00.000Z'), 'Asia/Nicosia')).toBe('2026-10-25');
    expect(businessDateInZone(new Date('2026-10-24T20:30:00.000Z'), 'Asia/Nicosia')).toBe('2026-10-24');
  });

  it('adds calendar days across a month boundary', () => {
    expect(addDaysToBusinessDate('2026-10-25', 1)).toBe('2026-10-26');
    expect(addDaysToBusinessDate('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDaysToBusinessDate('2026-03-01', -1)).toBe('2026-02-28');
  });
});
