import { giftMessageTooLong } from '@bp/domain';
import { openSync, type Font } from 'fontkit';
import { fallbackFontFiles, fontFiles } from './fonts';
import { shapePaint, withShapingCache } from './shaping';

/**
 * Variation selectors and the zero-width joiner are not missing glyphs.
 * They are removed before measuring and drawing, and they are not counted
 * as omitted. The stored message is unchanged.
 */
const INVISIBLE = new Set<number>([0xfe0e, 0xfe0f, 0x200d]);

/** Noto Sans, then Symbols 2, then monochrome Noto Emoji. */
const FALLBACK_FILES = [
  fontFiles.normal,
  fallbackFontFiles.symbols,
  fallbackFontFiles.emoji,
] as const;

const opened = new Map<string, Font>();
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export type GiftMessageGlyphs = {
  /** Unique code points, first-seen order, `U+XXXX`. Never the character or the message. */
  unsupportedChars: string[];
  /** How many non-invisible characters will be left off the card. Line breaks are not counted. */
  omittedCount: number;
  /**
   * False when the message is longer than the card and was not shaped.
   * True means the length was accepted. Ink fit is decided when the card is laid out.
   */
  fits: boolean;
};

export type DrawnRun = {
  /** Paint text. Invisible code points are already removed. */
  text: string;
  file: string;
};

type Cluster = {
  paint: string;
  file: string;
  codes: number[];
};

type Prepared = GiftMessageGlyphs & {
  runs: DrawnRun[];
};

export function notoSansFace(): Font {
  return fontFace(fontFiles.normal);
}

export function fontFace(file: string): Font {
  const cached = opened.get(file);
  if (cached) {
    return cached;
  }
  const face = openSync(file);
  opened.set(file, face);
  return face;
}

/**
 * The one gift-message glyph check. Import review and the print check both call this,
 * so a character is either drawn or reported the same way in both places.
 * A cluster that cannot be shaped, or that shapes to `.notdef`, is not drawable.
 * A message longer than the card is not shaped: `fits` is false and no code point
 * is listed. The stored text is not changed.
 */
export function giftMessageGlyphs(text: string): GiftMessageGlyphs {
  if (giftMessageTooLong(text)) {
    return { unsupportedChars: [], omittedCount: 0, fits: false };
  }
  return withShapingCache(() => {
    const prepared = prepareGiftText(text);
    return {
      unsupportedChars: prepared.unsupportedChars,
      omittedCount: prepared.omittedCount,
      fits: true,
    };
  });
}

/** Code points `giftMessageGlyphs` cannot draw. Whitespace that shapes, and invisible selectors, are omitted from the list. */
export function unsupportedGlyphs(text: string): string[] {
  return giftMessageGlyphs(text).unsupportedChars;
}

/**
 * Runs the drawer paints. Each run is safe to pass to a font: invisible code
 * points are gone, and shaping neither throws nor yields glyph id 0.
 * Line breaks stay out of the runs; the wrapper keeps them on ActualText.
 * A message longer than the card has no runs: it is not shaped.
 */
export function drawnRuns(text: string): DrawnRun[] {
  return prepareGiftText(text).runs;
}

function prepareGiftText(text: string): Prepared {
  if (giftMessageTooLong(text)) {
    return { runs: [], unsupportedChars: [], omittedCount: 0, fits: false };
  }
  const unsupportedChars: string[] = [];
  const seen = new Set<number>();
  let omittedCount = 0;
  const omit = (codes: readonly number[]): void => {
    for (const code of codes) {
      omittedCount += 1;
      if (!seen.has(code)) {
        seen.add(code);
        unsupportedChars.push(codePointLabel(code));
      }
    }
  };
  const clusters: Cluster[] = [];
  for (const part of graphemes.segment(text)) {
    const paint = stripInvisible(part.segment);
    if (paint.length === 0 || isLineBreak(paint)) {
      continue;
    }
    const file = fontForPaint(paint);
    if (file === null) {
      omit(codesOf(paint));
      continue;
    }
    clusters.push({ paint, file, codes: codesOf(paint) });
  }
  const runs: DrawnRun[] = [];
  let group: Cluster[] = [];
  const flush = (): void => {
    if (group.length === 0) {
      return;
    }
    placeGroup(group, runs, omit);
    group = [];
  };
  for (const cluster of clusters) {
    const first = group[0];
    if (first && first.file !== cluster.file) {
      flush();
    }
    group.push(cluster);
  }
  flush();
  return { runs, unsupportedChars, omittedCount, fits: true };
}

/**
 * One font run when the whole group shapes safely. A throw or a `.notdef`
 * drops only the cluster that caused it; the rest is still drawn.
 */
function placeGroup(
  group: readonly Cluster[],
  runs: DrawnRun[],
  omit: (codes: readonly number[]) => void,
): void {
  if (group.length === 0) {
    return;
  }
  const file = group[0]?.file;
  if (!file) {
    return;
  }
  const text = group.map((cluster) => cluster.paint).join('');
  const shaped = shapePaint(fontFace(file), text);
  if (shaped && !shaped.notdef) {
    runs.push({ text, file });
    return;
  }
  if (group.length === 1) {
    omit(group[0]?.codes ?? []);
    return;
  }
  const mid = Math.floor(group.length / 2);
  placeGroup(group.slice(0, mid), runs, omit);
  placeGroup(group.slice(mid), runs, omit);
}

function stripInvisible(text: string): string {
  let paint = '';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined || INVISIBLE.has(code)) {
      continue;
    }
    paint += char;
  }
  return paint;
}

function isLineBreak(text: string): boolean {
  for (const char of text) {
    if (char !== '\n' && char !== '\r') {
      return false;
    }
  }
  return text.length > 0;
}

function fontForPaint(paint: string): string | null {
  const codes: number[] = [];
  let whitespace = true;
  for (const char of paint) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (!/^\s$/u.test(char)) {
      whitespace = false;
    }
    codes.push(code);
  }
  if (codes.length === 0) {
    return null;
  }
  if (whitespace) {
    return fontFiles.normal;
  }
  for (const file of FALLBACK_FILES) {
    const face = fontFace(file);
    if (codes.every((code) => face.hasGlyphForCodePoint(code))) {
      return file;
    }
  }
  return null;
}

function codesOf(text: string): number[] {
  const codes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code !== undefined) {
      codes.push(code);
    }
  }
  return codes;
}

function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}
