import { openSync, type Font } from 'fontkit';
import { fontFiles } from './fonts';

let cached: Font | undefined;

/**
 * Code points in `text` that Noto Sans Regular cannot draw.
 * Whitespace is skipped: gift messages keep line breaks, and the font has no glyph for them.
 */
export function notoSansFace(): Font {
  return notoSans();
}

export function unsupportedGlyphs(text: string): string[] {
  const face = notoSans();
  const found: string[] = [];
  const seen = new Set<number>();
  for (const char of text) {
    if (/^\s$/u.test(char)) {
      continue;
    }
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || seen.has(codePoint)) {
      continue;
    }
    if (face.hasGlyphForCodePoint(codePoint)) {
      continue;
    }
    seen.add(codePoint);
    found.push(char);
  }
  return found;
}

function notoSans(): Font {
  cached ??= openSync(fontFiles.normal);
  return cached;
}
