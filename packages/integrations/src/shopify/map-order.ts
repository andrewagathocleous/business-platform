import { resolve } from 'node:path';
import {
  DELIVERY_METHODS,
  PAYMENT_STATUSES,
  parseAmount,
  type DeliveryMethod,
  type PaymentStatus,
} from '@bp/domain';

/**
 * Shopify Admin GraphQL `Order` shape.
 * API version: unverified; check in Phase 2.
 *
 * displayFinancialStatus → payment_status
 * | PENDING              | pending            |
 * | AUTHORIZED           | authorized         |
 * | PARTIALLY_PAID       | partially_paid     |
 * | PAID                 | paid               |
 * | PARTIALLY_REFUNDED   | partially_refunded |
 * | REFUNDED             | refunded           |
 * | VOIDED               | voided             |
 * | anything else        | unknown            |
 */
export const SHOPIFY_ORDER_API_VERSION = 'unverified; check in Phase 2';

export const FINANCIAL_STATUS_MAP: Readonly<Record<string, PaymentStatus>> = {
  PENDING: 'pending',
  AUTHORIZED: 'authorized',
  PARTIALLY_PAID: 'partially_paid',
  PAID: 'paid',
  PARTIALLY_REFUNDED: 'partially_refunded',
  REFUNDED: 'refunded',
  VOIDED: 'voided',
};

const DELIVERY = new Set<string>(DELIVERY_METHODS);
const PAYMENT = new Set<string>(PAYMENT_STATUSES);

export type StoreOrderConfig = {
  giftMessageKeys: readonly string[];
  deliveryMethodMap: Readonly<Record<string, string>>;
};

export type MappedOrderLine = {
  externalLineId: string | null;
  sku: string | null;
  title: string;
  variantTitle: string | null;
  quantity: string;
  unitPrice: string;
  total: string;
};

export type MappedShopifyOrder = {
  externalId: string;
  externalNumber: string;
  sourceCreatedAt: Date;
  sourceUpdatedAt: Date;
  paymentStatus: PaymentStatus;
  sourceStatus: {
    displayFulfillmentStatus: string | null;
    cancelledAt: string | null;
  };
  customer: {
    id: string | null;
    displayName: string | null;
    email: string | null;
    phone: string | null;
  };
  recipient: Record<string, unknown> | null;
  billingAddress: Record<string, unknown> | null;
  giftMessage: string | null;
  customerNote: string | null;
  deliveryMethod: DeliveryMethod;
  shippingLine: Record<string, unknown> | null;
  currency: string;
  lines: MappedOrderLine[];
  subtotal: string;
  shippingTotal: string;
  taxTotal: string;
  total: string;
};

export type MappedOrder = MappedShopifyOrder;

export class ShopifyMapError extends Error {
  override readonly name = 'ShopifyMapError';
}

/** Fixtures live next to the package, outside `src`, so the build does not emit them. */
export function shopifyFixturesDirectory(): string {
  return resolve(__dirname, '../../shopify/fixtures');
}

/** Reads the identity the inbox stores before a full map. Missing fields are a permanent map error. */
export function readShopifyEventIdentity(payload: unknown): {
  externalId: string;
  sourceUpdatedAt: Date;
} {
  const order = record(payload, 'payload');
  return {
    externalId: requiredString(order, 'id'),
    sourceUpdatedAt: timestamp(order.updatedAt, 'updatedAt'),
  };
}

export function mapShopifyOrder(payload: unknown, store: StoreOrderConfig): MappedShopifyOrder {
  const order = record(payload, 'payload');
  const externalId = requiredString(order, 'id');
  const externalNumber = requiredString(order, 'name');
  const sourceCreatedAt = timestamp(order.createdAt, 'createdAt');
  const sourceUpdatedAt = timestamp(order.updatedAt, 'updatedAt');
  const financial = optionalString(order.displayFinancialStatus, 'displayFinancialStatus');
  const paymentStatus = financial ? (FINANCIAL_STATUS_MAP[financial] ?? 'unknown') : 'unknown';
  if (!PAYMENT.has(paymentStatus)) {
    throw new ShopifyMapError('payment status is not mapped');
  }
  const shipping = mapShipping(order.shippingLine, store.deliveryMethodMap);
  const giftMessage = mapGiftMessage(order.customAttributes, store.giftMessageKeys);
  return {
    externalId,
    externalNumber,
    sourceCreatedAt,
    sourceUpdatedAt,
    paymentStatus,
    sourceStatus: {
      displayFulfillmentStatus: optionalString(
        order.displayFulfillmentStatus,
        'displayFulfillmentStatus',
      ),
      cancelledAt: nullableTimestamp(order.cancelledAt, 'cancelledAt'),
    },
    customer: mapCustomer(order),
    recipient: objectOrNull(order.shippingAddress, 'shippingAddress'),
    billingAddress: objectOrNull(order.billingAddress, 'billingAddress'),
    giftMessage,
    customerNote: optionalText(order.note, 'note'),
    deliveryMethod: shipping.method,
    shippingLine: shipping.line,
    currency: currencyCode(order.currencyCode),
    lines: mapLines(order.lineItems),
    subtotal: moneySet(order.subtotalPriceSet, 'subtotalPriceSet'),
    shippingTotal: moneySet(order.totalShippingPriceSet, 'totalShippingPriceSet'),
    taxTotal: moneySet(order.totalTaxSet, 'totalTaxSet'),
    total: moneySet(order.totalPriceSet, 'totalPriceSet'),
  };
}

