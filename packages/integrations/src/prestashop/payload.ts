import { z } from 'zod';
import type {
  PrestashopAddress,
  PrestashopCarrier,
  PrestashopCountry,
  PrestashopCurrency,
  PrestashopCustomer,
  PrestashopOrder,
  PrestashopOrderState,
} from './client';

const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const UNSIGNED_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const SHOP_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const COUNTRY_CODE = /^[A-Za-z]{2}$/;
const CURRENCY_CODE = /^[A-Za-z]{3}$/;

const rowSchema = z.object({
  id: z.string().min(1),
  product_id: z.string(),
  product_attribute_id: z.string(),
  product_reference: z.string(),
  product_name: z.string(),
  product_quantity: z.string().regex(UNSIGNED_DECIMAL),
  unit_price_tax_incl: z.string().regex(UNSIGNED_DECIMAL),
});

const addressSchema = z.object({
  id: z.string().min(1),
  firstname: z.string(),
  lastname: z.string(),
  company: z.string(),
  address1: z.string(),
  address2: z.string(),
  postcode: z.string(),
  city: z.string(),
  id_country: z.string(),
  id_state: z.string(),
  phone: z.string(),
  phone_mobile: z.string(),
  country: z
    .object({
      iso_code: z.string().regex(COUNTRY_CODE),
      name: z.string(),
    })
    .nullable(),
});

export const prestashopOrderPayloadSchema = z.object({
  schema: z.literal('prestashop.order.v1'),
  order: z.object({
    id: z.string().min(1),
    reference: z.string().min(1),
    date_add: z.string().regex(SHOP_TIME),
    date_upd: z.string().regex(SHOP_TIME),
    current_state: z.string().min(1),
    id_currency: z.string(),
    id_carrier: z.string(),
    gift: z.string(),
    gift_message: z.string(),
    total_paid_tax_incl: z.string().regex(SIGNED_DECIMAL),
    total_paid_tax_excl: z.string().regex(SIGNED_DECIMAL),
    total_products_wt: z.string().regex(SIGNED_DECIMAL),
    total_shipping_tax_incl: z.string().regex(SIGNED_DECIMAL),
    rows: z.array(rowSchema),
  }),
  customer: z
    .object({
      id: z.string().min(1),
      firstname: z.string(),
      lastname: z.string(),
      email: z.string(),
    })
    .nullable(),
  delivery: addressSchema.nullable(),
  invoice: addressSchema.nullable(),
  carrier: z
    .object({
      id: z.string().min(1),
      id_reference: z.string(),
      name: z.string(),
    })
    .nullable(),
  currency: z
    .object({
      id: z.string().min(1),
      iso_code: z.string().regex(CURRENCY_CODE),
    })
    .nullable(),
  state: z
    .object({
      id: z.string().min(1),
      name: z.string(),
    })
    .nullable(),
});

export type PrestashopOrderPayload = z.infer<typeof prestashopOrderPayloadSchema>;

export type PrestashopOrderLookups = {
  customers: readonly PrestashopCustomer[];
  addresses: readonly PrestashopAddress[];
  countries: readonly PrestashopCountry[];
  carriers: readonly PrestashopCarrier[];
  currencies: readonly PrestashopCurrency[];
  states: readonly PrestashopOrderState[];
};

/** Builds the inbox payload. `gift_message` is copied exactly as it arrived. */
export function buildPrestashopOrderPayload(
  order: PrestashopOrder,
  lookups: PrestashopOrderLookups,
): PrestashopOrderPayload {
  const customer = byId(lookups.customers, order.id_customer);
  const carrier = byId(lookups.carriers, order.id_carrier);
  const currency = byId(lookups.currencies, order.id_currency);
  const state = byId(lookups.states, order.current_state);
  return {
    schema: 'prestashop.order.v1',
    order: {
      id: order.id,
      reference: order.reference,
      date_add: order.date_add,
      date_upd: order.date_upd,
      current_state: order.current_state,
      id_currency: order.id_currency,
      id_carrier: order.id_carrier,
      gift: order.gift,
      gift_message: order.gift_message,
      total_paid_tax_incl: order.total_paid_tax_incl,
      total_paid_tax_excl: order.total_paid_tax_excl,
      total_products_wt: order.total_products_wt,
      total_shipping_tax_incl: order.total_shipping_tax_incl,
      rows: order.rows.map((row) => ({
        id: row.id,
        product_id: row.product_id,
        product_attribute_id: row.product_attribute_id,
        product_reference: row.product_reference,
        product_name: row.product_name,
        product_quantity: row.product_quantity,
        unit_price_tax_incl: row.unit_price_tax_incl,
      })),
    },
    customer:
      customer === null
        ? null
        : {
            id: customer.id,
            firstname: customer.firstname,
            lastname: customer.lastname,
            email: customer.email,
          },
    delivery: addressPayload(byId(lookups.addresses, order.id_address_delivery), lookups.countries),
    invoice: addressPayload(byId(lookups.addresses, order.id_address_invoice), lookups.countries),
    carrier:
      carrier === null
        ? null
        : { id: carrier.id, id_reference: carrier.id_reference, name: carrier.name },
    currency: currency === null ? null : { id: currency.id, iso_code: currency.iso_code },
    state: state === null ? null : { id: state.id, name: state.name },
  };
}

function addressPayload(
  address: PrestashopAddress | null,
  countries: readonly PrestashopCountry[],
): PrestashopOrderPayload['delivery'] {
  if (address === null) {
    return null;
  }
  const country = byId(countries, address.id_country);
  return {
    id: address.id,
    firstname: address.firstname,
    lastname: address.lastname,
    company: address.company,
    address1: address.address1,
    address2: address.address2,
    postcode: address.postcode,
    city: address.city,
    id_country: address.id_country,
    id_state: address.id_state,
    phone: address.phone,
    phone_mobile: address.phone_mobile,
    country: country === null ? null : { iso_code: country.iso_code, name: country.name },
  };
}

function byId<T extends { id: string }>(rows: readonly T[], id: string): T | null {
  for (const row of rows) {
    if (row.id === id) {
      return row;
    }
  }
  return null;
}
