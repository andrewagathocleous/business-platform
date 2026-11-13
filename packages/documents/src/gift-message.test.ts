import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { GIFT_MESSAGE_MAX_CODE_POINTS } from '@bp/domain';
import PDFDocument from 'pdfkit';
import { describe, expect, it } from 'vitest';
import { fontFiles } from './fonts';
import { fontFace, drawnRuns, giftMessageGlyphs } from './glyphs';
import {
  layoutGiftMessage,
  renderGiftMessage,
  type GiftMessageLayout,
  type GiftMessageTemplate,
} from './gift-message';
import { shapePaint, shapingCacheSize } from './shaping';
import { renderPackingSlip } from './packing-slip';
import {
  blockHeight,
  fontSizes,
  layoutLines,
  lineAscent,
  lineOrigin,
  measureText,
  placeGiftText,
  textWidth,
} from './text-layout';
import { millimetresToPoints } from './units';

const CARD: GiftMessageTemplate = {
  pageWidthMm: '148.00',
  pageHeightMm: '105.00',
  marginTopMm: '12.00',
  marginRightMm: '12.00',
  marginBottomMm: '12.00',
  marginLeftMm: '12.00',
  fontSizePt: '16.00',
  minFontSizePt: '10.00',
  lineHeight: '1.200',
  align: 'center',
  verticalAlign: 'middle',
};

const GREEK = 'Χρόνια πολλά, Μαρία!\n\nΜε αγάπη, \nΓιώργος & Ελένη — «καλή χρονιά»';

describe('fontSizes', () => {
  it('starts at the max, steps down inside the interval, and includes the exact min', () => {
    const sizes = fontSizes(16.26, 10.24);
    expect(sizes[0]).toBe(16.26);
    expect(sizes[sizes.length - 1]).toBe(10.24);
    expect(sizes).not.toContain(16.5);
    expect(sizes).not.toContain(10);
    for (const size of sizes) {
      expect(size).toBeLessThanOrEqual(16.26);
      expect(size).toBeGreaterThanOrEqual(10.24);
    }
    for (let index = 1; index < sizes.length - 1; index += 1) {
      const previous = sizes[index - 1];
      const current = sizes[index];
      expect(previous !== undefined && current !== undefined ? previous - current : 0).toBeCloseTo(
        0.5,
        5,
      );
    }
    expect(fontSizes(16, 10)).toEqual([
      16, 15.5, 15, 14.5, 14, 13.5, 13, 12.5, 12, 11.5, 11, 10.5, 10,
    ]);
    expect(fontSizes(10.24, 10.24)).toEqual([10.24]);
  });
});

describe('measureText', () => {
  it('reports that H does not fit a 1 mm page when the line height is tiny', () => {
    const height = millimetresToPoints('1');
    expect(measureText('H', 16, 0.001, 200, height).fits).toBe(false);
  });

  it('fits H on a 20 mm page with 6 mm margins at 16 pt and line height 0.8', () => {
    const contentHeight =
      millimetresToPoints('20') - millimetresToPoints('6') - millimetresToPoints('6');
    expect(contentHeight).toBeCloseTo(22.677, 2);
    expect(measureText('H', 16, 0.8, 200, contentHeight).fits).toBe(true);
  });
});

describe('hard line breaks', () => {
  it('treats CRLF and a lone CR as one break and keeps them in ActualText', async () => {
    const prefix = `${'H'.repeat(29)}i`;
    const crlf = `${prefix}\r\nH`;
    const lf = `${prefix}\nH`;
    const cr = `${prefix}\rH`;
    const width = textWidth(prefix, 16);
    expect(textWidth(`${prefix}\r`, 16)).toBe(width);
    const maxWidth = width + 1;
    expect(layoutLines(crlf, 16, maxWidth).lines).toEqual(layoutLines(lf, 16, maxWidth).lines);
    expect(layoutLines(cr, 16, maxWidth).lines).toEqual(layoutLines(lf, 16, maxWidth).lines);
    expect(layoutLines(lf, 16, maxWidth).lines).toEqual([prefix, 'H']);
    const wide: GiftMessageTemplate = {
      ...CARD,
      pageWidthMm: '400.00',
      marginLeftMm: '5.00',
      marginRightMm: '5.00',
      fontSizePt: '16.00',
      minFontSizePt: '16.00',
    };
    const stored = crlf;
    const before = Buffer.from(stored, 'utf8');
    const rendered = await renderGiftMessage(stored, wide);
    expect(Buffer.from(stored, 'utf8')).toEqual(before);
    expect(actualTexts(rendered.pdf).join('')).toBe(stored);
    const lfRendered = await renderGiftMessage(lf, wide);
    expect(actualTexts(lfRendered.pdf).join('')).toBe(lf);
    expect(layoutGiftMessage(stored, wide).lines).toEqual(layoutGiftMessage(lf, wide).lines);
  });
});

