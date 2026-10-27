import { resolve } from 'node:path';
import {
  DELIVERY_METHODS,
  PAYMENT_STATUSES,
  money,
  parseAmount,
  round2,
  wallTimeInZoneToInstant,
  type DeliveryMethod,
  type PaymentStatus,
} from '@bp/domain';
import type { MappedOrder, MappedOrderLine } from '../shopify/map-order';
import { prestashopOrderPayloadSchema, type PrestashopOrderPayload } from './payload';

const DELIVERY = new Set<string>(DELIVERY_METHODS);
const PAYMENT = new Set<string>(PAYMENT_STATUSES);

export type PrestashopConnectionConfig = {
  timezone: string;
  stateMap: Record<string, { payment: PaymentStatus; cancelled: boolean }>;
  carrierMap: Record<string, DeliveryMethod>;
};

export class PrestashopMapError extends Error {
  override readonly name = 'PrestashopMapError';
}

/** Fixtures live next to the package, outside `src`, so the build does not emit them. */
export function prestashopFixturesDirectory(): string {
  return resolve(__dirname, '../../prestashop/fixtures');
}

export function readPrestashopEventIdentity(
  payload: unknown,
  timezone: string,
): { externalId: string; sourceUpdatedAt: Date } {
  const parsed = parsePayload(payload);
  return {
    externalId: parsed.order.id,
    sourceUpdatedAt: wallTimeInZoneToInstant(parsed.order.date_upd, timezone),
  };
}

export function mapPrestashopOrder(
  payload: unknown,
  config: PrestashopConnectionConfig,
): MappedOrder {
  const parsed = parsePayload(payload);
  if (parsed.currency === null) {
    throw new PrestashopMapError('prestashop_currency_missing');
  }
  const sourceCreatedAt = wallTimeInZoneToInstant(parsed.order.date_add, config.timezone);
  const sourceUpdatedAt = wallTimeInZoneToInstant(parsed.order.date_upd, config.timezone);
  const lines = mapLines(parsed.order.rows);
  return {
    externalId: parsed.order.id,
    externalNumber: parsed.order.reference,
    sourceCreatedAt,
    sourceUpdatedAt,
    paymentStatus: paymentOf(parsed.order.current_state, config.stateMap),
    sourceStatus: {
      displayFulfillmentStatus: parsed.state?.name ?? `state:${parsed.order.current_state}`,
      cancelledAt: cancelledAt(parsed.order.current_state, config.stateMap, sourceUpdatedAt),
    },
    customer: {
      id: parsed.customer?.id ?? null,
      displayName:
        parsed.customer === null
          ? null
          : displayName(parsed.customer.firstname, parsed.customer.lastname),
      email:
        parsed.customer === null || parsed.customer.email.length === 0
          ? null
          : parsed.customer.email,
      phone: phoneOf(parsed.delivery),
    },
    recipient: party(parsed.delivery),
    billingAddress: party(parsed.invoice),
    giftMessage: parsed.order.gift_message.length > 0 ? parsed.order.gift_message : null,
    customerNote: null,
    deliveryMethod: deliveryOf(parsed.carrier?.id_reference ?? null, config.carrierMap),
    shippingLine:
      parsed.carrier === null
        ? null
        : { code: parsed.carrier.id_reference, title: parsed.carrier.name },
    currency: parsed.currency.iso_code.toUpperCase(),
    lines,
    subtotal: money2(parsed.order.total_products_wt),
    shippingTotal: money2(parsed.order.total_shipping_tax_incl),
    taxTotal: difference2(parsed.order.total_paid_tax_incl, parsed.order.total_paid_tax_excl),
    total: money2(parsed.order.total_paid_tax_incl),
  };
}

function parsePayload(payload: unknown): PrestashopOrderPayload {
  const parsed = prestashopOrderPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new PrestashopMapError('prestashop_payload_invalid');
  }
  return parsed.data;
}

