import PDFDocument from 'pdfkit';
import { fontFiles } from './fonts';
import { unsupportedGlyphs } from './glyphs';
import {
  fontSizes,
  layoutLines,
  lineBoxHeight,
  lineOrigin,
  measureText,
  textWidth,
} from './text-layout';
import { decimalNumber, millimetresToPoints } from './units';

export type GiftAlign = 'left' | 'center';
export type GiftVerticalAlign = 'top' | 'middle';

export type GiftMessageTemplate = {
  pageWidthMm: string;
  pageHeightMm: string;
  marginTopMm: string;
  marginRightMm: string;
  marginBottomMm: string;
  marginLeftMm: string;
  fontSizePt: string;
  minFontSizePt: string;
  lineHeight: string;
  align: GiftAlign;
  verticalAlign: GiftVerticalAlign;
};

export type GiftMessagePdf = {
  pdf: Buffer;
  fits: boolean;
  unsupportedChars: string[];
};

/** Lines `renderGiftMessage` draws, in order, for the size that was chosen. */
export type GiftMessageLayout = {
  lines: string[];
  fontSize: number;
  lineBoxPt: number;
};

type Layout = {
  pageWidth: number;
  pageHeight: number;
  marginLeft: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  contentWidth: number;
  contentHeight: number;
  fontSize: number;
  minFontSize: number;
  lineHeight: number;
  align: GiftAlign;
  verticalAlign: GiftVerticalAlign;
};

/**
 * Draws `text` on the template's page. The string is not trimmed.
 * The font starts at `font_size_pt` and steps down by 0.5 pt to `min_font_size_pt`.
 * Past the minimum, the full text is still drawn and `fits` is false.
 */
export function layoutGiftMessage(text: string, template: GiftMessageTemplate): GiftMessageLayout {
  const planned = plan(text, template);
  return { lines: planned.lines, fontSize: planned.fontSize, lineBoxPt: planned.lineBoxPt };
}

export async function renderGiftMessage(
  text: string,
  template: GiftMessageTemplate,
): Promise<GiftMessagePdf> {
  const unsupportedChars = unsupportedCharsOf(text);
  const planned = plan(text, template);
  const pdf = await draw(planned);
  return { pdf, fits: planned.fits, unsupportedChars };
}

function unsupportedCharsOf(text: string): string[] {
  return unsupportedGlyphs(text);
}

function chooseSize(
  text: string,
  layout: Layout,
): { fontSize: number; fits: boolean; offsetTop: number } {
  const sizes = fontSizes(layout.fontSize, layout.minFontSize);
  for (const size of sizes) {
    const measured = measureText(
      text,
      size,
      layout.lineHeight,
      layout.contentWidth,
      layout.contentHeight,
    );
    if (measured.fits) {
      const spare = layout.contentHeight - measured.height;
      const offsetTop = layout.verticalAlign === 'middle' ? Math.max(0, spare / 2) : 0;
      return { fontSize: size, fits: true, offsetTop };
    }
  }
  const smallest = sizes[sizes.length - 1] ?? layout.minFontSize;
  return { fontSize: smallest, fits: false, offsetTop: 0 };
}

const SAFETY_PT = 2;

type Planned = GiftMessageLayout & {
  fits: boolean;
  offsetTop: number;
  layout: Layout;
  actuals: string[];
};

function plan(text: string, template: GiftMessageTemplate): Planned {
  const layout = readLayout(template);
  const chosen = chooseSize(text, layout);
  const laid = layoutLines(text, chosen.fontSize, layout.contentWidth - SAFETY_PT);
  return {
    lines: laid.lines,
    actuals: laid.actuals,
    fontSize: chosen.fontSize,
    lineBoxPt: lineBoxHeight(chosen.fontSize, layout.lineHeight),
    fits: chosen.fits,
    offsetTop: chosen.offsetTop,
    layout,
  };
}

/** Draws `planned.lines` once. pdfkit's own ToUnicode map stays in place. */
async function draw(planned: Planned): Promise<Buffer> {
  const { layout, fontSize, lines, actuals, offsetTop } = planned;
  const doc = new PDFDocument({
    size: [layout.pageWidth, layout.pageHeight],
    margin: 0,
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);
  });
  doc.font(fontFiles.normal).fontSize(fontSize);
  let y = layout.marginTop + offsetTop;
  let pageTop = y;
  const advance = lineOrigin(1, fontSize, layout.lineHeight);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const actual = actuals[index] ?? line;
    const bottom = layout.pageHeight - layout.marginBottom;
    if (y > bottom && y !== pageTop) {
      doc.addPage({ size: [layout.pageWidth, layout.pageHeight], margin: 0 });
      y = layout.marginTop;
      pageTop = y;
    }
    const lineWidth = line.length > 0 ? textWidth(line, fontSize) : 0;
    const x =
      layout.align === 'center'
        ? layout.marginLeft + (layout.contentWidth - lineWidth) / 2
        : layout.marginLeft;
    doc.markContent('Span', { actual });
    if (line.length > 0) {
      doc.text(line, x, y, { lineBreak: false });
    }
    doc.endMarkedContent();
    y += advance;
  }
  doc.end();
  return done;
}

function readLayout(template: GiftMessageTemplate): Layout {
  const pageWidth = millimetresToPoints(template.pageWidthMm);
  const pageHeight = millimetresToPoints(template.pageHeightMm);
  const marginLeft = millimetresToPoints(template.marginLeftMm);
  const marginTop = millimetresToPoints(template.marginTopMm);
  const marginRight = millimetresToPoints(template.marginRightMm);
  const marginBottom = millimetresToPoints(template.marginBottomMm);
  const fontSize = decimalNumber(template.fontSizePt);
  const minFontSize = decimalNumber(template.minFontSizePt);
  const lineHeight = decimalNumber(template.lineHeight);
  if (pageWidth <= 0 || pageHeight <= 0 || fontSize <= 0 || minFontSize <= 0 || lineHeight <= 0) {
    throw new Error('gift message template sizes must be positive');
  }
  return {
    pageWidth,
    pageHeight,
    marginLeft,
    marginTop,
    marginRight,
    marginBottom,
    contentWidth: pageWidth - marginLeft - marginRight,
    contentHeight: pageHeight - marginTop - marginBottom,
    fontSize,
    minFontSize,
    lineHeight,
    align: template.align,
    verticalAlign: template.verticalAlign,
  };
}
