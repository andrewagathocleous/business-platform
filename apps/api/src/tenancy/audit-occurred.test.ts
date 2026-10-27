import { describe, expect, it } from 'vitest';
import { auditOccurredAt } from './company-read.service';

describe('auditOccurredAt', () => {
  it('keeps the start and excludes the upper instant', () => {
    const from = new Date('2026-10-20T21:00:00.000Z');
    const to = new Date('2026-10-21T21:00:00.000Z');
    expect(auditOccurredAt(from, to)).toEqual({ gte: from, lt: to });
    expect(auditOccurredAt(undefined, undefined)).toBeUndefined();
  });
});
