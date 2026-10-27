import { describe, expect, it } from 'vitest';
import { renderInvoiceDraft } from '@bp/documents';

const WATERMARK = 'DRAFT – NOT A TAX INVOICE / ΠΡΟΣΧΕΔΙΟ – ΔΕΝ ΑΠΟΤΕΛΕΙ ΦΟΡΟΛΟΓΙΚΟ ΤΙΜΟΛΟΓΙΟ';

describe('invoice draft PDF', () => {
  it('embeds the client name, a Greek client name and the watermark', async () => {
    const english = await renderInvoiceDraft(sample('en', 'Demo Gifts Ltd (fictional)'));
    const greek = await renderInvoiceDraft(sample('el', 'Μαρία Παπαδοπούλου'));
    expect(english.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    const englishText = await extractPdfText(english);
    const greekText = await extractPdfText(greek);
    expect(flatten(englishText)).toContain(flatten('Demo Gifts Ltd (fictional)'));
    expect(flatten(englishText)).toContain(flatten(WATERMARK));
    expect(flatten(englishText)).toContain('Billto');
    expect(flatten(greekText)).toContain(flatten('Μαρία Παπαδοπούλου'));
    expect(flatten(greekText)).toContain(flatten(WATERMARK));
    expect(flatten(greekText)).toContain('Πελάτης');
  });

  it('keeps line columns on the page when the unit is long', async () => {
    const pdf = await renderInvoiceDraft({
      ...sample('en', 'Demo Gifts Ltd (fictional)'),
      lines: [
        {
          description: 'Mixed nuts (demo)',
          quantity: '1.0000',
          unit: 'W'.repeat(40),
          unitPrice: '10.0000',
          discountPercent: '0.00',
          taxRatePercent: '0.0000',
          lineNet: '91.91',
        },
      ],
    });
    const page = await firstPage(pdf);
    const net = page.items.find((item) => item.str?.includes('91.91'));
    expect(net?.transform?.[4]).toEqual(expect.any(Number));
    const x = net?.transform?.[4] ?? 0;
    const width = net?.width ?? 0;
    expect(x).toBeGreaterThanOrEqual(40);
    expect(x + width).toBeLessThanOrEqual(page.width - 40 + 2);
    const text = page.items.map((item) => item.str ?? '').join('');
    expect((text.match(/W/g) ?? []).length).toBeGreaterThanOrEqual(40);
  });
});

function sample(language: 'en' | 'el', clientName: string) {
  return {
    language,
    documentType: 'invoice' as const,
    currency: 'EUR',
    pricesIncludeTax: false,
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    reference: null,
    notes: 'σημείωση\nδεύτερη γραμμή',
    terms: null,
    subtotal: '20.00',
    discountTotal: '3.00',
    netTotal: '17.00',
    taxTotal: '3.23',
    total: '20.23',
    seller: {
      displayName: 'Nutbox (demo data)',
      legalName: 'Demo Company A Ltd (fictional)',
      vatNumber: null,
      addressLines: ['1 Demo Street', 'Nicosia', 'CY'],
    },
    client: {
      displayName: clientName,
      legalName: clientName,
      vatNumber: null,
      email: 'desk@example.test',
      addressLines: ['2 Demo Warehouse'],
    },
    lines: [
      {
        description: 'Mixed nuts (demo)',
        quantity: '2.0000',
        unit: 'kg',
        unitPrice: '10.0000',
        discountPercent: '15.00',
        taxRatePercent: '19.0000',
        lineNet: '17.00',
      },
    ],
    taxSummary: [
      { code: 'STD19', ratePercent: '19.0000', net: '17.00', tax: '3.23', gross: '20.23' },
    ],
  };
}

async function extractPdfText(pdf: Buffer): Promise<string> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
    getDocument: (src: { data: Uint8Array; isEvalSupported?: boolean }) => {
      promise: Promise<PdfDoc>;
    };
  };
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), isEvalSupported: false })
    .promise;
  const parts: string[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (typeof item.str === 'string') {
        parts.push(item.str);
      }
    }
  }
  return parts.join('');
}

type PdfItem = { str?: string; transform?: number[]; width?: number };

type PdfDoc = {
  numPages: number;
  getPage: (page: number) => Promise<{
    getViewport: (input: { scale: number }) => { width: number };
    getTextContent: () => Promise<{ items: PdfItem[] }>;
  }>;
};

async function firstPage(pdf: Buffer): Promise<{ width: number; items: PdfItem[] }> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
    getDocument: (src: { data: Uint8Array; isEvalSupported?: boolean }) => {
      promise: Promise<PdfDoc>;
    };
  };
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  return { width: page.getViewport({ scale: 1 }).width, items: content.items };
}

function flatten(value: string): string {
  return value.replace(/\s+/g, '');
}
