import { notoSansFace } from './glyphs';

const SAFETY_PT = 2;

export type TextMeasure = {
  fits: boolean;
  height: number;
};

/**
 * Line breaking for the gift-message card. Width uses the same glyph advances
 * pdfmake asks pdfkit for (`glyphsForString`, not kerning). The fit height is
 * where pdfkit places the lines: the first top is the drawing origin, each
 * later line advances by `lineOrigin`, and the last line ends at its baseline
 * plus `|descent|`. `\r\n` and a lone `\r` are one hard break. The original
 * bytes, including those breaks, stay on `actuals`. Nothing is trimmed.
 */
export function measureText(
  text: string,
  fontSize: number,
  lineHeight: number,
  width: number,
  height: number,
): TextMeasure {
  const maxWidth = width - SAFETY_PT;
  if (maxWidth <= 0 || height <= 0) {
    return { fits: false, height: 0 };
  }
  const laid = layoutLines(text, fontSize, maxWidth);
  const used = blockHeight(laid.lines.length, fontSize, lineHeight);
  return { fits: !laid.overflows && used <= height, height: used };
}

/**
 * Wrapped lines for `text`. A source line that cannot break still comes back,
 * with `overflows` set. `actuals` join back to `text`, breaks included.
 */
export function layoutLines(
  text: string,
  fontSize: number,
  maxWidth: number,
): { lines: string[]; actuals: string[]; overflows: boolean } {
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

/** Advance width of `text` at `fontSize`, in points. */
export function textWidth(text: string, fontSize: number): number {
  return widthOf(text, fontSize);
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
  if (widthOf(line, fontSize) <= maxWidth) {
    return [line];
  }
  const lines: string[] = [];
  let rest = line;
  while (rest.length > 0) {
    if (widthOf(rest, fontSize) <= maxWidth) {
      lines.push(rest);
      break;
    }
    const fitEnd = longestPrefix(rest, fontSize, maxWidth);
    if (fitEnd <= 0) {
      return null;
    }
    let cut = fitEnd;
    if (fitEnd < rest.length) {
      const space = rest.lastIndexOf(' ', fitEnd - 1);
      if (space > 0) {
        cut = space + 1;
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

function longestPrefix(text: string, fontSize: number, maxWidth: number): number {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (widthOf(text.slice(0, mid), fontSize) <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

function widthOf(text: string, fontSize: number): number {
  if (text.length === 0) {
    return 0;
  }
  const face = notoSansFace();
  let advance = 0;
  for (const glyph of face.glyphsForString(text)) {
    advance += glyph.advanceWidth;
  }
  return (advance * fontSize) / face.unitsPerEm;
}
