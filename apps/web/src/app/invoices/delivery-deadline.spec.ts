import { describe, expect, it } from 'vitest';
import { companyToday, deadlineState } from './delivery-deadline';

describe('deadlineState', () => {
  it('warns from five days before the deadline and flags a passed one', () => {
    expect(deadlineState('2026-11-30', false, '2026-11-01')).toBe('ok');
    expect(deadlineState('2026-11-30', false, '2026-11-25')).toBe('soon');
    expect(deadlineState('2026-11-30', false, '2026-11-30')).toBe('soon');
    expect(deadlineState('2026-11-30', false, '2026-12-01')).toBe('overdue');
  });

  it('says nothing once delivered or without a deadline', () => {
    expect(deadlineState('2026-11-30', true, '2026-12-01')).toBe('none');
    expect(deadlineState(null, false, '2026-12-01')).toBe('none');
  });
});

describe('companyToday', () => {
  it('reads the date in the company timezone', () => {
    const lateEvening = new Date('2026-10-27T22:30:00Z');
    expect(companyToday('Asia/Nicosia', lateEvening)).toBe('2026-10-28');
    expect(companyToday('UTC', lateEvening)).toBe('2026-10-27');
  });
});