function mapLines(rows: PrestashopOrderPayload['order']['rows']): MappedOrderLine[] {
  return rows.map((row) => {
    const unitPrice = money2(row.unit_price_tax_incl);
    const quantity = quantity4(row.product_quantity);
    return {
      externalLineId: row.id,
      sku: row.product_reference.length > 0 ? row.product_reference : null,
      title: row.product_name,
      variantTitle: null,
      quantity,
      unitPrice,
      total: lineTotal(row.unit_price_tax_incl, row.product_quantity),
    };
  });
}

function party(address: PrestashopOrderPayload['delivery']): Record<string, unknown> | null {
  if (address === null) {
    return null;
  }
  return {
    name: displayName(address.firstname, address.lastname),
    firstName: emptyToNull(address.firstname),
    lastName: emptyToNull(address.lastname),
    company: emptyToNull(address.company),
    address1: emptyToNull(address.address1),
    address2: emptyToNull(address.address2),
    city: emptyToNull(address.city),
    zip: emptyToNull(address.postcode),
    province: null,
    country: address.country === null ? null : emptyToNull(address.country.name),
    countryCode: address.country === null ? null : emptyToNull(address.country.iso_code),
    phone: phoneOf(address),
  };
}

function displayName(firstname: string, lastname: string): string | null {
  const name = `${firstname} ${lastname}`.trim();
  return name.length === 0 ? null : name;
}

function phoneOf(address: { phone_mobile: string; phone: string } | null): string | null {
  if (address === null) {
    return null;
  }
  if (address.phone_mobile.length > 0) {
    return address.phone_mobile;
  }
  if (address.phone.length > 0) {
    return address.phone;
  }
  return null;
}

function emptyToNull(value: string): string | null {
  return value.length === 0 ? null : value;
}

function paymentOf(
  stateId: string,
  stateMap: PrestashopConnectionConfig['stateMap'],
): PaymentStatus {
  const entry = stateMap[stateId];
  if (entry === undefined || !PAYMENT.has(entry.payment)) {
    return 'unknown';
  }
  return entry.payment;
}

function cancelledAt(
  stateId: string,
  stateMap: PrestashopConnectionConfig['stateMap'],
  sourceUpdatedAt: Date,
): string | null {
  if (stateMap[stateId]?.cancelled !== true) {
    return null;
  }
  return sourceUpdatedAt.toISOString();
}

function deliveryOf(
  reference: string | null,
  carrierMap: PrestashopConnectionConfig['carrierMap'],
): DeliveryMethod {
  if (reference === null) {
    return 'unknown';
  }
  const mapped = carrierMap[reference];
  if (mapped === undefined || !DELIVERY.has(mapped)) {
    return 'unknown';
  }
  return mapped;
}

/** PrestaShop prices use up to 6 decimal places. Money on the order is 2. */
function shopDecimal(value: string) {
  const fraction = value.split('.')[1];
  const scale = fraction === undefined ? 0 : fraction.length;
  return parseAmount(value, scale);
}

function money2(value: string): string {
  try {
    return money(round2(shopDecimal(value)));
  } catch {
    throw new PrestashopMapError('prestashop_payload_invalid');
  }
}

function difference2(incl: string, excl: string): string {
  try {
    return money(round2(shopDecimal(incl).minus(shopDecimal(excl))));
  } catch {
    throw new PrestashopMapError('prestashop_payload_invalid');
  }
}

/** `sales_order_line.quantity` is numeric(19,4). */
function quantity4(value: string): string {
  try {
    const parsed = shopDecimal(value);
    if (parsed.isNeg()) {
      throw new PrestashopMapError('prestashop_payload_invalid');
    }
    return parsed.toDecimalPlaces(4).toFixed(4);
  } catch (error) {
    if (error instanceof PrestashopMapError) {
      throw error;
    }
    throw new PrestashopMapError('prestashop_payload_invalid');
  }
}

/** Multiply the unrounded unit price by the quantity, then round to 2 decimals. */
function lineTotal(rawUnitPrice: string, rawQuantity: string): string {
  try {
    return money(round2(shopDecimal(rawUnitPrice).mul(shopDecimal(rawQuantity))));
  } catch {
    throw new PrestashopMapError('prestashop_payload_invalid');
  }
}
