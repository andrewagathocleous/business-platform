import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { layoutGiftMessage, renderGiftMessage, type GiftMessageTemplate } from './gift-message';
import { renderPackingSlip } from './packing-slip';
import { fontSizes, layoutLines, measureText, textWidth } from './text-layout';
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
    expect(textWidth(`${prefix}\r`, 16)).toBeGreaterThan(width);
    const maxWidth = (width + textWidth(`${prefix}\r`, 16)) / 2;
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

  it('reports the emoji fixture glyph', async () => {
    const rendered = await renderGiftMessage(giftMessage('order-1003-emoji-gift.json'), CARD);
    expect(rendered.unsupportedChars).toEqual(['🎁']);
  });

  it('does not trim spaces or line breaks before measuring', async () => {
    const text = '  hello  \n\n  ';
    const rendered = await renderGiftMessage(text, CARD);
    expect(rendered.fits).toBe(true);
    expect(rendered.unsupportedChars).toEqual([]);
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

function inflatedPdf(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  let output = raw;
  let from = 0;
  while (from < raw.length) {
    const start = raw.indexOf('stream', from);
    if (start === -1) {
      break;
    }
    let dataStart = start + 'stream'.length;
    if (raw[dataStart] === '\r' && raw[dataStart + 1] === '\n') {
      dataStart += 2;
    } else if (raw[dataStart] === '\n') {
      dataStart += 1;
    }
    const end = raw.indexOf('endstream', dataStart);
    if (end === -1) {
      break;
    }
    let dataEnd = end;
    if (raw[dataEnd - 1] === '\n') {
      dataEnd -= raw[dataEnd - 2] === '\r' ? 2 : 1;
    }
    try {
      output += inflateSync(pdf.subarray(dataStart, dataEnd)).toString('latin1');
    } catch {
      // Image and font streams are not Flate text.
    }
    from = end + 'endstream'.length;
  }
  return output;
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
      found.push(parsed.value);
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

function decodeUtf16Hex(hex: string): string {
  const bytes = hex.replace(/\s+/g, '');
  const start = bytes.startsWith('FEFF') || bytes.startsWith('feff') ? 4 : 0;
  let value = '';
  for (let index = start; index + 3 < bytes.length; index += 4) {
    value += String.fromCharCode(Number.parseInt(bytes.slice(index, index + 4), 16));
  }
  return value;
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
