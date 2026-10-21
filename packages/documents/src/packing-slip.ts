import pdfmake from 'pdfmake';
import { ensureDocumentFonts, FONT_FAMILY } from './fonts';
import { packingLabels, type DocumentLanguage } from './labels';

export type PackingSlipItem = {
  sku: string | null;
  title: string;
  variantTitle: string | null;
  quantity: string;
};

/** Operational slip. Prices are not part of the input, so they cannot be drawn. */
export type PackingSlipOrder = {
  orderNumber: string;
  storeName: string;
  deliveryMethod: string;
  recipientName: string;
  recipientLines: readonly string[];
  items: readonly PackingSlipItem[];
  hasGiftMessage: boolean;
};

export type PackingSlipCompany = {
  legalName: string;
  tradingName: string;
};

/**
 * A4 packing slip: order number, store, recipient, delivery method, items with
 * quantities, and whether a gift message is present. No prices.
 */
export async function renderPackingSlip(
  order: PackingSlipOrder,
  company: PackingSlipCompany,
  lang: DocumentLanguage,
): Promise<Buffer> {
  ensureDocumentFonts();
  const labels = packingLabels(lang);
  const delivery = labels.deliveryMethods[order.deliveryMethod] ?? order.deliveryMethod;
  const recipient = [order.recipientName, ...order.recipientLines].filter((line) => line.length > 0);
  const header = [labels.sku, labels.item, labels.variant, labels.quantity].map((text) => ({
    text,
    bold: true,
  }));
  const body = order.items.map((item) => [
    item.sku ?? '',
    item.title,
    item.variantTitle ?? '',
    item.quantity,
  ]);
  const definition = {
    pageSize: 'A4',
    pageMargins: [40, 48, 40, 48],
    defaultStyle: { font: FONT_FAMILY, fontSize: 10 },
    content: [
      { text: labels.title, style: 'title' },
      { text: company.tradingName, style: 'party' },
      { text: company.legalName, margin: [0, 0, 0, 10] },
      meta(labels.orderNumber, order.orderNumber),
      meta(labels.store, order.storeName),
      meta(labels.delivery, delivery),
      { text: labels.recipient, style: 'section', margin: [0, 12, 0, 4] },
      {
        stack: (recipient.length > 0 ? recipient : ['']).map((line) => ({ text: line })),
        margin: [0, 0, 0, 8],
      },
      { text: labels.items, style: 'section', margin: [0, 4, 0, 4] },
      {
        table: {
          headerRows: 1,
          widths: [80, 220, 120, 50],
          body: [header, ...body],
        },
        layout: 'lightHorizontalLines',
      },
      {
        text: `${labels.giftMessage}: ${order.hasGiftMessage ? labels.giftYes : labels.giftNo}`,
        margin: [0, 16, 0, 0],
        bold: true,
      },
    ],
    styles: {
      title: { fontSize: 16, bold: true, margin: [0, 0, 0, 6] },
      party: { fontSize: 12, bold: true },
      section: { fontSize: 12, bold: true },
    },
  };
  const pdf = pdfmake.createPdf(definition);
  const buffer = await pdf.getBuffer();
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
}

function meta(label: string, value: string): Record<string, unknown> {
  return { text: `${label}: ${value}`, margin: [0, 0, 0, 2] };
}
