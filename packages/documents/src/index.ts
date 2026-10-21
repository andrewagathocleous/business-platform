export const DOCUMENTS_PACKAGE = '@bp/documents' as const;

export { FONT_FAMILY } from './fonts';
export { layoutGiftMessage, renderGiftMessage } from './gift-message';
export type {
  GiftAlign,
  GiftMessageLayout,
  GiftMessagePdf,
  GiftMessageTemplate,
  GiftVerticalAlign,
} from './gift-message';
export { unsupportedGlyphs } from './glyphs';
export { DRAFT_WATERMARK, renderInvoiceDraft } from './invoice-draft';
export type {
  InvoiceDraftLine,
  InvoiceDraftParty,
  InvoiceDraftPdfInput,
  InvoiceDraftTaxRow,
} from './invoice-draft';
export { labelsFor, packingLabels } from './labels';
export type { DocumentLabels, DocumentLanguage, PackingLabels } from './labels';
export { renderPackingSlip } from './packing-slip';
export type { PackingSlipCompany, PackingSlipItem, PackingSlipOrder } from './packing-slip';
