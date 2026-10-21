import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unsupportedGlyphs } from './glyphs';

describe('unsupportedGlyphs', () => {
  it('accepts the Greek gift fixture and flags the emoji fixture', () => {
    const greek = giftMessage('order-1001-paid-greek-gift.json');
    const emoji = giftMessage('order-1003-emoji-gift.json');
    expect(unsupportedGlyphs(greek)).toEqual([]);
    expect(unsupportedGlyphs(emoji)).toEqual(['🎁']);
    expect(unsupportedGlyphs('line\nbreak')).toEqual([]);
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
