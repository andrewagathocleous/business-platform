import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  layoutGiftMessage,
  renderGiftMessage,
  renderPackingSlip,
  type GiftMessageTemplate,
} from '@bp/documents';

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
const WIDTH_PT = (148 * 72) / 25.4;
const HEIGHT_PT = (105 * 72) / 25.4;

describe('gift message and packing slip PDFs', () => {
  it('draws the gift message at 148 × 105 mm and keeps each line’s visible glyphs', async () => {
    const rendered = await renderGiftMessage(GREEK, CARD);
    const laid = layoutGiftMessage(GREEK, CARD);
    const page = await readPdf(rendered.pdf);
    expect(page.pages).toBe(1);
    expect(Math.abs(page.width - WIDTH_PT)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(page.height - HEIGHT_PT)).toBeLessThanOrEqual(0.5);
    expectVisibleLines(GREEK, laid.lineBoxPt, page);
    expect(page.fontSize).toBeGreaterThan(15);
    expect(page.fontSize).toBeLessThan(17);
    expectNoCmapWarnings(page.warnings);
    const poppler = pdftotext(rendered.pdf);
    if (!poppler.skipped) {
      expect(poppler.stderr).not.toMatch(/tounicode|bfrange|cmap/i);
    }
  });

  it('draws the layout lines, including a wrap at the card width', async () => {
    const text = `${'καλημέρα '.repeat(12)}end`;
    const laid = layoutGiftMessage(text, CARD);
    expect(laid.lines.length).toBeGreaterThan(1);
    expect(laid.lines.join('')).toBe(text);
    const rendered = await renderGiftMessage(text, CARD);
    const page = await readPdf(rendered.pdf);
    expect(page.lines.map((line) => line.text.replace(/\s+/gu, ''))).toEqual(
      laid.lines.map((line) => line.replace(/\s+/gu, '')).filter((line) => line.length > 0),
    );
    expectNoCmapWarnings(page.warnings);
    const poppler = pdftotext(rendered.pdf);
    if (!poppler.skipped) {
      expect(poppler.stderr).not.toMatch(/tounicode|bfrange|cmap/i);
    }
  });

  it('keeps a blank line as a vertical gap and the visible characters of each line', async () => {
    const text = 'hello  \n\n  there  ';
    const rendered = await renderGiftMessage(text, CARD);
    const laid = layoutGiftMessage(text, CARD);
    const page = await readPdf(rendered.pdf);
    expect(page.pages).toBe(1);
    expect(laid.lines).toEqual(text.split('\n'));
    expectVisibleLines(text, laid.lineBoxPt, page);
    expectNoCmapWarnings(page.warnings);
  });

  it('shrinks a 600-character message or flags fits=false', async () => {
    const message = 'καλημέρα '.repeat(67).slice(0, 600);
    expect(message).toHaveLength(600);
    const rendered = await renderGiftMessage(message, CARD);
    const page = await readPdf(rendered.pdf);
    if (rendered.fits) {
      expect(page.pages).toBe(1);
      expect(page.fontSize).toBeLessThan(15.75);
      expect(page.fontSize).toBeGreaterThanOrEqual(9.5);
    } else {
      expect(rendered.fits).toBe(false);
      expect(page.fontSize).toBeLessThanOrEqual(10.5);
    }
  });

  it('draws the emoji fixture', async () => {
    const text = 'Many happy returns 🎁';
    const rendered = await renderGiftMessage(text, CARD);
    expect(rendered.fits).toBe(true);
    expect(rendered.unsupportedChars).toEqual([]);
    expect(rendered.omittedCount).toBe(0);
  });

  it('shows the order, recipient, items and gift flag, and no prices', async () => {
    const pdf = await renderPackingSlip(
      {
        orderNumber: '#1001',
        storeName: 'Nutbox Demo Shopify',
        deliveryMethod: 'courier_cy',
        recipientName: 'Μαρία Παπαδοπούλου',
        recipientLines: ['1 Demo Street', 'Διαμέρισμα 2', '1000 Λευκωσία'],
        items: [
          { sku: 'NUTS', title: 'Mixed nuts', variantTitle: '250 g', quantity: '2.0000' },
          { sku: 'GIFTBOX', title: 'Gift box', variantTitle: null, quantity: '1.0000' },
          { sku: 'WRAP', title: 'Gift wrapping', variantTitle: null, quantity: '1.0000' },
        ],
        hasGiftMessage: true,
      },
      { legalName: 'Demo Company A Ltd (fictional)', tradingName: 'Nutbox (demo data)' },
      'en',
    );
    const page = await readPdf(pdf);
    expect(page.width).toBeGreaterThan(590);
    expect(page.width).toBeLessThan(600);
    const flat = page.text.replace(/\s+/g, '');
    expect(flat).toContain('#1001');
    expect(flat).toContain('ΜαρίαΠαπαδοπούλου');
    expect(flat).toContain('Mixednuts');
    expect(flat).toContain('Giftbox');
    expect(flat).toContain('Giftwrapping');
    expect(flat).toContain('NutboxDemoShopify');
    expect(flat).toContain('Giftmessage');
    expect(flat).toContain('Yes');
    for (const price of [
      '17.00',
      '18.00',
      '8.50',
      '8.5000',
      '3.00',
      '38.00',
      '5.00',
      '43.00',
      'EUR',
    ]) {
      expect(page.text).not.toContain(price);
    }
  });
});

