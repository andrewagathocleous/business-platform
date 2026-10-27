import { describe, expect, it } from 'vitest';
import { refreshDelayMs } from './refresh-delay';

describe('refreshDelayMs', () => {
  it('backs off from 2 seconds and stops at 5 minutes', () => {
    expect(refreshDelayMs(0)).toBe(2_000);
    expect(refreshDelayMs(1)).toBe(4_000);
    expect(refreshDelayMs(2)).toBe(8_000);
    expect(refreshDelayMs(7)).toBe(256_000);
    expect(refreshDelayMs(8)).toBe(300_000);
    expect(refreshDelayMs(20)).toBe(300_000);
    expect(refreshDelayMs(-1)).toBe(2_000);
  });
});