function mapGiftMessage(value: unknown, keys: readonly string[]): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new ShopifyMapError('customAttributes must be an array');
  }
  const wanted = new Set(keys);
  for (const entry of value) {
    const attribute = record(entry, 'customAttributes');
    const key = attribute.key;
    if (typeof key !== 'string' || !wanted.has(key)) {
      continue;
    }
    if (typeof attribute.value !== 'string') {
      throw new ShopifyMapError('gift message value must be a string');
    }
    return attribute.value;
  }
  return null;
}

function mapShipping(
  value: unknown,
  deliveryMethodMap: Readonly<Record<string, string>>,
): { method: DeliveryMethod; line: Record<string, unknown> | null } {
  if (value === undefined || value === null) {
    return { method: 'unknown', line: null };
  }
  const line = record(value, 'shippingLine');
  const code = typeof line.code === 'string' && line.code.length > 0 ? line.code : null;
  const title = typeof line.title === 'string' && line.title.length > 0 ? line.title : null;
  const key = code ?? title;
  const mapped = key ? deliveryMethodMap[key] : undefined;
  const method =
    mapped !== undefined && DELIVERY.has(mapped) ? (mapped as DeliveryMethod) : 'unknown';
  return { method, line };
}

function mapCustomer(order: Record<string, unknown>): MappedShopifyOrder['customer'] {
  const customer =
    order.customer === undefined || order.customer === null
      ? null
      : record(order.customer, 'customer');
  return {
    id: optionalText(customer?.id, 'customer.id'),
    displayName: optionalText(customer?.displayName, 'customer.displayName'),
    email: optionalText(order.email, 'email') ?? optionalText(customer?.email, 'customer.email'),
    phone: optionalText(order.phone, 'phone') ?? optionalText(customer?.phone, 'customer.phone'),
  };
}

function mapLines(value: unknown): MappedOrderLine[] {
  const lineItems = record(value, 'lineItems');
  if (!Array.isArray(lineItems.nodes)) {
    throw new ShopifyMapError('lineItems.nodes must be an array');
  }
  return lineItems.nodes.map((node, index) => {
    const line = record(node, `lineItems.nodes[${String(index)}]`);
    const label = `lineItems.nodes[${String(index)}]`;
    return {
      externalLineId: optionalText(line.id, `${label}.id`),
      sku: optionalText(line.sku, `${label}.sku`),
      title: requiredString(line, 'title'),
      variantTitle: optionalText(line.variantTitle, `${label}.variantTitle`),
      quantity: quantity(line.quantity, `${label}.quantity`),
      unitPrice: shopMoney(line.originalUnitPriceSet, `${label}.originalUnitPriceSet`, 4),
      total: shopMoney(line.originalTotalSet, `${label}.originalTotalSet`, 2),
    };
  });
}

function moneySet(value: unknown, field: string): string {
  return shopMoney(value, field, 2);
}

function shopMoney(value: unknown, field: string, scale: 2 | 4): string {
  const set = record(value, field);
  const shop = record(set.shopMoney, `${field}.shopMoney`);
  try {
    const amount = parseAmount(shop.amount, scale);
    return scale === 2 ? amount.toFixed(2) : amount.toFixed(4);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid amount';
    throw new ShopifyMapError(`${field}: ${message}`);
  }
}

function quantity(value: unknown, field: string): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ShopifyMapError(`${field} must be a non-negative integer`);
    }
    return parseAmount(String(value), 4).toFixed(4);
  }
  try {
    return parseAmount(value, 4).toFixed(4);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid quantity';
    throw new ShopifyMapError(`${field}: ${message}`);
  }
}

function currencyCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new ShopifyMapError('currencyCode must be a 3-letter code');
  }
  return value;
}

function requiredString(recordValue: Record<string, unknown>, key: string): string {
  const value = recordValue[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ShopifyMapError(`${key} must be a string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ShopifyMapError(`${field} must be a string`);
  }
  return value;
}

/** Customer text is returned unchanged. Null and missing become null. Any other type is refused. */
function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ShopifyMapError(`${field} must be a string`);
  }
  return value;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    throw new ShopifyMapError(`${field} must be an ISO timestamp or null`);
  }
  return value;
}

function timestamp(value: unknown, field: string): Date {
  if (typeof value !== 'string') {
    throw new ShopifyMapError(`${field} must be an ISO timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ShopifyMapError(`${field} must be an ISO timestamp`);
  }
  return parsed;
}

function objectOrNull(value: unknown, field: string): Record<string, unknown> | null {
  if (value === undefined || value === null) {
    return null;
  }
  return record(value, field);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ShopifyMapError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
