import pdfmake from 'pdfmake';
import { ensureDocumentFonts, FONT_FAMILY } from './fonts';
import { labelsFor, type DocumentLanguage } from './labels';

/** Visible on every draft. English and Greek, with the en dash from the Phase 1 plan. */
export const DRAFT_WATERMARK =
  'DRAFT – NOT A TAX INVOICE / ΠΡΟΣΧΕΔΙΟ – ΔΕΝ ΑΠΟΤΕΛΕΙ ΦΟΡΟΛΟΓΙΚΟ ΤΙΜΟΛΟΓΙΟ';

export type InvoiceDraftParty = {
  legalName: string | null;
  displayName: string;
  vatNumber: string | null;
  email?: string | null;
  addressLines: readonly string[];
};

export type InvoiceDraftLine = {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountPercent: string;
  taxRatePercent: string;
  lineNet: string;
};

export type InvoiceDraftTaxRow = {
  code: string;
  ratePercent: string;
  net: string;
  tax: string;
  gross: string;
};

export type InvoiceDraftPdfInput = {
  language: DocumentLanguage;
  documentType: 'quote' | 'invoice' | 'credit_note';
  currency: string;
  pricesIncludeTax: boolean;
  issueDate: string | null;
  dueDate: string | null;
  reference: string | null;
  notes: string | null;
  terms: string | null;
  seller: InvoiceDraftParty;
  client: InvoiceDraftParty;
  lines: readonly InvoiceDraftLine[];
  taxSummary: readonly InvoiceDraftTaxRow[];
  subtotal: string;
  discountTotal: string;
  netTotal: string;
  taxTotal: string;
  total: string;
};

/**
 * Renders a draft invoice on demand. The bytes are not stored.
 * Customer text is drawn as given, including spaces and line breaks.
 */
export async function renderInvoiceDraft(input: InvoiceDraftPdfInput): Promise<Buffer> {
  ensureDocumentFonts();
  const labels = labelsFor(input.language);
  const title =
    input.documentType === 'quote'
      ? labels.quote
      : input.documentType === 'credit_note'
        ? labels.creditNote
        : labels.invoice;
  const content: Record<string, unknown>[] = [
    { text: `${labels.draft} — ${title}`, style: 'title' },
    { text: DRAFT_WATERMARK, style: 'banner' },
    {
      columns: [partyBlock(labels.seller, input.seller), partyBlock(labels.client, input.client)],
      columnGap: 24,
      margin: [0, 12, 0, 8],
    },
    requiredMeta(labels.issueDate, input.issueDate ?? labels.notIssued),
    requiredMeta(labels.dueDate, input.dueDate ?? labels.notIssued),
    requiredMeta(labels.currency, input.currency),
  ];
  const reference = metaLine(labels.reference, input.reference);
  if (reference) {
    content.push(reference);
  }
  content.push(
    {
      text: input.pricesIncludeTax ? labels.pricesIncludeTax : labels.pricesExcludeTax,
      margin: [0, 2, 0, 10],
    },
    lineTable(labels, input),
    { text: labels.taxSummary, style: 'section', margin: [0, 14, 0, 4] },
    taxTable(labels, input.taxSummary),
    totalsBlock(labels, input),
  );
  const notes = optionalBlock(labels.notes, input.notes);
  if (notes) {
    content.push(notes);
  }
  const terms = optionalBlock(labels.terms, input.terms);
  if (terms) {
    content.push(terms);
  }
  const definition = {
    pageSize: 'A4',
    pageMargins: [40, 48, 40, 48],
    defaultStyle: { font: FONT_FAMILY, fontSize: 9 },
    watermark: {
      text: DRAFT_WATERMARK,
      font: FONT_FAMILY,
      color: '#9f1239',
      opacity: 0.28,
      bold: true,
    },
    content,
    styles: {
      title: { fontSize: 16, bold: true, margin: [0, 0, 0, 4] },
      banner: { fontSize: 8, color: '#9f1239', margin: [0, 0, 0, 4] },
      section: { fontSize: 11, bold: true },
      partyName: { bold: true, margin: [0, 2, 0, 2] },
    },
  };
  const pdf = pdfmake.createPdf(definition);
  const buffer = await pdf.getBuffer();
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
}

