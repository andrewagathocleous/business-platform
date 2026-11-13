import { giftMessageTooLong } from '@bp/domain';
import { drawnRuns, fontFace, notoSansFace } from './glyphs';
import { shapePaint, withShapingCache } from './shaping';

const SAFETY_PT = 2;
/** Float slack for ink against the text area. A point of real overflow still fails. */
const INK_SLOP_PT = 0.05;

/** Shaped advance, and the right edge of the ink, both in points from the origin. */
export type TextBounds = {
  advance: number;
  inkRight: number;
};

/**
 * Ink of one line, in points. The origin is the left of the baseline; `y` grows up.
 * `hasInk` is false for a line that paints nothing (spaces, or nothing drawable).
 */
export type LineInk = {
  advance: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  hasInk: boolean;
  /** A run could not be shaped. The line must not be reported as fitting. */
  unsafe: boolean;
};

export type TextMeasure = {
  fits: boolean;
  height: number;
};

/** One glyph placed in a run. Points, `y` up from the baseline. */
export type PlacedGlyph = {
  id: number;
  codePoints: number[];
  /** Width pdfkit writes into the font, in 1000-em units. */
  widthUnits: number;
  /** Pen position before this glyph, from the run origin. */
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
 * One font run. `glyphs` is the placement drawing paints. The advance is the
 * sum of those glyphs, in the font that was selected for `text`.
 */
export type PlacedRun = {
  text: string;
  file: string;
  advance: number;
  glyphs: PlacedGlyph[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  hasInk: boolean;
};

export type TextAlign = 'left' | 'center' | 'right';

/**
 * One wrapped line. Fit and drawing both use `runs` and `originX`.
 * `originX` is the pen x from the left of the text area, chosen so the ink
 * box sits inside that area when the ink fits. Drawing adds the page margin
 * and does not align the line again.
 */
export type PlacedLine = {
  text: string;
  runs: PlacedRun[];
  advance: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  hasInk: boolean;
  /** A run could not be shaped. The line must not be reported as fitting. */
  unsafe: boolean;
  /** Pen x, in points from the left of the text area. */
  originX: number;
};

export type GiftPlacement = {
  lines: string[];
  actuals: string[];
  placed: PlacedLine[];
  fontSize: number;
  fits: boolean;
  height: number;
  offsetTop: number;
};

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Line breaking for the gift-message card. Each run is measured with the font
 * that draws it, using the same shaping pdfkit uses to draw (`font.layout`,
 * split on spaces the way `widthOfString` does). The fit height is where
 * pdfkit places the lines: the first top is the drawing origin, each later
 * line advances by `lineOrigin`, and the last line ends at its baseline plus
 * `|descent|`. After that placement, the shaped ink of every glyph (bounds
 * plus x and y offsets) must sit inside the text area on all four sides.
 * `\r\n` and a lone `\r` are one hard break. The original bytes, including
 * those breaks, stay on `actuals`. Nothing is trimmed. Breaks are only at
 * grapheme boundaries, so a surrogate pair or a joiner sequence stays on one line.
 * `placed` is the only geometry: each line's runs carry the font, the glyphs
 * and their positions, and `originX` is where that line is drawn. Fit uses
 * that list. Drawing paints that list. A left-aligned line shifts right by a
 * negative left bearing, a right-aligned line shifts left by a right overhang,
 * and a centred line centres the ink box. The block shifts vertically by the
 * same rule when the ink would otherwise leave the text area. `fits` is false
 * when a line cannot break, the line block is taller than `height`, or the
 * ink box is wider or taller than the text area.
 */
export function measureText(
  text: string,
  fontSize: number,
  lineHeight: number,
  width: number,
  height: number,
  align: TextAlign = 'left',
  verticalAlign: 'top' | 'middle' = 'top',
): TextMeasure {
  const placed = placeGiftText(text, fontSize, lineHeight, width, height, align, verticalAlign);
  return { fits: placed.fits, height: placed.height };
}

/**
 * Wrapped lines plus the glyph placement for `fontSize`. `fits` is false when
 * a line cannot break, the block is taller than `height`, or the ink box is
 * wider or taller than the text area. `offsetTop` is the vertical shift when
 * it fits, and 0 otherwise. The call keeps a shaping cache and drops it.
 */
export function placeGiftText(
  text: string,
  fontSize: number,
  lineHeight: number,
  width: number,
  height: number,
  align: TextAlign = 'left',
  verticalAlign: 'top' | 'middle' = 'top',
): GiftPlacement {
  return withShapingCache(() =>
    placeGiftTextOnce(text, fontSize, lineHeight, width, height, align, verticalAlign),
  );
}

function placeGiftTextOnce(
  text: string,
  fontSize: number,
  lineHeight: number,
  width: number,
  height: number,
  align: TextAlign,
  verticalAlign: 'top' | 'middle',
): GiftPlacement {
  if (giftMessageTooLong(text)) {
    return {
      lines: [],
      actuals: [],
      placed: [],
      fontSize,
      fits: false,
      height: 0,
      offsetTop: 0,
    };
  }
  const maxWidth = width - SAFETY_PT;
  if (maxWidth <= 0 || height <= 0) {
    return {
      lines: [],
      actuals: [],
      placed: [],
      fontSize,
      fits: false,
      height: 0,
      offsetTop: 0,
    };
  }
  const laid = layoutLines(text, fontSize, maxWidth);
  const placed = laid.lines.map((line) => {
    const raw = placeLine(line, fontSize);
    return { ...raw, originX: alignOrigin(raw, width, align) };
  });
  const used = blockHeight(placed.length, fontSize, lineHeight);
  const blockFits = !laid.overflows && used <= height && placed.every((line) => !line.unsafe);
  const offsetTop = blockFits
    ? containedOffset(placed, fontSize, lineHeight, height, verticalAlign)
    : 0;
  const fits = blockFits && inkFits(placed, fontSize, lineHeight, width, height, offsetTop);
  return {
    lines: laid.lines,
    actuals: laid.actuals,
    placed,
    fontSize,
    fits,
    height: used,
    offsetTop: fits ? offsetTop : 0,
  };
}

/**
 * Wrapped lines for `text`. A source line that cannot break still comes back,
 * with `overflows` set. `actuals` join back to `text`, breaks included.
 * `maxWidth` is the advance limit. Ink outside the text area is checked
 * after the lines are placed, not while wrapping. A message longer than the
 * card is not wrapped: `overflows` is set and nothing is placed.
 */
export function layoutLines(
  text: string,
  fontSize: number,
  maxWidth: number,
): { lines: string[]; actuals: string[]; overflows: boolean } {
  if (giftMessageTooLong(text)) {
    return { lines: [], actuals: [], overflows: true };
  }
  const lines: string[] = [];
  const actuals: string[] = [];
  let overflows = false;
  for (const source of sourceSegments(text)) {
    const wrapped = wrapLine(source.text, fontSize, maxWidth);
    if (wrapped === null) {
      overflows = true;
      lines.push(source.text);
      actuals.push(source.actual);
      continue;
    }
    wrapped.forEach((part, index) => {
      lines.push(part);
      actuals.push(index === wrapped.length - 1 ? `${part}${source.breakAfter}` : part);
    });
  }
  return { lines, actuals, overflows };
}

/**
 * Distance from one line's top to the next, in points.
 * That is the baseline spacing `lineHeight * fontSize`. The glyph box is not
 * multiplied in: a factor below 1 must not shrink the first or last line.
 */
export function lineBoxHeight(fontSize: number, lineHeight: number): number {
  return lineHeight * fontSize;
}

/** Distance from the drawing origin to line `index`'s top. The first line is at 0. */
export function lineOrigin(index: number, fontSize: number, lineHeight: number): number {
  return index * lineBoxHeight(fontSize, lineHeight);
}

/** Shaped advance of `text` at `fontSize`, in points. This is the width pdfkit draws. */
export function textWidth(text: string, fontSize: number): number {
  return placeLine(text, fontSize).advance;
}

/** Advance and the right ink edge of `text`. The ink edge is used when a line ends. */
export function textBounds(text: string, fontSize: number): TextBounds {
  const ink = placeLine(text, fontSize);
  return {
    advance: ink.advance,
    inkRight: ink.hasInk ? Math.max(ink.maxX, ink.advance) : ink.advance,
  };
}

/**
 * Shaped ink of `text` at `fontSize`. The box is the union of `placeLine`'s
 * glyphs. An unsafe run (shaping threw, or glyph id 0) makes the whole line unsafe.
 */
export function lineInkBox(text: string, fontSize: number): LineInk {
  const line = placeLine(text, fontSize);
  return {
    advance: line.advance,
    minX: line.minX,
    minY: line.minY,
    maxX: line.maxX,
    maxY: line.maxY,
    hasInk: line.hasInk,
    unsafe: line.unsafe,
  };
}

/**
 * The runs drawing will paint for `text`. Font selection happens here, once.
 * A later pass must not call `drawnRuns` on a run's text: the joiner is
 * already gone, so the same characters can fall into a different font.
 */
function placeLine(text: string, fontSize: number): PlacedLine {
  if (giftMessageTooLong(text)) {
    return {
      text,
      runs: [],
      advance: 0,
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      hasInk: false,
      unsafe: true,
      originX: 0,
    };
  }
  const runs: PlacedRun[] = [];
  let advance = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hasInk = false;
  for (const run of drawnRuns(text)) {
    const placed = placeRun(run, fontSize);
    if (!placed) {
      return {
        text,
        runs: [],
        advance: 0,
        minX: 0,
        minY: 0,
        maxX: 0,
        maxY: 0,
        hasInk: false,
        unsafe: true,
        originX: 0,
      };
    }
    if (placed.hasInk) {
      hasInk = true;
      minX = Math.min(minX, advance + placed.minX);
      maxX = Math.max(maxX, advance + placed.maxX);
      minY = Math.min(minY, placed.minY);
      maxY = Math.max(maxY, placed.maxY);
    }
    runs.push(placed);
    advance += placed.advance;
    if (!Number.isFinite(advance)) {
      return {
        text,
        runs: [],
        advance: 0,
        minX: 0,
        minY: 0,
        maxX: 0,
        maxY: 0,
        hasInk: false,
        unsafe: true,
        originX: 0,
      };
    }
  }
  if (!hasInk) {
    return {
      text,
      runs,
      advance,
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      hasInk: false,
      unsafe: false,
      originX: 0,
    };
  }
  return { text, runs, advance, minX, minY, maxX, maxY, hasInk: true, unsafe: false, originX: 0 };
}

/** `null` when this run cannot be drawn. The font is the one `drawnRuns` chose. */
function placeRun(run: { text: string; file: string }, fontSize: number): PlacedRun | null {
  const face = fontFace(run.file);
  const shaped = shapePaint(face, run.text);
  const scale = fontSize / face.unitsPerEm;
  const widthScale = 1000 / face.unitsPerEm;
  if (
    !shaped ||
    shaped.notdef ||
    !Number.isFinite(scale) ||
    scale <= 0 ||
    !Number.isFinite(widthScale)
  ) {
    return null;
  }
  const glyphs: PlacedGlyph[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hasInk = false;
  for (const glyph of shaped.glyphs) {
    if (
      !Number.isFinite(glyph.x) ||
      !Number.isFinite(glyph.xAdvance) ||
      !Number.isFinite(glyph.advanceWidth)
    ) {
      return null;
    }
    const placed: PlacedGlyph = {
      id: glyph.id,
      codePoints: glyph.codePoints,
      widthUnits: glyph.advanceWidth * widthScale,
      x: glyph.x * scale,
      xAdvance: glyph.xAdvance * scale,
      xOffset: glyph.xOffset * scale,
      yOffset: glyph.yOffset * scale,
      minX: glyph.hasInk ? glyph.minX * scale : 0,
      minY: glyph.hasInk ? glyph.minY * scale : 0,
      maxX: glyph.hasInk ? glyph.maxX * scale : 0,
      maxY: glyph.hasInk ? glyph.maxY * scale : 0,
      hasInk: glyph.hasInk,
    };
    if (
      !Number.isFinite(placed.widthUnits) ||
      !Number.isFinite(placed.xOffset) ||
      !Number.isFinite(placed.yOffset)
    ) {
      return null;
    }
    if (placed.hasInk) {
      hasInk = true;
      minX = Math.min(minX, placed.minX);
      maxX = Math.max(maxX, placed.maxX);
      minY = Math.min(minY, placed.minY);
      maxY = Math.max(maxY, placed.maxY);
    }
    glyphs.push(placed);
  }
  const advance = shaped.advance * scale;
  if (!Number.isFinite(advance)) {
    return null;
  }
  if (!hasInk) {
    return {
      text: run.text,
      file: run.file,
      advance,
      glyphs,
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      hasInk: false,
    };
  }
  return { text: run.text, file: run.file, advance, glyphs, minX, minY, maxX, maxY, hasInk: true };
}

/**
 * Block height from the same positions the drawer uses. pdfkit's default
 * baseline is the top of the line, so the first top is the drawing origin
 * and the baseline sits one ascent below it. Each following line advances by
 * `lineOrigin`. The last line's bottom is that baseline plus `|descent|`.
 */
export function blockHeight(lines: number, fontSize: number, lineHeight: number): number {
  if (lines <= 0) {
    return 0;
  }
  const box = emBox(fontSize);
  return lineOrigin(lines - 1, fontSize, lineHeight) + box.ascent + box.descent;
}

/** Noto Sans ascent at `fontSize`. Mixed runs sit on this baseline. */
export function lineAscent(fontSize: number): number {
  return emBox(fontSize).ascent;
}

function emBox(fontSize: number): { ascent: number; descent: number } {
  const face = notoSansFace();
  const scale = fontSize / face.unitsPerEm;
  return { ascent: face.ascent * scale, descent: Math.abs(face.descent) * scale };
}

/**
 * Sizes from `max` down to `min` by 0.5 pt. The endpoints are the exact
 * arguments. Steps that would fall outside the interval are omitted.
 */
export function fontSizes(max: number, min: number): number[] {
  if (!Number.isFinite(max) || !Number.isFinite(min) || min > max) {
    return [max];
  }
  const sizes = [max];
  const maxUnits = Math.round(max * 100);
  const minUnits = Math.round(min * 100);
  let current = maxUnits;
  while (current - 50 > minUnits) {
    current -= 50;
    sizes.push(current / 100);
  }
  if (min !== max) {
    sizes.push(min);
  }
  return sizes;
}

type SourceSegment = { text: string; actual: string; breakAfter: string };

/** `\r\n` and a lone `\r` are one hard break. The break bytes stay on `actual`. */
function sourceSegments(text: string): SourceSegment[] {
  const segments: SourceSegment[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '\n' && char !== '\r') {
      continue;
    }
    const breakEnd = char === '\r' && text[index + 1] === '\n' ? index + 2 : index + 1;
    const content = text.slice(start, index);
    const breakAfter = text.slice(index, breakEnd);
    segments.push({ text: content, actual: `${content}${breakAfter}`, breakAfter });
    start = breakEnd;
    index = breakEnd - 1;
  }
  const tail = text.slice(start);
  segments.push({ text: tail, actual: tail, breakAfter: '' });
  return segments;
}

function wrapLine(line: string, fontSize: number, maxWidth: number): string[] | null {
  if (line.length === 0) {
    return [''];
  }
  if (prefixFits(line, fontSize, maxWidth)) {
    return [line];
  }
  const lines: string[] = [];
  let rest = line;
  while (rest.length > 0) {
    const fitEnd = longestPrefix(rest, fontSize, maxWidth);
    if (fitEnd === rest.length) {
      lines.push(rest);
      break;
    }
    if (fitEnd <= 0) {
      return null;
    }
    let cut = fitEnd;
    if (fitEnd < rest.length) {
      const space = rest.lastIndexOf(' ', fitEnd - 1);
      if (space > 0) {
        const snapped = previousBoundary(rest, space + 1);
        if (snapped > 0) {
          cut = snapped;
        }
      }
    }
    if (cut <= 0) {
      return null;
    }
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return lines;
}

/**
 * Probes 1, 2, 4, … graphemes before the binary search, so each wrapped line
 * costs about its own length, not the length of the rest of the message.
 * The result is a code-unit index on a grapheme boundary.
 */
function longestPrefix(text: string, fontSize: number, maxWidth: number): number {
  const ends = graphemeEnds(text);
  let low = 0;
  let high = 1;
  while (
    high <= ends.length &&
    prefixFits(text.slice(0, ends[high - 1] ?? 0), fontSize, maxWidth)
  ) {
    low = high;
    high *= 2;
  }
  high = Math.min(high, ends.length);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const end = ends[mid - 1] ?? 0;
    if (prefixFits(text.slice(0, end), fontSize, maxWidth)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low === 0 ? 0 : (ends[low - 1] ?? 0);
}

function graphemeEnds(text: string): number[] {
  const ends: number[] = [];
  for (const part of graphemes.segment(text)) {
    const end = part.index + part.segment.length;
    if (end > (ends[ends.length - 1] ?? 0)) {
      ends.push(end);
    }
  }
  return ends;
}

/** Greatest grapheme end at or before `index`. */
function previousBoundary(text: string, index: number): number {
  let boundary = 0;
  for (const end of graphemeEnds(text)) {
    if (end > index) {
      break;
    }
    boundary = end;
  }
  return boundary;
}

/** A prefix fits when its painted advance is within `maxWidth`. Ink is checked after placement. */
function prefixFits(text: string, fontSize: number, maxWidth: number): boolean {
  return textWidth(text, fontSize) <= maxWidth;
}

/**
 * Pen x that puts the ink box inside `width` when the ink is not wider than
 * the area. Left alignment moves right by a negative left bearing. Right
 * alignment moves left by the overhang past the advance. Centre alignment
 * centres the ink box. A line with no ink is aligned by its advance.
 */
function alignOrigin(line: PlacedLine, width: number, align: TextAlign): number {
  if (!line.hasInk) {
    if (align === 'center') {
      return (width - line.advance) / 2;
    }
    if (align === 'right') {
      return width - line.advance;
    }
    return 0;
  }
  const inkWidth = line.maxX - line.minX;
  if (align === 'center') {
    return (width - inkWidth) / 2 - line.minX;
  }
  if (align === 'right') {
    const overhang = Math.max(0, line.maxX - line.advance);
    let origin = width - line.advance - overhang;
    if (origin + line.minX < 0 && inkWidth <= width + INK_SLOP_PT) {
      origin -= origin + line.minX;
    }
    return origin;
  }
  let origin = line.minX < 0 ? -line.minX : 0;
  if (origin + line.maxX > width && inkWidth <= width + INK_SLOP_PT) {
    origin -= origin + line.maxX - width;
  }
  return origin;
}

/**
 * Vertical shift of the block. The preferred alignment is kept when the ink
 * is already inside. Otherwise the block moves, by as little as possible, so
 * the ink sits inside the text area when the ink is not taller than it.
 */
function containedOffset(
  lines: readonly PlacedLine[],
  fontSize: number,
  lineHeight: number,
  height: number,
  verticalAlign: 'top' | 'middle',
): number {
  const used = blockHeight(lines.length, fontSize, lineHeight);
  const preferred = verticalAlign === 'middle' ? Math.max(0, (height - used) / 2) : 0;
  const ascent = lineAscent(fontSize);
  let top0 = Infinity;
  let bottom0 = -Infinity;
  let hasInk = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.hasInk) {
      continue;
    }
    hasInk = true;
    const base = lineOrigin(index, fontSize, lineHeight) + ascent;
    top0 = Math.min(top0, base - line.maxY);
    bottom0 = Math.max(bottom0, base - line.minY);
  }
  if (!hasInk || !(bottom0 > top0)) {
    return preferred;
  }
  if (bottom0 - top0 > height + INK_SLOP_PT) {
    return preferred;
  }
  const top = preferred + top0;
  const bottom = preferred + bottom0;
  if (top >= -INK_SLOP_PT && bottom <= height + INK_SLOP_PT) {
    return preferred;
  }
  let offset = preferred;
  if (top < 0) {
    offset -= top;
  }
  if (offset + bottom0 > height) {
    offset = height - bottom0;
  }
  return offset;
}

/**
 * True when every line's ink, at the stored `originX` and `offsetTop`, stays
 * inside the text area. Coordinates are relative to the text area's top-left,
 * with `y` growing down. A bearing that the alignment shift pulled inside
 * passes. An ink box wider or taller than the area does not.
 */
function inkFits(
  lines: readonly PlacedLine[],
  fontSize: number,
  lineHeight: number,
  width: number,
  height: number,
  offsetTop: number,
): boolean {
  const ascent = lineAscent(fontSize);
  for (let index = 0; index < lines.length; index += 1) {
    const ink = lines[index];
    if (!ink || ink.unsafe) {
      return false;
    }
    if (!ink.hasInk) {
      continue;
    }
    const baseline = offsetTop + lineOrigin(index, fontSize, lineHeight) + ascent;
    const left = ink.originX + ink.minX;
    const right = ink.originX + ink.maxX;
    const top = baseline - ink.maxY;
    const bottom = baseline - ink.minY;
    if (
      left < -INK_SLOP_PT ||
      right > width + INK_SLOP_PT ||
      top < -INK_SLOP_PT ||
      bottom > height + INK_SLOP_PT
    ) {
      return false;
    }
  }
  return true;
}