describe('layoutGiftMessage', () => {
  it('keeps every source line, including blanks and trailing spaces, and wraps only at the card width', () => {
    const width = contentWidth(CARD);
    for (const text of [GREEK, '  hello  \n\n  ', 'hello  \n\n  there  ']) {
      const laid = layoutGiftMessage(text, CARD);
      expect(laid.lines).toEqual(text.split('\n'));
      for (const line of laid.lines) {
        expect(textWidth(line, laid.fontSize)).toBeLessThanOrEqual(width + 0.05);
      }
    }
    const overlong = `${'καλημέρα '.repeat(40)}end`;
    const wrapped = layoutGiftMessage(overlong, CARD);
    expect(wrapped.lines.length).toBeGreaterThan(1);
    expectLinesCover([overlong], wrapped.lines, wrapped.fontSize, width);
    expect(
      Math.max(...wrapped.lines.map((line) => textWidth(line, wrapped.fontSize))),
    ).toBeGreaterThan(width / 2);
    const tall = `${'ω'.repeat(40)}\n`.repeat(8);
    const stacked = layoutGiftMessage(tall, CARD);
    expectLinesCover(tall.split('\n'), stacked.lines, stacked.fontSize, width);
  });
});

describe('renderGiftMessage', () => {
  it('keeps the Greek message and reports no missing glyphs', async () => {
    const rendered = await renderGiftMessage(GREEK, CARD);
    expect(rendered.pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    expect(rendered.fits).toBe(true);
    expect(rendered.unsupportedChars).toEqual([]);
  });

  it('shrinks a 600-character message or flags that it does not fit', async () => {
    const message = 'καλημέρα '.repeat(67).slice(0, 600);
    expect(message).toHaveLength(600);
    const rendered = await renderGiftMessage(message, CARD);
    expect(rendered.pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    expect(rendered.unsupportedChars).toEqual([]);
    const contentWidth =
      millimetresToPoints(CARD.pageWidthMm) -
      millimetresToPoints(CARD.marginLeftMm) -
      millimetresToPoints(CARD.marginRightMm);
    const contentHeight =
      millimetresToPoints(CARD.pageHeightMm) -
      millimetresToPoints(CARD.marginTopMm) -
      millimetresToPoints(CARD.marginBottomMm);
    expect(measureText(message, 16, 1.2, contentWidth, contentHeight).fits).toBe(false);
    const fitsSomewhere = fontSizes(16, 10).some(
      (size) => measureText(message, size, 1.2, contentWidth, contentHeight).fits,
    );
    expect(rendered.fits).toBe(fitsSomewhere);
  });

  it('flags a message that cannot fit at the minimum size', async () => {
    const message = `${'ω'.repeat(40)}\n`.repeat(40);
    const rendered = await renderGiftMessage(message, CARD);
    expect(rendered.fits).toBe(false);
  });

  it('draws the emoji fixture', async () => {
    const rendered = await renderGiftMessage(giftMessage('order-1003-emoji-gift.json'), CARD);
    expect(rendered.fits).toBe(true);
    expect(rendered.unsupportedChars).toEqual([]);
    expect(rendered.omittedCount).toBe(0);
  });

  it('does not trim spaces or line breaks before measuring', async () => {
    const text = '  hello  \n\n  ';
    const rendered = await renderGiftMessage(text, CARD);
    expect(rendered.fits).toBe(true);
    expect(rendered.unsupportedChars).toEqual([]);
  });
});

/** The R1-F preset for the shop's Zebra ZD230: a 100 × 150 mm portrait label. */
const ZEBRA: GiftMessageTemplate = {
  pageWidthMm: '100.00',
  pageHeightMm: '150.00',
  marginTopMm: '5.00',
  marginRightMm: '5.00',
  marginBottomMm: '5.00',
  marginLeftMm: '5.00',
  fontSizePt: '16.00',
  minFontSizePt: '9.00',
  lineHeight: '1.250',
  align: 'center',
  verticalAlign: 'middle',
};

describe('Zebra 100 × 150 mm card', () => {
  it('draws a short Greek message at full size on one portrait 100 × 150 mm page, keeping its line breaks', async () => {
    const laid = layoutGiftMessage(GREEK, ZEBRA);
    expect(laid.fontSize).toBe(16);
    // The blank line stays; a long line may wrap inside the 90 mm text width.
    expect(laid.lines).toContain('');
    expectLinesCover(GREEK.split('\n'), laid.lines, laid.fontSize, contentWidth(ZEBRA));
    const rendered = await renderGiftMessage(GREEK, ZEBRA);
    expect(rendered.fits).toBe(true);
    expect(rendered.unsupportedChars).toEqual([]);
    const raw = rendered.pdf.toString('latin1');
    const boxes = [...raw.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)];
    expect(boxes).toHaveLength(1);
    expect(Number(boxes[0]?.[1])).toBeCloseTo(millimetresToPoints('100'), 1);
    expect(Number(boxes[0]?.[2])).toBeCloseTo(millimetresToPoints('150'), 1);
  });

  it('steps a long English message down but keeps it at or above 9 pt', () => {
    const sentence =
      'Wishing you a wonderful birthday full of laughter, good food and the people you love. ';
    let message = sentence;
    let laid = layoutGiftMessage(message, ZEBRA);
    while (laid.fontSize === 16) {
      message += sentence;
      laid = layoutGiftMessage(message, ZEBRA);
    }
    expect(laid.fontSize).toBeLessThan(16);
    expect(laid.fontSize).toBeGreaterThanOrEqual(9);
    const width = contentWidth(ZEBRA);
    const height =
      millimetresToPoints(ZEBRA.pageHeightMm) -
      millimetresToPoints(ZEBRA.marginTopMm) -
      millimetresToPoints(ZEBRA.marginBottomMm);
    expect(measureText(message, laid.fontSize, 1.25, width, height).fits).toBe(true);
    expectLinesCover(message.split('\n'), laid.lines, laid.fontSize, width);
  });

  it('flags a message too long for the card at 9 pt and still draws all of it', async () => {
    const message = 'Many happy returns of the day! '.repeat(120);
    const rendered = await renderGiftMessage(message, ZEBRA);
    expect(rendered.fits).toBe(false);
    expect(layoutGiftMessage(message, ZEBRA).fontSize).toBe(9);
    expect(actualTexts(rendered.pdf).join('')).toBe(message);
    // About 0.6 s locally; a busy CI runner took 6.8 s, past the 5 s default.
  }, 30_000);
});

describe('fallback fonts on a 100 × 150 mm card', () => {
  it.each([
    ['a heart', '\u2764\uFE0F', [], 0],
    ['a smile', '\u{1F60A}', [], 0],
    ['a Greek message with line breaks ending in a heart', `${GREEK}\n\u2764\uFE0F`, [], 0],
    ['a family joined by ZWJ', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', [], 0],
    ['a skin-tone emoji', '\u{1F44D}\u{1F3FD}', [], 0],
    ['a character no bundled font has', 'Hello \u0378', ['U+0378'], 1],
  ])('%s reports fits and the unsupported code points', async (_label, text, codes, omitted) => {
    const before = Buffer.from(text, 'utf8');
    const rendered = await renderGiftMessage(text, ZEBRA);
    expect(Buffer.from(text, 'utf8')).toEqual(before);
    expect(rendered.fits).toBe(true);
    expect(rendered.unsupportedChars).toEqual(codes);
    expect(rendered.omittedCount).toBe(omitted);
    expect(actualTexts(rendered.pdf).join('')).toBe(text);
    const laid = layoutGiftMessage(text, ZEBRA);
    const width = contentWidth(ZEBRA);
    const height = contentHeight(ZEBRA);
    for (const line of laid.lines) {
      expect(textWidth(line, laid.fontSize)).toBeLessThanOrEqual(width + 0.05);
    }
    expect(
      blockHeight(laid.lines.length, laid.fontSize, Number(ZEBRA.lineHeight)),
    ).toBeLessThanOrEqual(height + 0.05);
  });

  it('embeds only the fonts a card uses, and subsets them', async () => {
    const greek = await renderGiftMessage(GREEK, ZEBRA);
    const heart = await renderGiftMessage('Hello \u2764\uFE0F', ZEBRA);
    const smile = await renderGiftMessage('\u{1F60A}', ZEBRA);
    expect(pdfHas(greek.pdf, 'NotoSans-Regular')).toBe(true);
    expect(pdfHas(greek.pdf, 'NotoSansSymbols2')).toBe(false);
    expect(pdfHas(greek.pdf, 'NotoEmoji')).toBe(false);
    expect(pdfHas(heart.pdf, 'NotoSansSymbols2')).toBe(true);
    expect(pdfHas(heart.pdf, 'NotoEmoji')).toBe(false);
    expect(pdfHas(smile.pdf, 'NotoEmoji')).toBe(true);
    for (const pdf of [greek.pdf, heart.pdf, smile.pdf]) {
      expect(pdf.length).toBeGreaterThan(500);
      expect(pdf.length).toBeLessThan(100_000);
    }
  });
});

const LOCKED: GiftMessageTemplate = { ...ZEBRA, minFontSizePt: '16.00' };
const LEFT_BEARING = `\u{102F2}${'a'.repeat(26)}`;
const STACKED_MARKS = `a${'\u0301'.repeat(80)}\u{1F60A}`;

describe('ink stays inside the text area', () => {
  it('shifts a left bearing and a mark stack onto the card when the ink box fits', async () => {
    for (const text of [LEFT_BEARING, STACKED_MARKS]) {
      const laid = layoutGiftMessage(text, LOCKED);
      const rendered = await renderGiftMessage(text, LOCKED);
      expect(rendered.fits, text).toBe(true);
      expect(laid.fontSize, text).toBe(16);
      expect(rendered.omittedCount, text).toBe(0);
      expect(rendered.unsupportedChars, text).toEqual([]);
      expect(inkInside(text, LOCKED), text).toBe(true);
    }
  });
});

const ORDINARY_LATIN = 'John, happy birthday!';
const ORDINARY_GREEK = 'Χρόνια πολλά, Αλέξη!';

describe('ordinary greetings', () => {
  it('fits at the left, centre and right, at the minimum and default sizes', async () => {
    const measure = new PDFDocument({ margin: 0 });
    for (const align of ['left', 'center', 'right'] as const) {
      for (const size of ['16.00', '9.00']) {
        for (const text of [ORDINARY_LATIN, ORDINARY_GREEK]) {
          const template: GiftMessageTemplate = {
            ...ZEBRA,
            align,
            fontSizePt: size,
            minFontSizePt: size,
          };
          const label = `${align} ${size} ${text}`;
          const rendered = await renderGiftMessage(text, template);
          const laid = layoutGiftMessage(text, template);
          expect(rendered.fits, label).toBe(true);
          expect(rendered.omittedCount, label).toBe(0);
          expect(rendered.unsupportedChars, label).toEqual([]);
          expect(advancesMatch(laid, measure), label).toBe(true);
          expect(drawnOriginsMatch(rendered.pdf, laid, template), label).toBe(true);
          expect(lastGlyphInside(laid, template), label).toBe(true);
        }
      }
    }
  });
});

describe('a cluster that cannot be shaped', () => {
  it('reports the cluster and still renders', async () => {
    const text = '1\u{102E0}';
    const rendered = await renderGiftMessage(text, ZEBRA);
    expect(rendered.pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    expect(rendered.fits).toBe(true);
    expect(rendered.unsupportedChars).toEqual(['U+0031', 'U+102E0']);
    expect(rendered.omittedCount).toBe(2);
    expect(drawnRuns(text)).toEqual([]);
    expect(actualTexts(rendered.pdf).join('')).toBe(text);
  });
});

const HEART_FIRE = '\u2764\uFE0F\u200D\u{1F525}M';
const MAP_SMILE = `\u{1F5FA}\u200D\u{1F60A}`.repeat(4) + 'W'.repeat(6);

describe('random gift messages', () => {
  it('draws a joiner run at the advance of the font that paints it', async () => {
    const measure = new PDFDocument({ margin: 0 });
    for (const text of [HEART_FIRE, MAP_SMILE]) {
      const rendered = await renderGiftMessage(text, ZEBRA);
      const laid = layoutGiftMessage(text, ZEBRA);
      expect(rendered.fits, text).toBe(true);
      expect(rendered.omittedCount, text).toBe(0);
      expect(advancesMatch(laid, measure), text).toBe(true);
      expect(drawnOriginsMatch(rendered.pdf, laid, ZEBRA), text).toBe(true);
      expect(lastGlyphInside(laid, ZEBRA), text).toBe(true);
    }
    const heart = layoutGiftMessage(HEART_FIRE, ZEBRA);
    expect(heart.placed[0]?.runs[0]?.advance).toBeCloseTo(40.625, 3);
  });

  it('never throws, stays inside the text area, and accounts for every code point', async () => {
    const samples = [
      '1\u{102E0}',
      '\u{1F408}\u200D\u2B1B'.repeat(8),
      LEFT_BEARING,
      STACKED_MARKS,
      `${GREEK}\n\u2764\uFE0F`,
      '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
      HEART_FIRE,
      MAP_SMILE,
      '\t',
      '\u200D\uFE0F',
      ...randomMessages(2_000, 0x51a1),
    ];
    const measure = new PDFDocument({ margin: 0 });
    for (const text of samples) {
      for (const run of drawnRuns(text)) {
        expect(run.text.includes('\u200D'), sampleLabel(text)).toBe(false);
        expect(run.text.includes('\uFE0E'), sampleLabel(text)).toBe(false);
        expect(run.text.includes('\uFE0F'), sampleLabel(text)).toBe(false);
        const shaped = shapePaint(fontFace(run.file), run.text);
        expect(shaped !== null && !shaped.notdef, sampleLabel(text)).toBe(true);
      }
      for (const align of ['left', 'center', 'right'] as const) {
        const template = { ...ZEBRA, align };
        const rendered = await renderGiftMessage(text, template);
        const laid = layoutGiftMessage(text, template);
        const label = `${align} ${sampleLabel(text)}`;
        expect(rendered.pdf.subarray(0, 5).toString('utf8'), label).toBe('%PDF-');
        expect(hasTextAreaClip(rendered.pdf, template), label).toBe(true);
        expect(advancesMatch(laid, measure), label).toBe(true);
        expect(drawnOriginsMatch(rendered.pdf, laid, template), label).toBe(true);
        if (rendered.fits) {
          expect(inkInside(text, template), label).toBe(true);
          expect(lastGlyphInside(laid, template), label).toBe(true);
        }
        expect(accountsFor(text, rendered.omittedCount), label).toBe(true);
        expect(rendered.omittedCount, label).toBe(giftMessageGlyphs(text).omittedCount);
      }
    }
  }, 600_000);
});

describe('a message longer than the card', () => {
  it('is refused without shaping, quickly and without a large heap growth', async () => {
    const face = fontFace(fontFiles.normal);
    const text = 'i'.repeat(1_000_000);
    const before = process.memoryUsage().heapUsed;
    const started = Date.now();
    const glyphs = giftMessageGlyphs(text);
    const runs = drawnRuns(text);
    const placed = placeGiftText(text, 9, 1.25, 200, 300, 'left', 'top');
    const wrapped = layoutLines(text, 9, 200);
    const measured = measureText(text, 9, 1.25, 200, 300);
    const laid = layoutGiftMessage(text, ZEBRA);
    const rendered = await renderGiftMessage(text, ZEBRA);
    const shaped = shapePaint(face, text);
    const elapsed = Date.now() - started;
    const growth = process.memoryUsage().heapUsed - before;
    expect(glyphs).toEqual({ unsupportedChars: [], omittedCount: 0, fits: false });
    expect(runs).toEqual([]);
    expect(placed.fits).toBe(false);
    expect(placed.placed).toEqual([]);
    expect(wrapped).toEqual({ lines: [], actuals: [], overflows: true });
    expect(measured.fits).toBe(false);
    expect(laid.lines).toEqual([]);
    expect(laid.placed).toEqual([]);
    expect(rendered.fits).toBe(false);
    expect(rendered.unsupportedChars).toEqual([]);
    expect(rendered.omittedCount).toBe(0);
    expect(rendered.pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    expect(rendered.pdf.includes(Buffer.from('i'.repeat(200)))).toBe(false);
    expect(rendered.pdf.length).toBeLessThan(20_000);
    expect(shaped).toBeNull();
    expect(shapingCacheSize()).toBe(0);
    expect(elapsed).toBeLessThan(2_000);
    expect(growth).toBeLessThan(32 * 1024 * 1024);
  });

  it('still shapes a message that is exactly at the limit', () => {
    const text = 'i'.repeat(GIFT_MESSAGE_MAX_CODE_POINTS);
    const glyphs = giftMessageGlyphs(text);
    expect(glyphs.fits).toBe(true);
    expect(glyphs.unsupportedChars).toEqual([]);
    expect(glyphs.omittedCount).toBe(0);
    expect(drawnRuns(text).length).toBeGreaterThan(0);
  });

  it('refuses one code point past the limit without shaping it', async () => {
    const text = 'i'.repeat(GIFT_MESSAGE_MAX_CODE_POINTS + 1);
    const glyphs = giftMessageGlyphs(text);
    const rendered = await renderGiftMessage(text, ZEBRA);
    expect(glyphs.fits).toBe(false);
    expect(glyphs.unsupportedChars).toEqual([]);
    expect(drawnRuns(text)).toEqual([]);
    expect(rendered.fits).toBe(false);
    expect(rendered.omittedCount).toBe(0);
    expect(rendered.pdf.includes(Buffer.from(text))).toBe(false);
  });
});

describe('renderPackingSlip', () => {
  it('renders an A4 slip', async () => {
    const pdf = await renderPackingSlip(
      {
        orderNumber: '#1001',
        storeName: 'Nutbox Demo Shopify',
        deliveryMethod: 'courier_cy',
        recipientName: 'Μαρία Παπαδοπούλου',
        recipientLines: ['1 Demo Street', 'Διαμέρισμα 2'],
        items: [
          { sku: 'NUTS', title: 'Mixed nuts', variantTitle: '250 g', quantity: '2.0000' },
          { sku: 'GIFTBOX', title: 'Gift box', variantTitle: null, quantity: '1.0000' },
        ],
        hasGiftMessage: true,
      },
      { legalName: 'Demo Company A Ltd (fictional)', tradingName: 'Nutbox (demo data)' },
      'en',
    );
    expect(pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  });
});

function contentHeight(template: GiftMessageTemplate): number {
  return (
    millimetresToPoints(template.pageHeightMm) -
    millimetresToPoints(template.marginTopMm) -
    millimetresToPoints(template.marginBottomMm)
  );
}

function pdfHas(pdf: Buffer, name: string): boolean {
  return inflatedPdf(pdf).includes(name);
}

function contentWidth(template: GiftMessageTemplate): number {
  return (
    millimetresToPoints(template.pageWidthMm) -
    millimetresToPoints(template.marginLeftMm) -
    millimetresToPoints(template.marginRightMm)
  );
}

function expectLinesCover(
  sources: readonly string[],
  lines: readonly string[],
  fontSize: number,
  maxWidth: number,
): void {
  let cursor = 0;
  for (const source of sources) {
    expect(cursor).toBeLessThan(lines.length);
    const current = lines[cursor];
    if (current === source) {
      const width = textWidth(current, fontSize);
      if (width > maxWidth + 0.05) {
        expect(source.includes(' ')).toBe(false);
      }
      cursor += 1;
      continue;
    }
    let built = '';
    while (built !== source) {
      const segment = lines[cursor];
      expect(segment && segment.length > 0).toBe(true);
      expect(source.startsWith(`${built}${segment ?? ''}`)).toBe(true);
      const width = textWidth(segment ?? '', fontSize);
      const unbreakable = !(segment ?? '').includes(' ') && width > maxWidth + 0.05;
      if (!unbreakable) {
        expect(width).toBeLessThanOrEqual(maxWidth + 0.05);
      }
      built += segment ?? '';
      cursor += 1;
    }
  }
  expect(cursor).toBe(lines.length);
}

/**
 * pdfkit's compressed streams can contain the bytes `endstream`, so the stream
 * length comes from `/Length` rather than a search for that word.
 */
function readPdfParts(pdf: Buffer): { structure: string; inflated: string } {
  const marker = Buffer.from('stream');
  const structure: Buffer[] = [];
  let inflated = '';
  let pos = 0;
  while (pos < pdf.length) {
    const start = pdf.indexOf(marker, pos);
    if (start === -1) {
      structure.push(pdf.subarray(pos));
      break;
    }
    const before = start > 0 ? pdf[start - 1] : 0;
    const after = pdf[start + marker.length];
    const afterNext = pdf[start + marker.length + 1];
    const lineBreak = after === 0x0a || (after === 0x0d && afterNext === 0x0a);
    if ((before !== 0x0a && before !== 0x0d) || !lineBreak) {
      pos = start + 1;
      continue;
    }
    const dataStart = after === 0x0a ? start + marker.length + 1 : start + marker.length + 2;
    const header = pdf.subarray(Math.max(0, start - 500), start).toString('latin1');
    const lengths = [...header.matchAll(/\/Length (\d+)/g)];
    const length = Number(lengths[lengths.length - 1]?.[1]);
    if (!Number.isInteger(length) || length < 0 || dataStart + length > pdf.length) {
      pos = start + 1;
      continue;
    }
    structure.push(pdf.subarray(pos, dataStart));
    if (header.includes('/FlateDecode')) {
      try {
        inflated += inflateSync(pdf.subarray(dataStart, dataStart + length)).toString('latin1');
      } catch {
        // A font program is Flate data that is not page text.
      }
    }
    pos = dataStart + length;
  }
  return { structure: Buffer.concat(structure).toString('latin1'), inflated };
}

function inflatedPdf(pdf: Buffer): string {
  const parts = readPdfParts(pdf);
  return parts.structure + parts.inflated;
}

function actualTexts(pdf: Buffer): string[] {
  const raw = inflatedPdf(pdf);
  const found: string[] = [];
  let index = 0;
  while (index < raw.length) {
    const marker = raw.indexOf('/ActualText', index);
    if (marker === -1) {
      break;
    }
    let cursor = marker + '/ActualText'.length;
    while (raw[cursor] === ' ' || raw[cursor] === '\n' || raw[cursor] === '\r') {
      cursor += 1;
    }
    if (raw[cursor] === '(') {
      const parsed = readPdfLiteral(raw, cursor);
      found.push(decodeUtf16Literal(parsed.value));
      index = parsed.end;
      continue;
    }
    if (raw[cursor] === '<') {
      const end = raw.indexOf('>', cursor);
      found.push(decodeUtf16Hex(raw.slice(cursor + 1, end)));
      index = end + 1;
      continue;
    }
    index = cursor + 1;
  }
  return found;
}

function readPdfLiteral(raw: string, start: number): { value: string; end: number } {
  let value = '';
  let index = start + 1;
  while (index < raw.length) {
    const char = raw[index];
    if (char === undefined) {
      break;
    }
    if (char === '\\') {
      const next = raw[index + 1] ?? '';
      const named: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
      if (named[next] !== undefined) {
        value += named[next];
        index += 2;
        continue;
      }
      if (next === '\n' || next === '\r') {
        index += next === '\r' && raw[index + 2] === '\n' ? 3 : 2;
        continue;
      }
      value += next;
      index += 2;
      continue;
    }
    if (char === ')') {
      return { value, end: index + 1 };
    }
    value += char;
    index += 1;
  }
  return { value, end: raw.length };
}

/** pdfkit writes ActualText outside PDFDocEncoding as a UTF-16BE literal with a BOM. */
function decodeUtf16Literal(value: string): string {
  if (value.charCodeAt(0) !== 0xfe || value.charCodeAt(1) !== 0xff) {
    return value;
  }
  let decoded = '';
  for (let index = 2; index + 1 < value.length; index += 2) {
    decoded += String.fromCharCode((value.charCodeAt(index) << 8) | value.charCodeAt(index + 1));
  }
  return decoded;
}

function decodeUtf16Hex(hex: string): string {
  const bytes = hex.replace(/\s+/g, '');
  const start = bytes.startsWith('FEFF') || bytes.startsWith('feff') ? 4 : 0;
  let value = '';
  for (let index = start; index + 3 < bytes.length; index += 4) {
    value += String.fromCharCode(Number.parseInt(bytes.slice(index, index + 4), 16));
  }
  return value;
}

const INVISIBLE_CODES = new Set<number>([0x200d, 0xfe0e, 0xfe0f]);

function inkInside(text: string, template: GiftMessageTemplate): boolean {
  const laid = layoutGiftMessage(text, template);
  return glyphsInside(laid, template, false);
}

/** The last ink glyph, and every other glyph, stays inside the text area. */
function lastGlyphInside(laid: GiftMessageLayout, template: GiftMessageTemplate): boolean {
  return glyphsInside(laid, template, true);
}

function glyphsInside(
  laid: GiftMessageLayout,
  template: GiftMessageTemplate,
  requireLast: boolean,
): boolean {
  const width = contentWidth(template);
  const height = contentHeight(template);
  const lineHeight = Number(template.lineHeight);
  const ascent = lineAscent(laid.fontSize);
  let sawInk = false;
  let lastInside = true;
  for (let index = 0; index < laid.placed.length; index += 1) {
    const line = laid.placed[index];
    if (!line || line.unsafe) {
      return false;
    }
    const baseline = laid.offsetTop + lineOrigin(index, laid.fontSize, lineHeight) + ascent;
    let cursor = 0;
    for (const run of line.runs) {
      for (const glyph of run.glyphs) {
        if (!glyph.hasInk) {
          continue;
        }
        sawInk = true;
        const left = line.originX + cursor + glyph.minX;
        const right = line.originX + cursor + glyph.maxX;
        const top = baseline - glyph.maxY;
        const bottom = baseline - glyph.minY;
        lastInside =
          left >= -0.05 && right <= width + 0.05 && top >= -0.05 && bottom <= height + 0.05;
        if (!lastInside) {
          return false;
        }
      }
      cursor += run.advance;
    }
  }
  return !requireLast || !sawInk || lastInside;
}

/**
 * pdfkit's advance for each run, in the run's own font, equals the layout
 * advance. The glyph steps add up to that same advance.
 */
function advancesMatch(laid: GiftMessageLayout, doc: InstanceType<typeof PDFDocument>): boolean {
  for (const line of laid.placed) {
    for (const run of line.runs) {
      doc.font(run.file).fontSize(laid.fontSize);
      const drawn = doc.widthOfString(run.text);
      if (Math.abs(drawn - run.advance) > 0.001) {
        return false;
      }
      let stepped = 0;
      for (const glyph of run.glyphs) {
        stepped += glyph.xAdvance;
      }
      if (Math.abs(stepped - run.advance) > 0.001) {
        return false;
      }
    }
  }
  return true;
}

/** Horizontal origins in the PDF, in paint order. Drawing wrote these, not a second measure. */
function drawnOrigins(pdf: Buffer): number[] {
  const raw = inflatedPdf(pdf);
  const xs: number[] = [];
  for (const match of raw.matchAll(/1 0 0 1 ([-0-9.]+) [-0-9.]+ Tm/g)) {
    xs.push(Number(match[1]));
  }
  return xs;
}

function drawnOriginsMatch(
  pdf: Buffer,
  laid: GiftMessageLayout,
  template: GiftMessageTemplate,
): boolean {
  const left = millimetresToPoints(template.marginLeftMm);
  const expected: number[] = [];
  for (const line of laid.placed) {
    const origin = left + line.originX;
    let cursor = 0;
    for (const run of line.runs) {
      for (const glyph of run.glyphs) {
        expected.push(origin + cursor + glyph.x + glyph.xOffset);
      }
      cursor += run.advance;
    }
  }
  const drawn = drawnOrigins(pdf);
  if (drawn.length !== expected.length) {
    return false;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index] ?? 0;
    const got = drawn[index] ?? 0;
    if (Math.abs(want - got) > 0.05) {
      return false;
    }
  }
  return true;
}

function hasTextAreaClip(pdf: Buffer, template: GiftMessageTemplate): boolean {
  const parts = readPdfParts(pdf);
  const left = millimetresToPoints(template.marginLeftMm);
  const top = millimetresToPoints(template.marginTopMm);
  const width = contentWidth(template);
  const height = contentHeight(template);
  let clips = 0;
  for (const match of parts.inflated.matchAll(/([0-9.]+) ([0-9.]+) ([0-9.]+) ([0-9.]+) re\s+W/g)) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    const w = Number(match[3]);
    const h = Number(match[4]);
    if (
      Math.abs(x - left) < 0.05 &&
      Math.abs(y - top) < 0.05 &&
      Math.abs(w - width) < 0.05 &&
      Math.abs(h - height) < 0.05
    ) {
      clips += 1;
    }
  }
  const pages = [...parts.structure.matchAll(/\/Type \/Page(?!s)/g)].length;
  return clips >= Math.max(1, pages);
}

function accountsFor(text: string, omittedCount: number): boolean {
  const source = codePoints(text).filter((code) => !INVISIBLE_CODES.has(code));
  const painted = codePoints(
    drawnRuns(text)
      .map((run) => run.text)
      .join(''),
  );
  let index = 0;
  let matched = 0;
  let structural = 0;
  for (const code of source) {
    if (index < painted.length && painted[index] === code) {
      matched += 1;
      index += 1;
      continue;
    }
    if (code === 0x0a || code === 0x0d) {
      structural += 1;
    }
  }
  return index === painted.length && source.length - matched - structural === omittedCount;
}

function codePoints(text: string): number[] {
  const codes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code !== undefined) {
      codes.push(code);
    }
  }
  return codes;
}

function sampleLabel(text: string): string {
  const codes = codePoints(text)
    .slice(0, 8)
    .map((code) => `U+${code.toString(16).toUpperCase()}`)
    .join(' ');
  return `${String(codePoints(text).length)} code points ${codes}`;
}

const SAMPLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x007f],
  [0x00a0, 0x017f],
  [0x0300, 0x036f],
  [0x0370, 0x03ff],
  [0x1f1e6, 0x1f1ff],
  [0x1f300, 0x1f64f],
  [0x1f3fb, 0x1f3ff],
  [0x2600, 0x26ff],
  [0x10280, 0x102ff],
  [0xe000, 0xe01f],
  [0xf0000, 0xf001f],
];

function randomMessages(count: number, seed: number): string[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const messages: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = 1 + Math.floor(next() * 24);
    const codes: number[] = [];
    for (let unit = 0; unit < length; unit += 1) {
      const range = SAMPLE_RANGES[Math.floor(next() * SAMPLE_RANGES.length)] ?? [0x20, 0x7e];
      const span = range[1] - range[0];
      codes.push(range[0] + Math.floor(next() * (span + 1)));
      const join = next();
      if (join < 0.15) {
        codes.push(0x200d);
      } else if (join < 0.25) {
        codes.push(0xfe0f);
      }
    }
    messages.push(String.fromCodePoint(...codes));
  }
  return messages;
}

function giftMessage(name: string): string {
  const path = resolve(__dirname, '../../integrations/shopify/fixtures', name);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('customAttributes' in parsed)) {
    throw new Error(`${name} has no attributes`);
  }
  const attributes = parsed.customAttributes;
  if (!Array.isArray(attributes)) {
    throw new Error(`${name} attributes are not an array`);
  }
  for (const entry of attributes) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record.key === 'Gift Message' && typeof record.value === 'string') {
      return record.value;
    }
  }
  throw new Error(`${name} has no gift message`);
}
