export type AssignedTo = { userId: string; displayName: string };

export type OrderCustomer = {
  displayName: string | null;
  email: string | null;
  phone: string | null;
};

export type OrderSummary = {
  id: string;
  storeId: string;
  externalNumber: string;
  sourceCreatedAt: string | null;
  paymentStatus: string;
  fulfilmentStatus: string;
  integrationStatus: string;
  reviewReason: string | null;
  attentionReasons: string[];
  deliveryMethod: string;
  currency: string;
  total: string;
  assignedToUserId: string | null;
  assignedTo: AssignedTo | null;
  version: number;
  customer: OrderCustomer | null;
};

export type OrderLine = {
  id: string;
  sku: string | null;
  title: string;
  variantTitle: string | null;
  quantity: string;
  unitPrice: string;
  total: string;
};

export type OrderNote = {
  id: string;
  body: string;
  authorUserId: string;
  authorDisplayName: string | null;
  createdAt: string;
};

export type TransitionDecision = {
  from: string;
  to: string;
  allowed: boolean;
  error?: string;
};

export type PrintSlot = {
  id: string;
  documentType: string;
  status: string;
  isReprint: boolean;
  createdAt: string;
  provider: string;
  label: string;
};

export type PrintJobs = {
  packing_slip: PrintSlot | null;
  gift_message: PrintSlot | null;
};

export type OrderCan = {
  edit: boolean;
  claim: boolean;
  assign: boolean;
  cancel: boolean;
  downloadDocuments: boolean;
  printSubmit: boolean;
  printReprint: boolean;
  printConfirm: boolean;
};

export type FirstPrintAvailable = {
  invoice: boolean;
  packing_slip: boolean;
  gift_message: boolean;
  shipping_label: boolean;
};

export type OrderDetail = Omit<OrderSummary, 'customer'> & {
  customer: Record<string, unknown> | null;
  recipient: Record<string, unknown> | null;
  billingAddress: Record<string, unknown> | null;
  giftMessage: string | null;
  customerNote: string | null;
  subtotal: string;
  shippingTotal: string;
  taxTotal: string;
  lines: OrderLine[];
  notes: OrderNote[];
  allowedTransitions: TransitionDecision[];
  printJobs: PrintJobs;
  firstPrintAvailable: FirstPrintAvailable;
  can: OrderCan;
};

export type OrderListResponse = {
  orders: OrderSummary[];
  page: number;
  pageSize: number;
  total: number;
};

export type StoreFilter = { id: string; name: string; platform: string };

export type ActivityEvent = {
  id: string;
  occurredAt: string;
  actorLabel: string | null;
  actorType: string;
  action: string;
  outcome: string;
  details?: unknown;
};