type PdfItem = { str?: string; hasEOL?: boolean; transform?: number[] };

type PdfRead = {
  text: string;
  width: number;
  height: number;
  pages: number;
  fontSize: number;
  lines: { text: string; y: number }[];
  warnings: string[];
};

type PdfDoc = {
  numPages: number;
  getPage: (page: number) => Promise<{
    getViewport: (input: { scale: number }) => { width: number; height: number };
    getTextContent: () => Promise<{ items: PdfItem[] }>;
  }>;
};

async function readPdf(pdf: Buffer): Promise<PdfRead> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(
      args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '),
    );
  };
  try {
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
      VerbosityLevel?: { INFOS?: number; WARNINGS?: number };
      getDocument: (src: { data: Uint8Array; isEvalSupported?: boolean; verbosity?: number }) => {
        promise: Promise<PdfDoc>;
      };
    };
    const verbosity = pdfjs.VerbosityLevel?.INFOS ?? pdfjs.VerbosityLevel?.WARNINGS ?? 5;
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(pdf),
      isEvalSupported: false,
      verbosity,
    }).promise;
    const parts: string[] = [];
    const positioned: { str: string; x: number; y: number }[] = [];
    let width = 0;
    let height = 0;
    let fontSize = 0;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      if (pageNumber === 1) {
        width = viewport.width;
        height = viewport.height;
      }
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (typeof item.str === 'string') {
          parts.push(item.str);
          const scale = item.transform?.[3];
          const x = item.transform?.[4];
          const y = item.transform?.[5];
          if (typeof scale === 'number' && scale > fontSize) {
            fontSize = scale;
          }
          if (typeof x === 'number' && typeof y === 'number') {
            positioned.push({ str: item.str, x, y });
          }
        }
        if (item.hasEOL) {
          parts.push('\n');
        }
      }
    }
    return {
      text: stripTrailingNewline(parts.join('')),
      width,
      height,
      pages: doc.numPages,
      fontSize,
      lines: groupLines(positioned),
      warnings,
    };
  } finally {
    console.warn = original;
  }
}

function groupLines(
  items: readonly { str: string; x: number; y: number }[],
): { text: string; y: number }[] {
  const groups: { y: number; items: { str: string; x: number }[] }[] = [];
  for (const item of items) {
    if (item.str.length === 0) {
      continue;
    }
    const group = groups.find((candidate) => Math.abs(candidate.y - item.y) <= 1);
    if (group) {
      group.items.push(item);
      continue;
    }
    groups.push({ y: item.y, items: [{ str: item.str, x: item.x }] });
  }
  groups.sort((left, right) => right.y - left.y);
  return groups.map((group) => ({
    y: group.y,
    text: [...group.items]
      .sort((left, right) => left.x - right.x)
      .map((item) => item.str)
      .join(''),
  }));
}

function expectVisibleLines(stored: string, lineBox: number, page: PdfRead): void {
  const sources = stored.split('\n');
  const nonempty = sources
    .map((line, index) => ({ line, index }))
    .filter((item) => item.line.replace(/\s+/gu, '').length > 0);
  expect(page.lines.map((line) => line.text.replace(/\s+/gu, ''))).toEqual(
    nonempty.map((item) => item.line.replace(/\s+/gu, '')),
  );
  for (let visual = 0; visual < page.lines.length - 1; visual += 1) {
    const from = nonempty[visual]?.index;
    const to = nonempty[visual + 1]?.index;
    if (from === undefined || to === undefined) {
      continue;
    }
    const blanks = to - from - 1;
    const above = page.lines[visual];
    const below = page.lines[visual + 1];
    if (blanks <= 0 || !above || !below) {
      continue;
    }
    const gap = above.y - below.y;
    expect(gap).toBeGreaterThanOrEqual(lineBox * (blanks + 0.5));
  }
}

function expectNoCmapWarnings(warnings: readonly string[]): void {
  expect(warnings.filter((warning) => /tounicode|cmap|bfrange/i.test(warning))).toEqual([]);
}

function pdftotext(pdf: Buffer): { skipped: boolean; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gift-pdf-'));
  const file = join(dir, 'card.pdf');
  try {
    writeFileSync(file, pdf);
    const result = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
    if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
      return { skipped: true, stderr: '' };
    }
    return { skipped: false, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stripTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}
