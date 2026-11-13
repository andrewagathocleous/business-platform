import { describe, expect, it } from 'vitest';
import { fontFiles } from './fonts';
import { renderGiftMessage, type GiftMessageTemplate } from './gift-message';
import { fontFace, giftMessageGlyphs } from './glyphs';
import { SHAPING_CACHE_BOUND, shapePaint, shapingCacheSize, withShapingCache } from './shaping';

const ZEBRA: GiftMessageTemplate = {
  pageWidthMm: '100.00',
  pageHeightMm: '150.00',
  marginTopMm: '5.00',
  marginRightMm: '5.00',
  marginBottomMm: '5.00',
  marginLeftMm: '5.00',
  fontSizePt: '16.00',
  minFontSizePt: '9.00',
  lineHeight: '1.250',
  align: 'center',
  verticalAlign: 'middle',
};

describe('shaping cache', () => {
  it('keeps shapes for one operation and drops them when it returns', () => {
    const face = fontFace(fontFiles.normal);
    expect(shapingCacheSize()).toBe(0);
    withShapingCache(() => {
      shapePaint(face, 'Hello');
      shapePaint(face, 'Hello');
      expect(shapingCacheSize()).toBe(1);
      withShapingCache(() => {
        shapePaint(face, 'Hello again');
        expect(shapingCacheSize()).toBe(2);
      });
      expect(shapingCacheSize()).toBe(2);
    });
    expect(shapingCacheSize()).toBeLessThanOrEqual(SHAPING_CACHE_BOUND);
  });

  it('drops the cache after each glyph check and render', async () => {
    expect(SHAPING_CACHE_BOUND).toBe(0);
    const names = ['Alex', 'Νίκος', 'Μαρία', 'Ελένη', 'Sam', 'Γιώργος'];
    for (let index = 0; index < 3_000; index += 1) {
      const name = names[index % names.length] ?? 'Alex';
      const text = `Happy birthday, ${name} ${String(index)}! Χρόνια πολλά.`;
      giftMessageGlyphs(text);
      expect(shapingCacheSize()).toBeLessThanOrEqual(SHAPING_CACHE_BOUND);
      await renderGiftMessage(text, ZEBRA);
      expect(shapingCacheSize()).toBeLessThanOrEqual(SHAPING_CACHE_BOUND);
    }
    await renderGiftMessage('i'.repeat(400), ZEBRA);
    expect(shapingCacheSize()).toBeLessThanOrEqual(SHAPING_CACHE_BOUND);
  }, 180_000);
});
