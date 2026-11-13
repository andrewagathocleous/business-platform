declare module 'fontkit' {
  export type GlyphBounds = {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };

  export type GlyphPosition = {
    xAdvance: number;
    yAdvance: number;
    xOffset: number;
    yOffset: number;
  };

  export type Glyph = {
    /** 0 is `.notdef`. */
    id: number;
    advanceWidth: number;
    codePoints: number[];
    bbox: GlyphBounds;
  };

  /** A shaped run. Positions are in font units, the same units as `bbox`. */
  export type GlyphRun = {
    glyphs: Glyph[];
    positions: GlyphPosition[];
    advanceWidth: number;
  };

  export type Font = {
    hasGlyphForCodePoint(codePoint: number): boolean;
    unitsPerEm: number;
    ascent: number;
    descent: number;
    glyphsForString(text: string): Glyph[];
    /**
     * OpenType shaping pdfkit uses for `widthOfString` and for drawing.
     * Omit `features` for pdfkit's defaults.
     */
    layout(
      text: string,
      features?: Readonly<Record<string, boolean>> | readonly string[],
    ): GlyphRun;
  };

  export function openSync(filename: string, postscriptName?: string): Font;
}
