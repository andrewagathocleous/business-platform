import { describe, expect, it } from 'vitest';
import { instantToWallTimeInZone, wallTimeInZoneToInstant } from './wall-time';

describe('wallTimeInZoneToInstant', () => {
  it('converts a normal Asia/Nicosia wall time to UTC', () => {
    expect(wallTimeInZoneToInstant('2026-06-15 14:30:00', 'Asia/Nicosia').toISOString()).toBe(
      '2026-06-15T11:30:00.000Z',
    );
    expect(wallTimeInZoneToInstant('2026-06-15 00:00:00', 'Asia/Nicosia').toISOString()).toBe(
      '2026-06-14T21:00:00.000Z',
    );
    expect(wallTimeInZoneToInstant('2026-01-20 09:15:00', 'Asia/Nicosia').toISOString()).toBe(
      '2026-01-20T07:15:00.000Z',
    );
    expect(wallTimeInZoneToInstant('2026-06-15 14:30:00', 'UTC').toISOString()).toBe(
      '2026-06-15T14:30:00.000Z',
    );
  });

  it('takes the earlier instant when Asia/Nicosia repeats an hour', () => {
    expect(wallTimeInZoneToInstant('2026-10-25 02:59:59', 'Asia/Nicosia').toISOString()).toBe(
      '2026-10-24T23:59:59.000Z',
    );
    expect(wallTimeInZoneToInstant('2026-10-25 03:00:00', 'Asia/Nicosia').toISOString()).toBe(
      '2026-10-25T00:00:00.000Z',
    );
    expect(wallTimeInZoneToInstant('2026-10-25 03:30:00', 'Asia/Nicosia').toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
    expect(wallTimeInZoneToInstant('2026-10-25 03:59:59', 'Asia/Nicosia').toISOString()).toBe(
      '2026-10-25T00:59:59.000Z',
    );
    expect(wallTimeInZoneToInstant('2026-10-25 04:00:00', 'Asia/Nicosia').toISOString()).toBe(
      '2026-10-25T02:00:00.000Z',
    );
  });

  it('moves a skipped Asia/Nicosia wall time forward to the first valid instant', () => {
    expect(wallTimeInZoneToInstant('2026-03-29 02:59:59', 'Asia/Nicosia').toISOString()).toBe(
      '2026-03-29T00:59:59.000Z',
    );
    expect(wallTimeInZoneToInstant('2026-03-29 03:00:00', 'Asia/Nicosia').toISOString()).toBe(
      '2026-03-29T01:00:00.000Z',
    );
    expect(wallTimeInZoneToInstant('2026-03-29 03:01:00', 'Asia/Nicosia').toISOString()).toBe(
      '2026-03-29T01:00:00.000Z',
    );
    expect(wallTimeInZoneToInstant('2026-03-29 03:30:00', 'Asia/Nicosia').toISOString()).toBe(
      '2026-03-29T01:00:00.000Z',
    );
    expect(wallTimeInZoneToInstant('2026-03-29 03:59:59', 'Asia/Nicosia').toISOString()).toBe(
      '2026-03-29T01:00:00.000Z',
    );
    expect(wallTimeInZoneToInstant('2026-03-29 04:00:00', 'Asia/Nicosia').toISOString()).toBe(
      '2026-03-29T01:00:00.000Z',
    );
  });

  it('uses the same rules for a negative-offset zone', () => {
    expect(wallTimeInZoneToInstant('2026-03-08 02:30:00', 'America/New_York').toISOString()).toBe(
      '2026-03-08T07:00:00.000Z',
    );
    expect(wallTimeInZoneToInstant('2026-11-01 01:30:00', 'America/New_York').toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('rejects an invalid wall time or zone', () => {
    expect(() => wallTimeInZoneToInstant('2026-06-15T14:30:00', 'Asia/Nicosia')).toThrow(
      'wall time must be YYYY-MM-DD HH:mm:ss',
    );
    expect(() => wallTimeInZoneToInstant('2026-06-15 24:00:00', 'Asia/Nicosia')).toThrow(
      'wall time must be YYYY-MM-DD HH:mm:ss',
    );
    expect(() => wallTimeInZoneToInstant('2026-13-01 00:00:00', 'Asia/Nicosia')).toThrow(
      'wall time must be YYYY-MM-DD HH:mm:ss',
    );
    expect(() => wallTimeInZoneToInstant('2026-02-31 00:00:00', 'Asia/Nicosia')).toThrow(
      'wall time is not a real calendar date',
    );
    expect(() => wallTimeInZoneToInstant('not-a-time', 'Asia/Nicosia')).toThrow(
      'wall time must be YYYY-MM-DD HH:mm:ss',
    );
    expect(() => wallTimeInZoneToInstant('2026-06-15 14:30:00', 'Not/AZone')).toThrow(
      'time zone is invalid',
    );
    expect(() => wallTimeInZoneToInstant('2026-06-15 14:30:00', '')).toThrow(
      'time zone is invalid',
    );
    expect(() => wallTimeInZoneToInstant('2026-06-15 14:30:00', 'Asia/Nicosia ')).toThrow(
      'time zone is invalid',
    );
  });
});

describe('instantToWallTimeInZone', () => {
  it('formats an unambiguous wall time and round-trips it', () => {
    expect(instantToWallTimeInZone(new Date('2026-06-15T11:30:00.000Z'), 'Asia/Nicosia')).toBe(
      '2026-06-15 14:30:00',
    );
    expect(instantToWallTimeInZone(new Date('2026-01-20T07:15:00.000Z'), 'Asia/Nicosia')).toBe(
      '2026-01-20 09:15:00',
    );
    expect(instantToWallTimeInZone(new Date('2026-06-15T14:30:00.000Z'), 'UTC')).toBe(
      '2026-06-15 14:30:00',
    );
    const summer = '2026-06-15 14:30:00';
    expect(instantToWallTimeInZone(wallTimeInZoneToInstant(summer, 'Asia/Nicosia'), 'Asia/Nicosia')).toBe(
      summer,
    );
    const winter = '2026-01-20 09:15:00';
    expect(instantToWallTimeInZone(wallTimeInZoneToInstant(winter, 'Asia/Nicosia'), 'Asia/Nicosia')).toBe(
      winter,
    );
  });

  it('formats both instants of a repeated Asia/Nicosia hour as the same wall time', () => {
    expect(instantToWallTimeInZone(new Date('2026-10-25T00:30:00.000Z'), 'Asia/Nicosia')).toBe(
      '2026-10-25 03:30:00',
    );
    expect(instantToWallTimeInZone(new Date('2026-10-25T01:30:00.000Z'), 'Asia/Nicosia')).toBe(
      '2026-10-25 03:30:00',
    );
    expect(instantToWallTimeInZone(new Date('2026-10-24T23:59:59.000Z'), 'Asia/Nicosia')).toBe(
      '2026-10-25 02:59:59',
    );
    expect(instantToWallTimeInZone(new Date('2026-10-25T02:00:00.000Z'), 'Asia/Nicosia')).toBe(
      '2026-10-25 04:00:00',
    );
    const repeated = '2026-10-25 03:30:00';
    const earlier = wallTimeInZoneToInstant(repeated, 'Asia/Nicosia');
    expect(earlier.toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(instantToWallTimeInZone(earlier, 'Asia/Nicosia')).toBe(repeated);
    const tenMinutesBefore = new Date(earlier.getTime() - 10 * 60 * 1000);
    expect(instantToWallTimeInZone(tenMinutesBefore, 'Asia/Nicosia')).toBe('2026-10-25 03:20:00');
  });

  it('formats the instants on either side of a skipped Asia/Nicosia hour', () => {
    expect(instantToWallTimeInZone(new Date('2026-03-29T00:59:59.000Z'), 'Asia/Nicosia')).toBe(
      '2026-03-29 02:59:59',
    );
    expect(instantToWallTimeInZone(new Date('2026-03-29T01:00:00.000Z'), 'Asia/Nicosia')).toBe(
      '2026-03-29 04:00:00',
    );
    const afterGap = wallTimeInZoneToInstant('2026-03-29 04:05:00', 'Asia/Nicosia');
    expect(instantToWallTimeInZone(new Date(afterGap.getTime() - 10 * 60 * 1000), 'Asia/Nicosia')).toBe(
      '2026-03-29 02:55:00',
    );
  });

  it('formats a negative-offset zone, including its repeated hour', () => {
    expect(instantToWallTimeInZone(new Date('2026-07-04T16:00:00.000Z'), 'America/New_York')).toBe(
      '2026-07-04 12:00:00',
    );
    expect(instantToWallTimeInZone(new Date('2026-11-01T05:30:00.000Z'), 'America/New_York')).toBe(
      '2026-11-01 01:30:00',
    );
    expect(instantToWallTimeInZone(new Date('2026-11-01T06:30:00.000Z'), 'America/New_York')).toBe(
      '2026-11-01 01:30:00',
    );
  });

  it('rejects an invalid instant or zone', () => {
    expect(() => instantToWallTimeInZone(new Date(Number.NaN), 'Asia/Nicosia')).toThrow(
      'instant is not a valid date',
    );
    expect(() => instantToWallTimeInZone(new Date('2026-06-15T11:30:00.000Z'), 'Not/AZone')).toThrow(
      'time zone is invalid',
    );
    expect(() => instantToWallTimeInZone(new Date('2026-06-15T11:30:00.000Z'), '')).toThrow(
      'time zone is invalid',
    );
  });
});
