import { AsyncLocalStorage } from 'node:async_hooks';
import { giftMessageTooLong } from '@bp/domain';
import type { Font, GlyphRun } from 'fontkit';

type CmapFont = Font & {
  _cmapProcessor?: { codePointsForGlyph(glyphId: number): number[] };
};

/**
 * One glyph of a shaped paint string, in font units. `y` grows up.
 * `x` is the pen position before the glyph, from the run origin.
 */
export type ShapedGlyph = {
  id: number;
  codePoints: number[];
  /** `glyph.advanceWidth`, the width pdfkit stores in the font. */
  advanceWidth: number;
  x: number;
  xAdvance: number;
  xOffset: number;
  yOffset: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  hasInk: boolean;
};

/**
 * One shaped paint string, in font units. `y` grows up, from the baseline.
 * pdfkit draws a run by splitting on spaces and tabs, then placing each glyph
 * at `xOffset` / `yOffset` and stepping by `xAdvance` only. `glyphs` is that
 * placement. Callers draw these positions; they do not shape the run again.
 */
export type ShapedPaint = {
  advance: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  hasInk: boolean;
  /** A glyph id of 0 is `.notdef`. That paint is not safe to draw. */
  notdef: boolean;
  glyphs: ShapedGlyph[];
};

/**
 * Shaped strings kept after a glyph check, a layout, or a render returns.
 * The map lives only inside that call, so this is 0. A process-wide map of
 * every distinct message and wrap prefix does not: 3,000 fictional greetings
 * grew the retained heap from 31 MB to 263 MB, and the laptop worker has 768 MB.
 * Printing has no cache of its own. `renderGiftMessage` shapes once per card,
 * including the font-size probes, then drops the map before the PDF is built.
 */
export const SHAPING_CACHE_BOUND = 0;

const shapingStore = new AsyncLocalStorage<Map<Font, Map<string, ShapedPaint | null>>>();

/** How many shaped strings the current operation is holding. 0 outside one. */
export function shapingCacheSize(): number {
  const cache = shapingStore.getStore();
  if (!cache) {
    return 0;
  }
  let count = 0;
  for (const entries of cache.values()) {
    count += entries.size;
  }
  return count;
}

/**
 * Runs `fn` with a shaping cache. A call that is already inside one shares it,
 * so a render's glyph check and font-size probes reuse the same shapes.
 * The map is dropped when the outermost call returns.
 */
export function withShapingCache<T>(fn: () => T): T {
  if (shapingStore.getStore()) {
    return fn();
  }
  return shapingStore.run(new Map(), fn);
}

/**
 * Shapes `text` the way pdfkit draws it. `null` means the string was not
 * shaped: it is longer than the card, or shaping threw. The caller must not
 * draw it. A `.notdef` glyph is reported on the result and is also not safe
 * to draw. Outside an operation nothing is stored.
 */
export function shapePaint(face: Font, text: string): ShapedPaint | null {
  if (giftMessageTooLong(text)) {
    return null;
  }
  const cache = shapingStore.getStore();
  if (!cache) {
    return shapeUncached(face, text);
  }
  let cached = cache.get(face);
  if (!cached) {
    cached = new Map();
    cache.set(face, cached);
  }
  const found = cached.get(text);
  if (found !== undefined) {
    return found;
  }
  const shaped = shapeUncached(face, text);
  cached.set(text, shaped);
  return shaped;
}