function partyBlock(heading: string, party: InvoiceDraftParty): Record<string, unknown> {
  const lines = [heading, party.displayName];
  if (party.legalName && party.legalName !== party.displayName) {
    lines.push(party.legalName);
  }
  if (party.vatNumber) {
    lines.push(party.vatNumber);
  }
  if (party.email) {
    lines.push(party.email);
  }
  for (const line of party.addressLines) {
    lines.push(line);
  }
  return {
    stack: lines.map((line, index) => ({
      text: line,
      style: index === 1 ? 'partyName' : undefined,
    })),
  };
}

function requiredMeta(label: string, value: string): Record<string, unknown> {
  return { text: `${label}: ${value}`, margin: [0, 0, 0, 1] };
}

function metaLine(label: string, value: string | null): Record<string, unknown> | undefined {
  if (value == null || value.length === 0) {
    return undefined;
  }
  return { text: `${label}: ${value}`, margin: [0, 0, 0, 1] };
}

function lineTable(
  labels: ReturnType<typeof labelsFor>,
  input: InvoiceDraftPdfInput,
): Record<string, unknown> {
  const header = [
    labels.description,
    labels.quantity,
    labels.unit,
    labels.unitPrice,
    labels.discount,
    labels.taxRate,
    labels.net,
  ].map((text) => ({ text, bold: true }));
  const body = input.lines.map((line) => [
    line.description,
    line.quantity,
    line.unit,
    line.unitPrice,
    line.discountPercent,
    line.taxRatePercent,
    line.lineNet,
  ]);
  return {
    table: {
      headerRows: 1,
      // Content width is 515pt. Each column also has 3pt of horizontal padding,
      // so the widths themselves sum to 473 and a long unit wraps inside its cell.
      widths: [173, 42, 52, 56, 40, 46, 64],
      body: [header, ...body],
    },
    layout: {
      hLineWidth: (rowIndex: number, node: { table: { body: unknown[] } }) =>
        rowIndex === 0 || rowIndex === 1 || rowIndex === node.table.body.length ? 0.5 : 0.3,
      vLineWidth: () => 0,
      hLineColor: () => '#d6d3d1',
      paddingLeft: () => 3,
      paddingRight: () => 3,
      paddingTop: () => 3,
      paddingBottom: () => 3,
    },
  };
}

function taxTable(
  labels: ReturnType<typeof labelsFor>,
  rows: readonly InvoiceDraftTaxRow[],
): Record<string, unknown> {
  const header = [labels.taxCode, labels.taxRate, labels.net, labels.tax, labels.gross].map(
    (text) => ({
      text,
      bold: true,
    }),
  );
  const body = rows.map((row) => [row.code, row.ratePercent, row.net, row.tax, row.gross]);
  return {
    table: {
      headerRows: 1,
      widths: ['*', 'auto', 'auto', 'auto', 'auto'],
      body: [header, ...body],
    },
    layout: 'lightHorizontalLines',
  };
}

function totalsBlock(
  labels: ReturnType<typeof labelsFor>,
  input: InvoiceDraftPdfInput,
): Record<string, unknown> {
  const rows = [
    [labels.subtotal, input.subtotal],
    [labels.discountTotal, input.discountTotal],
    [labels.netTotal, input.netTotal],
    [labels.taxTotal, input.taxTotal],
    [labels.total, input.total],
  ];
  return {
    margin: [0, 12, 0, 0],
    table: {
      widths: ['*', 'auto'],
      body: rows.map(([label, value], index) => [
        { text: label ?? '', bold: index === rows.length - 1, alignment: 'right' },
        {
          text: `${value ?? ''} ${input.currency}`,
          bold: index === rows.length - 1,
          alignment: 'right',
        },
      ]),
    },
    layout: 'noBorders',
  };
}

function optionalBlock(label: string, value: string | null): Record<string, unknown> | undefined {
  if (value == null || value.length === 0) {
    return undefined;
  }
  return {
    margin: [0, 12, 0, 0],
    stack: [
      { text: label, style: 'section' },
      { text: value, margin: [0, 2, 0, 0] },
    ],
  };
}
