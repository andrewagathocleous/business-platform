import type { AllocationView, PaymentState } from '../payments/payment-view';
import type { CreditNoteLink } from './credit-panel';
import type { LineKind } from './invoice-lines';
import type { DeliveryView, InvoicePrintJob } from './issued-actions';

/** One document as `GET …/invoices/:id` returns it: an invoice, a quote or a credit note. */
export type InvoiceView = {
  id: string;
  documentType: string;
  status: string;
  clientId: string;
  clientDisplayName: string;
  currency: string;
  language: string;
  pricesIncludeTax: boolean;
  issueDate: string | null;
  dueDate: string | null;
  supplyDate?: string | null;
  deliveryDeadline?: string | null;
  number?: string | null;
  lastDeliveredOn?: string | null;
  deliveries?: DeliveryView[];
  printJobs?: InvoicePrintJob[];
  firstPrintJobId?: string | null;
  openBalance?: string | null;
  paymentState?: PaymentState | null;
  unappliedAmount?: string | null;
  allocations?: AllocationView[];
  reference: string | null;
  notes: string | null;
  terms: string | null;
  version: number;
  subtotal?: string;
  discountTotal?: string;
  netTotal?: string;
  taxTotal?: string;
  total?: string;
  taxSummary?: { taxCode: string; net: string; tax: string; gross: string }[];
  /** A credit note: the invoice it credits, and why. */
  creditedInvoice?: { id: string; number: string | null; issueDate: string | null } | null;
  creditReason?: string | null;
  /** An invoice: its credit notes, drafts included. */
  creditNotes?: CreditNoteLink[];
  /** An invoice made from a quote, or a quote's invoice. */
  sourceQuoteId?: string | null;
  convertedInvoiceId?: string | null;
  lines: {
    id?: string;
    position: number;
    kind: LineKind;
    productId: string | null;
    description: string;
    quantity: string;
    unit: string;
    unitPrice: string;
    discountPercent: string;
    taxCodeId: string;
    taxCode?: string;
    lineSubtotal?: string;
    lineDiscount?: string;
    lineNet?: string;
    lineGross?: string;
    /** On an issued invoice: what issued credit notes have credited. */
    creditedQuantity?: string;
  }[];
};
