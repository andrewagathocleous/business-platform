import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  effectiveBackground,
  paintedContrast,
  parseCssColor,
} from './button-contrast.mjs';

describe('button contrast', () => {
  it('parses rgb and rgba and composites until an opaque background', () => {
    expect(parseCssColor('rgb(255, 255, 255)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('rgba(4, 120, 87, 0.5)')?.a).toBe(0.5);
    const mixed = effectiveBackground([
      { r: 0, g: 0, b: 0, a: 0 },
      { r: 0, g: 0, b: 0, a: 0.5 },
      { r: 255, g: 255, b: 255, a: 1 },
    ]);
    expect(mixed.r).toBeCloseTo(127.5, 0);
    expect(contrastRatio({ r: 255, g: 255, b: 255, a: 1 }, { r: 4, g: 120, b: 87, a: 1 })).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrastRatio({ r: 255, g: 255, b: 255, a: 1 }, { r: 16, g: 185, b: 129, a: 1 })).toBeLessThan(4.5);
  });

  it('requires 4.5 for enabled text and 3 for a faded disabled button', () => {
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const emerald700 = { r: 4, g: 120, b: 87, a: 1 };
    const page = { r: 244, g: 246, b: 248, a: 1 };
    expect(paintedContrast(white, emerald700, page, 1)).toBeGreaterThanOrEqual(4.5);
    const faded = paintedContrast(white, emerald700, page, 0.6);
    expect(faded).toBeLessThan(4.5);
    expect(faded).toBeGreaterThan(1);
  });
});