function shapeUncached(face: Font, text: string): ShapedPaint | null {
  let advance = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hasInk = false;
  let notdef = false;
  const glyphs: ShapedGlyph[] = [];
  let last = 0;
  let index = 0;
  try {
    while (index <= text.length) {
      const needle = text.charAt(index);
      const boundary = (index === text.length && last < index) || needle === ' ' || needle === '\t';
      if (!boundary) {
        index += 1;
        continue;
      }
      const chunk = text.slice(last, index + 1);
      index += 1;
      const run = face.layout(chunk);
      const piece = measureRun(run);
      if (!piece) {
        return null;
      }
      for (const glyph of piece.glyphs) {
        glyphs.push({
          id: glyph.id,
          codePoints: glyph.codePoints.length > 0 ? glyph.codePoints : cmapCode(face, glyph.id),
          advanceWidth: glyph.advanceWidth,
          x: glyph.x + advance,
          xAdvance: glyph.xAdvance,
          xOffset: glyph.xOffset,
          yOffset: glyph.yOffset,
          minX: glyph.hasInk ? glyph.minX + advance : 0,
          minY: glyph.minY,
          maxX: glyph.hasInk ? glyph.maxX + advance : 0,
          maxY: glyph.maxY,
          hasInk: glyph.hasInk,
        });
      }
      if (piece.hasInk) {
        hasInk = true;
        minX = Math.min(minX, advance + piece.minX);
        maxX = Math.max(maxX, advance + piece.maxX);
        minY = Math.min(minY, piece.minY);
        maxY = Math.max(maxY, piece.maxY);
      }
      notdef = notdef || piece.notdef;
      advance += piece.advance;
      last = index;
    }
  } catch {
    return null;
  }
  return { advance, minX, minY, maxX, maxY, hasInk, notdef, glyphs };
}

/**
 * fontkit caches glyphs by id and keeps the code points from the first lookup.
 * A composite that is opened while measuring an earlier glyph can cache the
 * base with an empty list, so a later character of that id has no code points.
 * The cmap still knows which character draws that glyph.
 */
function cmapCode(face: Font, glyphId: number): number[] {
  const found = (face as CmapFont)._cmapProcessor?.codePointsForGlyph(glyphId) ?? [];
  const code = found.find((item) => item > 0);
  return code === undefined ? [] : [code];
}

/** `null` when a glyph has no position, so the ink cannot be known. */
function measureRun(run: GlyphRun): ShapedPaint | null {
  let x = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hasInk = false;
  let notdef = false;
  const glyphs: ShapedGlyph[] = [];
  for (let index = 0; index < run.glyphs.length; index += 1) {
    const glyph = run.glyphs[index];
    const position = run.positions[index];
    if (!glyph || !position) {
      return null;
    }
    if (glyph.id === 0) {
      notdef = true;
    }
    const box = glyph.bbox;
    const finite =
      Number.isFinite(box.minX) &&
      Number.isFinite(box.minY) &&
      Number.isFinite(box.maxX) &&
      Number.isFinite(box.maxY);
    const ink = finite
      ? {
          minX: x + position.xOffset + box.minX,
          maxX: x + position.xOffset + box.maxX,
          minY: position.yOffset + box.minY,
          maxY: position.yOffset + box.maxY,
        }
      : null;
    if (!ink && Math.abs(glyph.advanceWidth - position.xAdvance) > 1) {
      // No outline, but pdfkit still paints `.notdef`'s advance. Do not draw it.
      notdef = true;
    }
    if (ink) {
      hasInk = true;
      minX = Math.min(minX, ink.minX);
      maxX = Math.max(maxX, ink.maxX);
      minY = Math.min(minY, ink.minY);
      maxY = Math.max(maxY, ink.maxY);
    }
    glyphs.push({
      id: glyph.id,
      codePoints: [...glyph.codePoints],
      advanceWidth: glyph.advanceWidth,
      x,
      xAdvance: position.xAdvance,
      xOffset: position.xOffset,
      yOffset: position.yOffset,
      minX: ink?.minX ?? 0,
      minY: ink?.minY ?? 0,
      maxX: ink?.maxX ?? 0,
      maxY: ink?.maxY ?? 0,
      hasInk: ink !== null,
    });
    x += position.xAdvance;
  }
  return { advance: x, minX, minY, maxX, maxY, hasInk, notdef, glyphs };
}
