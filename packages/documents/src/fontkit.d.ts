declare module 'fontkit' {
  export type Glyph = {
    advanceWidth: number;
  };

  export type Font = {
    hasGlyphForCodePoint(codePoint: number): boolean;
    unitsPerEm: number;
    ascent: number;
    descent: number;
    glyphsForString(text: string): Glyph[];
  };

  export function openSync(filename: string, postscriptName?: string): Font;
}
