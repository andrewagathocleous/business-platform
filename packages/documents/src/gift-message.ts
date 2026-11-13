import { giftMessageTooLong } from '@bp/domain';
import PDFDocument from 'pdfkit';
import { fontFiles } from './fonts';
import { giftMessageGlyphs } from './glyphs';
import { withShapingCache } from './shaping';
import {
  fontSizes,
  lineAscent,
  lineBoxHeight,
  lineOrigin,
  placeGiftText,
  type PlacedGlyph,
  type PlacedLine,
  type PlacedRun,
  type TextAlign,
} from './text-layout';
import { decimalNumber, millimetresToPoints } from './units';

export type GiftAlign = TextAlign;
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
  /** Unique `U+XXXX` code points. Never the character or the message. */
  unsupportedChars: string[];
  /** Characters left off the card. Invisible selectors are not counted. */
  omittedCount: number;
};

/**
 * Lines `renderGiftMessage` draws, in order, for the size that was chosen.
 * `placed` is the geometry of those lines. Fit and drawing both use it.
 */
export type GiftMessageLayout = {
  lines: string[];
  fontSize: number;
  lineBoxPt: number;
  placed: PlacedLine[];
  /** Vertical shift of the block, in points. Drawing uses this value. */
  offsetTop: number;
};

export type { PlacedGlyph, PlacedLine, PlacedRun };

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
 * A message longer than the card is not shaped. Layout is empty and the
 * rendered page is blank, with `fits` false. The text is not cut.
 */
export function layoutGiftMessage(text: string, template: GiftMessageTemplate): GiftMessageLayout {
  if (giftMessageTooLong(text)) {
    const layout = readLayout(template);
    return {
      lines: [],
      fontSize: layout.minFontSize,
      lineBoxPt: lineBoxHeight(layout.minFontSize, layout.lineHeight),
      placed: [],
      offsetTop: 0,
    };
  }
  const planned = plan(text, template);
  return {
    lines: planned.lines,
    fontSize: planned.fontSize,
    lineBoxPt: planned.lineBoxPt,
    placed: planned.placed,
    offsetTop: planned.offsetTop,
  };
}

export async function renderGiftMessage(
  text: string,
  template: GiftMessageTemplate,
): Promise<GiftMessagePdf> {
  const layout = readLayout(template);
  if (giftMessageTooLong(text)) {
    return {
      pdf: await blankPage(layout),
      fits: false,
      unsupportedChars: [],
      omittedCount: 0,
    };
  }
  try {
    const prepared = withShapingCache(() => {
      const glyphs = giftMessageGlyphs(text);
      const planned = plan(text, template);
      return { glyphs, planned };
    });
    const pdf = await draw(prepared.planned);
    return {
      pdf,
      fits: prepared.planned.fits,
      unsupportedChars: prepared.glyphs.unsupportedChars,
      omittedCount: prepared.glyphs.omittedCount,
    };
  } catch {
    const omitted = omitAll(text);
    return {
      pdf: await blankPage(layout),
      fits: false,
      unsupportedChars: omitted.unsupportedChars,
      omittedCount: omitted.omittedCount,
    };
  }
}

