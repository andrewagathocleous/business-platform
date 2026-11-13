import PDFDocument from 'pdfkit';
import { describe, expect, it } from 'vitest';
import { fallbackFontFiles } from './fonts';
import { layoutGiftMessage, renderGiftMessage, type GiftMessageTemplate } from './gift-message';
import { drawnRuns } from './glyphs';
import { blockHeight, placeGiftText, textBounds, textWidth, type TextAlign } from './text-layout';
import { millimetresToPoints } from './units';

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

describe('grapheme wrapping', () => {
  it.each([
    ['a smile', '\u{1F60A}'],
    ['a ZWJ family', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'],
    ['a skin-tone emoji', '\u{1F44D}\u{1F3FD}'],
    ['a flag', '\u{1F1E8}\u{1F1FE}'],
  ])('keeps %s whole on the Zebra card', async (_label, cluster) => {
    const text = `${'a'.repeat(26)}${cluster}`;
    const laid = layoutGiftMessage(text, ZEBRA);
    expect(laid.fontSize).toBe(16);
    expect(laid.lines).toEqual(['a'.repeat(26), cluster]);
    const rendered = await renderGiftMessage(text, ZEBRA);
    expect(rendered.fits).toBe(true);
    expect(rendered.unsupportedChars).toEqual([]);
    expect(rendered.omittedCount).toBe(0);
  });
});

describe('shaped width', () => {
  it.each([
    ['a flag', '\u{1F1E8}\u{1F1FE}', 20.3125],
    ['a ZWJ family', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', 60.9375],
    ['a skin-tone emoji', '\u{1F44D}\u{1F3FD}', 20.3125],
    ['repeated skin-tone emoji', '\u{1F926}\u{1F3FC}'.repeat(5), 101.5625],
    ['Greek text', 'Χρόνια πολλά', 101.776],
    ['a heart', '\u2764\uFE0F', 15.776],
    ['a black cat', '\u{1F408}\u200D\u2B1B'.repeat(8), 233.344],
  ])('%s matches the width pdfkit draws', (_label, text, expected) => {
    const drawn = drawnAdvance(text, 16);
    expect(textWidth(text, 16)).toBeCloseTo(drawn, 5);
    expect(drawn).toBeCloseTo(expected, 3);
  });

  it('strips joiners and variation selectors before the font sees them', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    expect(drawnRuns(family)).toEqual([
      { text: '\u{1F468}\u{1F469}\u{1F467}', file: fallbackFontFiles.emoji },
    ]);
    expect(drawnRuns('\u2764\uFE0F')).toEqual([
      { text: '\u2764', file: fallbackFontFiles.symbols },
    ]);
    const cats = '\u{1F408}\u200D\u2B1B'.repeat(8);
    expect(drawnRuns(cats)).toEqual([
      { text: '\u{1F408}\u2B1B'.repeat(8), file: fallbackFontFiles.symbols },
    ]);
    for (const run of drawnRuns(cats)) {
      expect(run.text.includes('\u200D')).toBe(false);
    }
  });
});

describe('ink at the end of a line', () => {
  it('counts a zero-advance mark by its ink, and keeps it inside the margin', async () => {
    const mark = textBounds('\u{102E0}', 16);
    expect(mark.advance).toBeCloseTo(0, 5);
    expect(mark.inkRight).toBeCloseTo(8.768, 3);
    const text = `${'a'.repeat(28)}\u{102E0}`;
    const content = contentWidth(ZEBRA);
    const laid = layoutGiftMessage(text, ZEBRA);
    expect(laid.fontSize).toBe(16);
    expect(laid.lines.join('')).toBe(text);
    for (const line of laid.placed) {
      if (!line.hasInk) {
        continue;
      }
      expect(line.originX + line.minX).toBeGreaterThanOrEqual(-0.05);
      expect(line.originX + line.maxX).toBeLessThanOrEqual(content + 0.05);
    }
    const rendered = await renderGiftMessage(text, ZEBRA);
    expect(rendered.fits).toBe(true);
    expect(rendered.unsupportedChars).toEqual([]);
    expect(rendered.omittedCount).toBe(0);
  });
});

const LATIN = 'John, happy birthday!';
const GREEK = 'Χρόνια πολλά, Αλέξη!';

describe('ink alignment', () => {
  it.each(['left', 'center', 'right'] as const)(
    'fits an ordinary %s greeting at the Zebra minimum and default sizes',
    (align) => {
      const width = contentWidth(ZEBRA);
      const height = contentHeight(ZEBRA);
      for (const size of [9, 16]) {
        for (const text of [LATIN, GREEK]) {
          const placed = placeGiftText(text, size, 1.25, width, height, align, 'middle');
          const label = `${align} ${String(size)} ${text}`;
          expect(placed.fits, label).toBe(true);
          expect(placed.placed.length, label).toBeGreaterThan(0);
          const used = blockHeight(placed.placed.length, size, 1.25);
          expect(placed.offsetTop, label).toBeCloseTo(Math.max(0, (height - used) / 2), 3);
          for (const line of placed.placed) {
            expect(line.hasInk, label).toBe(true);
            expect(line.originX + line.minX, label).toBeGreaterThanOrEqual(-0.05);
            expect(line.originX + line.maxX, label).toBeLessThanOrEqual(width + 0.05);
            expectInkShift(line, width, align, label);
          }
        }
      }
    },
  );

  it('moves J right by its 0.702 pt left bearing at the minimum size', () => {
    const placed = placeGiftText(
      LATIN,
      9,
      1.25,
      contentWidth(ZEBRA),
      contentHeight(ZEBRA),
      'left',
      'middle',
    );
    expect(placed.fits).toBe(true);
    expect(placed.placed[0]?.minX).toBeLessThan(0);
    expect(placed.placed[0]?.originX).toBeCloseTo(0.702, 3);
  });

  it('shifts a right-aligned line left by a right overhang', () => {
    const width = contentWidth(ZEBRA);
    const placed = placeGiftText(
      `${'a'.repeat(28)}\u{102E0}`,
      16,
      1.25,
      width,
      contentHeight(ZEBRA),
      'right',
      'middle',
    );
    const line = placed.placed[0];
    expect(line).toBeDefined();
    expect(line && line.maxX).toBeGreaterThan(line?.advance ?? 0);
    expect(placed.fits).toBe(true);
    expect((line?.originX ?? 0) + (line?.maxX ?? 0)).toBeCloseTo(width, 3);
  });

  it('refuses an ink box that is wider or taller than the text area', () => {
    const width = contentWidth(ZEBRA);
    const height = contentHeight(ZEBRA);
    const bearing = `\u{102F2}${'a'.repeat(26)}`;
    const stacked = `a${'\u0301'.repeat(80)}\u{1F60A}`;
    expect(placeGiftText(bearing, 16, 1.25, width, height, 'left', 'middle').fits).toBe(true);
    expect(placeGiftText(bearing, 16, 1.25, 250, height, 'center', 'middle').fits).toBe(false);
    expect(placeGiftText(stacked, 16, 1.25, width, height, 'center', 'middle').fits).toBe(true);
    expect(placeGiftText(stacked, 16, 1.25, width, 100, 'center', 'middle').fits).toBe(false);
  });
});

function expectInkShift(
  line: { advance: number; minX: number; maxX: number; originX: number },
  width: number,
  align: TextAlign,
  label: string,
): void {
  const inkWidth = line.maxX - line.minX;
  if (align === 'left') {
    expect(line.originX, label).toBeCloseTo(line.minX < 0 ? -line.minX : 0, 5);
    return;
  }
  if (align === 'center') {
    expect(line.originX + line.minX, label).toBeCloseTo((width - inkWidth) / 2, 3);
    return;
  }
  expect(line.originX + Math.max(line.advance, line.maxX), label).toBeCloseTo(width, 3);
}

function contentWidth(template: GiftMessageTemplate): number {
  return (
    millimetresToPoints(template.pageWidthMm) -
    millimetresToPoints(template.marginLeftMm) -
    millimetresToPoints(template.marginRightMm)
  );
}

function contentHeight(template: GiftMessageTemplate): number {
  return (
    millimetresToPoints(template.pageHeightMm) -
    millimetresToPoints(template.marginTopMm) -
    millimetresToPoints(template.marginBottomMm)
  );
}

/** The advance pdfkit adds while drawing each run, in points. */
function drawnAdvance(text: string, fontSize: number): number {
  const doc = new PDFDocument({ margin: 0 });
  let width = 0;
  for (const run of drawnRuns(text)) {
    doc.font(run.file).fontSize(fontSize);
    width += doc.widthOfString(run.text);
  }
  return width;
}
