import pdfmake from 'pdfmake';
import { ensureDocumentFonts, FONT_FAMILY } from './fonts';
import { labelsFor, type DocumentLabels, type DocumentLanguage } from './labels';

/**
 * The issued template's version. It is stored on the document, so a later template change
 * never claims to be the one that produced an issued PDF.
 */
export const ISSUED_RENDER_VERSION = 1;

export type IssuedInvoiceParty = {
  name: string;
  /** A second name (trading or display name), printed under the first when it differs. */
  otherName: string | null;
  vatNumber: string | null;
  registrationNumber: string | null;
  addressLines: readonly string[];
};

export type IssuedInvoiceLine = {
  description: string;
  quantity: string;
  unit: string;
  /** VAT-exclusive, already formatted for printing. */
  unitPrice: string;
  discountPercent: string;
  taxRatePercent: string;
  lineNet: string;
};

export type IssuedInvoiceTaxRow = {
  code: string;
  name: string;
  ratePercent: string;
  net: string;
  tax: string;
  gross: string;
};

export type IssuedInvoiceBank = {
  bankName: string;
  accountHolder: string;
  iban: string;
  bic: string | null;
};

export type IssuedInvoicePdfInput = {
  language: DocumentLanguage;
  documentType: 'invoice' | 'credit_note';
  number: string;
  issueDate: string;
  supplyDate: string;
  dueDate: string | null;
  currency: string;
  pricesIncludeTax: boolean;
  reference: string | null;
  notes: string | null;
  terms: string | null;
  seller: IssuedInvoiceParty;
  buyer: IssuedInvoiceParty;
  bank: IssuedInvoiceBank | null;
  lines: readonly IssuedInvoiceLine[];
  taxSummary: readonly IssuedInvoiceTaxRow[];
  /** Legal notes of the exempt, zero-rated and reverse-charge codes, printed as given. */
  vatNotes: readonly string[];
  subtotal: string;
  discountTotal: string;
  netTotal: string;
  taxTotal: string;
  total: string;
};

/**
 * Renders an issued invoice from its frozen snapshot. The caller stores the bytes once;
 * the document is never rendered again. Customer text is drawn as given.
 */
export async function renderIssuedInvoice(input: IssuedInvoicePdfInput): Promise<Buffer> {
  ensureDocumentFonts();
  const labels = labelsFor(input.language);
  const title = input.documentType === 'credit_note' ? labels.creditNote : labels.invoice;
  const content: Record<string, unknown>[] = [
    { text: `${title} ${input.number}`, style: 'title' },
    {
      columns: [
        partyBlock(labels.seller, labels, input.seller),
        partyBlock(labels.client, labels, input.buyer),
      ],
      columnGap: 24,
      margin: [0, 8, 0, 8],
    },
    meta(labels.number, input.number),
    meta(labels.issueDate, input.issueDate),
    meta(labels.supplyDate, input.supplyDate),
  ];
  if (input.dueDate) {
    content.push(meta(labels.dueDate, input.dueDate));
  }
  content.push(meta(labels.currency, input.currency));
  if (input.reference) {
    content.push(meta(labels.reference, input.reference));
  }
  content.push(
    {
      text: input.pricesIncludeTax ? labels.pricesIncludeTax : labels.pricesExcludeTax,
      margin: [0, 2, 0, 10],
    },
    lineTable(labels, input.lines),
    { text: labels.taxSummary, style: 'section', margin: [0, 14, 0, 4] },
    taxTable(labels, input.taxSummary),
  );
  if (input.vatNotes.length > 0) {
    content.push({
      margin: [0, 8, 0, 0],
      stack: [
        { text: labels.vatNotes, style: 'section' },
        ...input.vatNotes.map((note) => ({ text: note, margin: [0, 2, 0, 0] })),
      ],
    });
  }
  content.push(totalsBlock(labels, input));
  if (input.bank) {
    content.push({
      margin: [0, 12, 0, 0],
      stack: [
        { text: labels.bankDetails, style: 'section' },
        { text: `${labels.bank}: ${input.bank.bankName}`, margin: [0, 2, 0, 0] },
        { text: `${labels.accountHolder}: ${input.bank.accountHolder}` },
        { text: `IBAN: ${groupedIban(input.bank.iban)}` },
        ...(input.bank.bic ? [{ text: `BIC: ${input.bank.bic}` }] : []),
      ],
    });
  }
  for (const [label, value] of [
    [labels.terms, input.terms],
    [labels.notes, input.notes],
  ] as const) {
    if (value) {
      content.push({
        margin: [0, 12, 0, 0],
        stack: [
          { text: label, style: 'section' },
          { text: value, margin: [0, 2, 0, 0] },
        ],
      });
    }
  }
  const definition = {
    pageSize: 'A4',
    pageMargins: [40, 48, 40, 48],
    defaultStyle: { font: FONT_FAMILY, fontSize: 9 },
    content,
    styles: {
      title: { fontSize: 16, bold: true, margin: [0, 0, 0, 4] },
      section: { fontSize: 11, bold: true },
      partyName: { bold: true, margin: [0, 2, 0, 2] },
    },
  };
  const pdf = pdfmake.createPdf(definition);
  const buffer = await pdf.getBuffer();
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
}