/** Last resort: nothing was drawn, so every paintable code point is omitted. */
function omitAll(text: string): { unsupportedChars: string[]; omittedCount: number } {
  const unsupportedChars: string[] = [];
  const seen = new Set<number>();
  let omittedCount = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (
      code === undefined ||
      code === 0x0a ||
      code === 0x0d ||
      code === 0xfe0e ||
      code === 0xfe0f ||
      code === 0x200d
    ) {
      continue;
    }
    omittedCount += 1;
    if (!seen.has(code)) {
      seen.add(code);
      unsupportedChars.push(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
  return { unsupportedChars, omittedCount };
}

type Planned = GiftMessageLayout & {
  fits: boolean;
  offsetTop: number;
  layout: Layout;
  actuals: string[];
};

function plan(text: string, template: GiftMessageTemplate): Planned {
  return withShapingCache(() => planOnce(text, template));
}

function planOnce(text: string, template: GiftMessageTemplate): Planned {
  const layout = readLayout(template);
  const sizes = fontSizes(layout.fontSize, layout.minFontSize);
  let chosen: ReturnType<typeof placeGiftText> | undefined;
  // The sizes are the layout probes. They share this operation's shaping cache.
  for (const size of sizes) {
    chosen = placeGiftText(
      text,
      size,
      layout.lineHeight,
      layout.contentWidth,
      layout.contentHeight,
      layout.align,
      layout.verticalAlign,
    );
    if (chosen.fits) {
      break;
    }
  }
  if (!chosen) {
    throw new Error('gift message has no font size');
  }
  return {
    lines: chosen.lines,
    actuals: chosen.actuals,
    placed: chosen.placed,
    fontSize: chosen.fontSize,
    lineBoxPt: lineBoxHeight(chosen.fontSize, layout.lineHeight),
    fits: chosen.fits,
    offsetTop: chosen.offsetTop,
    layout,
  };
}

/** Draws `planned.placed` once. Positions come from that list, not a second measure. */
async function draw(planned: Planned): Promise<Buffer> {
  const { layout, fontSize, placed, actuals, offsetTop } = planned;
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
  clipToTextArea(doc, layout);
  let y = layout.marginTop + offsetTop;
  let pageTop = y;
  let drew = false;
  const advance = lineOrigin(1, fontSize, layout.lineHeight);
  for (let index = 0; index < placed.length; index += 1) {
    const line = placed[index];
    const actual = actuals[index] ?? line?.text ?? '';
    const bottom = layout.pageHeight - layout.marginBottom;
    if (y > bottom && y !== pageTop) {
      doc.restore();
      doc.addPage({ size: [layout.pageWidth, layout.pageHeight], margin: 0 });
      clipToTextArea(doc, layout);
      y = layout.marginTop;
      pageTop = y;
    }
    const x = layout.marginLeft + (line?.originX ?? 0);
    doc.markContent('Span', { actual });
    if (line && paintLine(doc, line, x, y, fontSize)) {
      drew = true;
    }
    doc.endMarkedContent();
    y += advance;
  }
  if (!drew) {
    doc.font(fontFiles.normal).fontSize(fontSize);
  }
  doc.restore();
  doc.end();
  return done;
}

function clipToTextArea(doc: GiftPdf, layout: Layout): void {
  doc.save();
  doc.rect(layout.marginLeft, layout.marginTop, layout.contentWidth, layout.contentHeight).clip();
}

async function blankPage(layout: Layout): Promise<Buffer> {
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
  clipToTextArea(doc, layout);
  doc.restore();
  doc.end();
  return done;
}

type GiftPdf = InstanceType<typeof PDFDocument>;

/**
 * Paints `line.runs` at the positions `placeLine` stored. The baseline is the
 * Noto Sans baseline, which is also pdfkit's default top baseline for a line
 * that is only Noto Sans. Nothing here measures text or chooses a font.
 * ActualText still carries the original line.
 */
function paintLine(
  doc: GiftPdf,
  line: PlacedLine,
  x: number,
  y: number,
  fontSize: number,
): boolean {
  if (line.runs.length === 0) {
    return false;
  }
  const baseline = y + lineAscent(fontSize);
  let cursor = x;
  let drew = false;
  for (const run of line.runs) {
    if (paintRun(doc, run, cursor, baseline, fontSize)) {
      drew = true;
    }
    cursor += run.advance;
  }
  return drew;
}

/**
 * Shows each stored glyph at its stored position. A throw skips the run.
 * The caller still steps by `run.advance`, so the next run stays put.
 */
function paintRun(
  doc: GiftPdf,
  run: PlacedRun,
  x: number,
  baseline: number,
  fontSize: number,
): boolean {
  if (run.glyphs.length === 0) {
    return false;
  }
  let saved = false;
  try {
    doc.font(run.file).fontSize(fontSize);
    const embedded = doc._font;
    const page = doc.page;
    if (!embedded?.subset || embedded.id.length === 0) {
      return false;
    }
    if (page.fonts[embedded.id] == null) {
      page.fonts[embedded.id] = embedded.ref();
    }
    doc.save();
    saved = true;
    doc.transform(1, 0, 0, -1, 0, page.height);
    const baseY = page.height - baseline;
    doc.addContent('BT');
    doc.addContent(`/${embedded.id} ${pdfNumber(fontSize)} Tf`);
    for (const glyph of run.glyphs) {
      const subsetId = embedded.subset.includeGlyph(glyph.id);
      if (embedded.widths[subsetId] == null) {
        embedded.widths[subsetId] = glyph.widthUnits;
      }
      if (embedded.unicode[subsetId] == null) {
        embedded.unicode[subsetId] = glyph.codePoints.length > 0 ? glyph.codePoints : [0];
      }
      const gx = x + glyph.x + glyph.xOffset;
      const gy = baseY + glyph.yOffset;
      doc.addContent(`1 0 0 1 ${pdfNumber(gx)} ${pdfNumber(gy)} Tm`);
      doc.addContent(`<${subsetId.toString(16).padStart(4, '0')}> Tj`);
    }
    doc.addContent('ET');
    doc.restore();
    return true;
  } catch {
    if (saved) {
      doc.restore();
    }
    return false;
  }
}

function pdfNumber(value: number): string {
  if (!(value > -1e21 && value < 1e21)) {
    return '0';
  }
  return String(Math.round(value * 1e6) / 1e6);
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
