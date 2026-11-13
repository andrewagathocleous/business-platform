import { describe, expect, it } from 'vitest';
import { GIFT_MESSAGE_MAX_CODE_POINTS, giftMessageTooLong } from './gift-message-length';

describe('giftMessageTooLong', () => {
  it('is false at the card limit and true one code point past it', () => {
    expect(GIFT_MESSAGE_MAX_CODE_POINTS).toBe(35 * 281);
    const fitting = 'i'.repeat(GIFT_MESSAGE_MAX_CODE_POINTS);
    expect(giftMessageTooLong('')).toBe(false);
    expect(giftMessageTooLong(fitting)).toBe(false);
    expect(giftMessageTooLong(`${fitting}i`)).toBe(true);
    const smiles = '\u{1F60A}'.repeat(GIFT_MESSAGE_MAX_CODE_POINTS);
    expect(smiles.length).toBe(GIFT_MESSAGE_MAX_CODE_POINTS * 2);
    expect(giftMessageTooLong(smiles)).toBe(false);
    expect(giftMessageTooLong(`${smiles}\u{1F60A}`)).toBe(true);
  });

  it('stops at the limit, so a million characters returns quickly', () => {
    const text = 'i'.repeat(1_000_000);
    const started = Date.now();
    expect(giftMessageTooLong(text)).toBe(true);
    expect(Date.now() - started).toBeLessThan(50);
  });
});
