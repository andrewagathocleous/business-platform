import { describe, expect, it } from 'vitest';
import { backoffMs } from './backoff';

describe('backoffMs', () => {
  it('doubles from one second and caps at fifteen minutes', () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    expect(backoffMs(11)).toBe(15 * 60 * 1_000);
    expect(backoffMs(30)).toBe(15 * 60 * 1_000);
  });
});
