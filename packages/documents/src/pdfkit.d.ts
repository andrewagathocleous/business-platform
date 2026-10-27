declare module 'pdfkit' {
  type PdfKitFont = {
    unicode: Array<number[] | undefined>;
  };

  type PdfKitDocument = {
    font(src: string): PdfKitDocument;
    fontSize(size: number): PdfKitDocument;
    text(text: string, x: number, y: number, options?: { lineBreak?: boolean }): PdfKitDocument;
    markContent(tag: string, options?: { actual?: string }): PdfKitDocument;
    endMarkedContent(): PdfKitDocument;
    addPage(options?: { size?: [number, number]; margin?: number }): PdfKitDocument;
    end(): void;
    on(event: 'data', listener: (chunk: Buffer) => void): PdfKitDocument;
    on(event: 'end', listener: () => void): PdfKitDocument;
    on(event: 'error', listener: (error: Error) => void): PdfKitDocument;
    _font?: PdfKitFont;
  };

  type PdfKitConstructor = new (options?: {
    size?: [number, number];
    margin?: number;
    autoFirstPage?: boolean;
  }) => PdfKitDocument;

  const PDFDocument: PdfKitConstructor;
  export default PDFDocument;
}
