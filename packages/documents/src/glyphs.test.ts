import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { giftMessageGlyphs, unsupportedGlyphs } from './glyphs';

describe('unsupportedGlyphs', () => {
  it('accepts Greek, line breaks and the emoji fixture, and names a missing character by code point', () => {
    const greek = giftMessage('order-1001-paid-greek-gift.json');
    const emoji = giftMessage('order-1003-emoji-gift.json');
    expect(unsupportedGlyphs(greek)).toEqual([]);
    expect(unsupportedGlyphs(emoji)).toEqual([]);
    expect(unsupportedGlyphs('line\nbreak')).toEqual([]);
    expect(unsupportedGlyphs('\uFE0E\uFE0F\u200D')).toEqual([]);
    expect(unsupportedGlyphs('\u0378')).toEqual(['U+0378']);
    const repeated = giftMessageGlyphs('\u0378\uFE0F\u200D\u0378');
    expect(repeated.unsupportedChars).toEqual(['U+0378']);
    expect(repeated.omittedCount).toBe(2);
    expect(repeated.fits).toBe(true);
    const crash = giftMessageGlyphs('1\u{102E0}');
    expect(crash.unsupportedChars).toEqual(['U+0031', 'U+102E0']);
    expect(crash.omittedCount).toBe(2);
    expect(crash.fits).toBe(true);
    expect(giftMessageGlyphs('\u{1F408}\u200D\u2B1B').omittedCount).toBe(0);
  });
});

function giftMessage(name: string): string {
  const path = resolve(__dirname, '../../integrations/shopify/fixtures', name);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('customAttributes' in parsed)) {
    throw new Error(`${name} has no attributes`);
  }
  const attributes = parsed.customAttributes;
  if (!Array.isArray(attributes)) {
    throw new Error(`${name} attributes are not an array`);
  }
  for (const entry of attributes) {
    const key = stringField(entry, 'key');
    const value = stringField(entry, 'value');
    if (key === 'Gift Message' && value !== undefined) {
      return value;
    }
  }
  throw new Error(`${name} has no gift message`);
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  for (const [name, item] of Object.entries(value)) {
    if (name === key && typeof item === 'string') {
      return item;
    }
  }
  return undefined;
}
