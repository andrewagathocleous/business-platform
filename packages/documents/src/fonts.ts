import { resolve, sep } from 'node:path';
import pdfmake from 'pdfmake';

export const FONT_FAMILY = 'NotoSans';

const fontsDir = resolve(__dirname, '../assets/fonts');

export const fontFiles = {
  normal: resolve(fontsDir, 'NotoSans-Regular.ttf'),
  bold: resolve(fontsDir, 'NotoSans-Bold.ttf'),
  italics: resolve(fontsDir, 'NotoSans-Italic.ttf'),
  bolditalics: resolve(fontsDir, 'NotoSans-Bold.ttf'),
};

/** pdfmake may only read the committed Noto Sans files. */
export function fontPathAllowed(candidate: string): boolean {
  const resolved = resolve(candidate);
  return resolved === fontsDir || resolved.startsWith(`${fontsDir}${sep}`);
}

let fontsReady = false;

/** Registers Noto Sans and blocks pdfmake from fetching any other file or URL. */
export function ensureDocumentFonts(): void {
  if (fontsReady) {
    return;
  }
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((candidate) => fontPathAllowed(candidate));
  pdfmake.setFonts({ [FONT_FAMILY]: fontFiles });
  fontsReady = true;
}
