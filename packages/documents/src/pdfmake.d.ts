declare module 'pdfmake' {
  type PdfMakeDocument = {
    getBuffer(): Promise<Buffer>;
  };

  type PdfMake = {
    setUrlAccessPolicy(callback: (url: string) => boolean): void;
    setLocalAccessPolicy(callback: (path: string) => boolean): void;
    setFonts(fonts: Record<string, Record<string, string>>): void;
    createPdf(definition: Record<string, unknown>): PdfMakeDocument;
  };

  const pdfmake: PdfMake;
  export default pdfmake;
}
