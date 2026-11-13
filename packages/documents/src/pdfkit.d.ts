declare module 'pdfkit' {
  type PdfKitEmbeddedFont = {
    id: string;
    subset: { includeGlyph(glyph: number): number };
    widths: Array<number | undefined>;
    unicode: Array<number[] | undefined>;
    ref(): unknown;
  };

  type PdfKitDocument = {
    font(src: string): PdfKitDocument;
    fontSize(size: number): PdfKitDocument;
    text(
      text: string,
      x: number,
      y: number,
      options?: { lineBreak?: boolean; baseline?: string },
    ): PdfKitDocument;
    /** Shaped advance of `text` in the current font and size, in points. */
    widthOfString(text: string): number;
    save(): PdfKitDocument;
    restore(): PdfKitDocument;
    transform(
      m11: number,
      m12: number,
      m21: number,
      m22: number,
      dx: number,
      dy: number,
    ): PdfKitDocument;
    addContent(data: string): PdfKitDocument;
    rect(x: number, y: number, w: number, h: number): PdfKitDocument;
    clip(): PdfKitDocument;
    markContent(tag: string, options?: { actual?: string }): PdfKitDocument;
    endMarkedContent(): PdfKitDocument;
    addPage(options?: { size?: [number, number]; margin?: number }): PdfKitDocument;
    end(): void;
    on(event: 'data', listener: (chunk: Buffer) => void): PdfKitDocument;
    on(event: 'end', listener: () => void): PdfKitDocument;
    on(event: 'error', listener: (error: Error) => void): PdfKitDocument;
    page: { height: number; fonts: Record<string, unknown> };
    _font?: PdfKitEmbeddedFont;
  };

  type PdfKitConstructor = new (options?: {
    size?: [number, number];
    margin?: number;
    autoFirstPage?: boolean;
  }) => PdfKitDocument;

  const PDFDocument: PdfKitConstructor;
  export default PDFDocument;
}
