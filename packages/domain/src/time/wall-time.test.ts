import { describe, expect, it } from 'vitest';
import { wallTimeInZoneToInstant } from './wall-time';

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