function partyBlock(
  heading: string,
  labels: DocumentLabels,
  party: IssuedInvoiceParty,
): Record<string, unknown> {
  const lines = [heading, party.name];
  if (party.otherName && party.otherName !== party.name) {
    lines.push(party.otherName);
  }
  for (const line of party.addressLines) {
    lines.push(line);
  }
  if (party.vatNumber) {
    lines.push(`${labels.vatNumber}: ${party.vatNumber}`);
  }
  if (party.registrationNumber) {
    lines.push(`${labels.registrationNumber}: ${party.registrationNumber}`);
  }
  return {
    stack: lines.map((line, index) => ({
      text: line,
      style: index === 1 ? 'partyName' : undefined,
    })),
  };
}

function meta(label: string, value: string): Record<string, unknown> {
  return { text: `${label}: ${value}`, margin: [0, 0, 0, 1] };
}

function lineTable(
  labels: DocumentLabels,
  lines: readonly IssuedInvoiceLine[],
): Record<string, unknown> {
  const header = [
    labels.description,
    labels.quantity,
    labels.unit,
    labels.unitPriceExclVat,
    labels.discount,
    labels.taxRate,
    labels.net,
  ].map((text) => ({ text, bold: true }));
  const body = lines.map((line) => [
    line.description,
    line.quantity,
    line.unit,
    line.unitPrice,
    `${line.discountPercent}%`,
    `${line.taxRatePercent}%`,
    line.lineNet,
  ]);
  return {
    table: {
      headerRows: 1,
      // Same widths as the draft: 473pt of columns plus 3pt padding each side.
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
  labels: DocumentLabels,
  rows: readonly IssuedInvoiceTaxRow[],
): Record<string, unknown> {
  const header = [labels.taxCode, labels.taxRate, labels.net, labels.tax, labels.gross].map(
    (text) => ({ text, bold: true }),
  );
  const body = rows.map((row) => [
    `${row.code} — ${row.name}`,
    `${row.ratePercent}%`,
    row.net,
    row.tax,
    row.gross,
  ]);
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
  labels: DocumentLabels,
  input: IssuedInvoicePdfInput,
): Record<string, unknown> {
  const rows = [
    [labels.subtotal, input.subtotal],
    [labels.discountTotal, input.discountTotal],
    [labels.netTotalExclVat, input.netTotal],
    [labels.totalVat, input.taxTotal],
    [labels.totalPayable, input.total],
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

/** CY17 0020 0128 …, the way an IBAN is written on paper. */
function groupedIban(iban: string): string {
  return iban.replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ');
}
