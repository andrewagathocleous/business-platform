import { z } from 'zod';
import { isLoopbackHostname } from '../http/address-policy';
import type { SafeResponse } from '../http/safe-fetch';
import type { SafeFetch } from '../printing/printnode';

const MAX_IDS_PER_REQUEST = 100;
const DEFAULT_TIMEOUT_MS = 20_000;
const SHOP_LOCAL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const SHOP_ID = /^\d{1,20}$/;
const API_KEY = /^[A-Za-z0-9]{32}$/;
const INTEGER_TOKEN = /^[0-9]+$/;
const DECIMAL_TOKEN = /^-?[0-9]+(?:\.[0-9]+)?$/;

const CUSTOMER_DISPLAY = '[id,firstname,lastname,email]';
const ADDRESS_DISPLAY =
  '[id,firstname,lastname,company,address1,address2,postcode,city,id_country,id_state,phone,phone_mobile]';
const COUNTRY_DISPLAY = '[id,iso_code,name]';
const CARRIER_DISPLAY = '[id,id_reference,name]';
const CURRENCY_DISPLAY = '[id,iso_code]';
const ORDER_STATE_DISPLAY = '[id,name]';

/**
 * Read-only PrestaShop 1.7.7 Webservice client.
 * The key is the Basic auth user, with an empty password. It is never put in the URL.
 * A transport error from the shared client is left unchanged, so a read may be retried.
 * A JSON number is read from its original token, never from the JavaScript number.
 * Text, including gift_message, must be a string.
 */
export function createPrestashopClient(deps: {
  fetch: SafeFetch;
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}): PrestashopClient {
  const fetch = deps.fetch;
  const base = shopBase(deps.baseUrl);
  const authorization = authorizationHeader(deps.apiKey);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(resource: string, params: URLSearchParams): Promise<SafeResponse> {
    const response = await fetch(resourceUrl(base, resource, params), {
      method: 'GET',
      headers: {
        Authorization: authorization,
        'Output-Format': 'JSON',
      },
      timeoutMs,
    });
    if (response.status === 401 || response.status === 403) {
      throw new PrestashopAuthFailed();
    }
    if (response.status < 200 || response.status >= 300) {
      throw new PrestashopBadResponse(response.status);
    }
    return response;
  }

  async function getList<S extends z.ZodType>(
    resource: string,
    params: URLSearchParams,
    item: S,
  ): Promise<z.infer<S>[]> {
    const response = await request(resource, params);
    return parseList(readJson(response), resource, item, response.status);
  }

  async function getByIds<S extends z.ZodType>(
    resource: string,
    display: string,
    ids: readonly string[],
    item: S,
  ): Promise<z.infer<S>[]> {
    const rows: z.infer<S>[] = [];
    for (const group of chunkIds(ids)) {
      const params = new URLSearchParams();
      params.set('display', display);
      params.set('filter[id]', `[${group.join('|')}]`);
      rows.push(...(await getList(resource, params, item)));
    }
    return rows;
  }

  return {
    async ping() {
      const params = new URLSearchParams();
      params.set('display', '[id]');
      params.set('limit', '1');
      await getList('orders', params, z.object({ id: z.string() }));
      return true;
    },
    async listOrdersUpdatedBetween(query) {
      const from = shopLocalTime(query.from);
      const to = shopLocalTime(query.to);
      const offset = pageCount(query.offset);
      const limit = pageCount(query.limit);
      const params = new URLSearchParams();
      params.set('display', 'full');
      params.set('date', '1');
      params.set('filter[date_upd]', `[${from},${to}]`);
      params.set('sort', '[date_upd_ASC,id_ASC]');
      params.set('limit', `${offset},${limit}`);
      return getList('orders', params, orderSchema);
    },
    getCustomers(ids) {
      return getByIds('customers', CUSTOMER_DISPLAY, ids, customerSchema);
    },
    getAddresses(ids) {
      return getByIds('addresses', ADDRESS_DISPLAY, ids, addressSchema);
    },
    getCountries(ids) {
      return getByIds('countries', COUNTRY_DISPLAY, ids, countrySchema);
    },
    getCarriers(ids) {
      return getByIds('carriers', CARRIER_DISPLAY, ids, carrierSchema);
    },
    getCurrencies(ids) {
      return getByIds('currencies', CURRENCY_DISPLAY, ids, currencySchema);
    },
    getOrderStates() {
      const params = new URLSearchParams();
      params.set('display', ORDER_STATE_DISPLAY);
      return getList('order_states', params, orderStateSchema);
    },
  };
}

export type PrestashopClient = {
  ping(): Promise<true>;
  listOrdersUpdatedBetween(query: {
    from: string;
    to: string;
    offset: number;
    limit: number;
  }): Promise<PrestashopOrder[]>;
  getCustomers(ids: readonly string[]): Promise<PrestashopCustomer[]>;
  getAddresses(ids: readonly string[]): Promise<PrestashopAddress[]>;
  getCountries(ids: readonly string[]): Promise<PrestashopCountry[]>;
  getCarriers(ids: readonly string[]): Promise<PrestashopCarrier[]>;
  getCurrencies(ids: readonly string[]): Promise<PrestashopCurrency[]>;
  getOrderStates(): Promise<PrestashopOrderState[]>;
};

export class PrestashopAuthFailed extends Error {
  override readonly name = 'PrestashopAuthFailed';
  readonly code = 'auth_failed';

  constructor() {
    super('prestashop_auth_failed');
  }
}

export class PrestashopBadResponse extends Error {
  override readonly name = 'PrestashopBadResponse';
  readonly code = 'bad_response';
  readonly status: number;

  constructor(status: number) {
    super('prestashop_bad_response');
    this.status = status;
  }
}

const languageName = z
  .union([
    z.string(),
    z
      .array(
        z.object({
          id: z.string(),
          value: z.string(),
        }),
      )
      .min(1),
  ])
  .transform((value): string => {
    if (typeof value === 'string') {
      return value;
    }
    const first = value[0];
    if (first === undefined) {
      return '';
    }
    return first.value;
  });

const orderRowSchema = z.object({
  id: z.string(),
  product_id: z.string(),
  product_attribute_id: z.string(),
  product_reference: z.string(),
  product_name: z.string(),
  product_quantity: z.string(),
  unit_price_tax_incl: z.string(),
});

const orderSchema = z
  .object({
    id: z.string(),
    reference: z.string(),
    date_add: z.string(),
    date_upd: z.string(),
    current_state: z.string(),
    id_customer: z.string(),
    id_address_delivery: z.string(),
    id_address_invoice: z.string(),
    id_currency: z.string(),
    id_carrier: z.string(),
    gift: z.string(),
    gift_message: z.string(),
    total_paid_tax_incl: z.string(),
    total_paid_tax_excl: z.string(),
    total_products_wt: z.string(),
    total_shipping_tax_incl: z.string(),
    associations: z
      .object({
        order_rows: z.array(orderRowSchema).optional(),
      })
      .optional(),
  })
  .transform((order) => ({
    id: order.id,
    reference: order.reference,
    date_add: order.date_add,
    date_upd: order.date_upd,
    current_state: order.current_state,
    id_customer: order.id_customer,
    id_address_delivery: order.id_address_delivery,
    id_address_invoice: order.id_address_invoice,
    id_currency: order.id_currency,
    id_carrier: order.id_carrier,
    gift: order.gift,
    gift_message: order.gift_message,
    total_paid_tax_incl: order.total_paid_tax_incl,
    total_paid_tax_excl: order.total_paid_tax_excl,
    total_products_wt: order.total_products_wt,
    total_shipping_tax_incl: order.total_shipping_tax_incl,
    rows: (order.associations?.order_rows ?? []).map((row) => ({
      id: row.id,
      product_id: row.product_id,
      product_attribute_id: row.product_attribute_id,
      product_reference: row.product_reference,
      product_name: row.product_name,
      product_quantity: row.product_quantity,
      unit_price_tax_incl: row.unit_price_tax_incl,
    })),
  }));

const customerSchema = z.object({
  id: z.string(),
  firstname: z.string(),
  lastname: z.string(),
  email: z.string(),
});

const addressSchema = z.object({
  id: z.string(),
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
});

const countrySchema = z.object({
  id: z.string(),
  iso_code: z.string(),
  name: languageName,
});

const carrierSchema = z.object({
  id: z.string(),
  id_reference: z.string(),
  name: languageName,
});

const currencySchema = z.object({
  id: z.string(),
  iso_code: z.string(),
});

const orderStateSchema = z.object({
  id: z.string(),
  name: languageName,
});

export type PrestashopOrder = z.infer<typeof orderSchema>;
export type PrestashopOrderRow = PrestashopOrder['rows'][number];
export type PrestashopCustomer = z.infer<typeof customerSchema>;
export type PrestashopAddress = z.infer<typeof addressSchema>;
export type PrestashopCountry = z.infer<typeof countrySchema>;
export type PrestashopCarrier = z.infer<typeof carrierSchema>;
export type PrestashopCurrency = z.infer<typeof currencySchema>;
export type PrestashopOrderState = z.infer<typeof orderStateSchema>;

/**
 * `baseUrl` is the shop origin plus an optional path prefix, with no query,
 * fragment or userinfo. The raw string must already be canonical: no whitespace
 * or control character, and the same text the URL parser would produce, aside
 * from one trailing slash. Each request is `<origin><prefix>/api/<resource>`.
 * `http:` is accepted only for a loopback host, which is how the tests reach a
 * fake server; `createSafeFetch` still refuses that host outside test.
 */
/** Canonical shop base. `http:` is accepted only for a loopback host. */
export function canonicalPrestashopBaseUrl(baseUrl: string): string {
  return shopBase(baseUrl);
}

function shopBase(baseUrl: string): string {
  if (hasWhitespaceOrControl(baseUrl)) {
    throw new Error('prestashop_base_url_invalid');
  }
  const parsed = parseShopUrl(baseUrl);
  if (withoutOneTrailingSlash(baseUrl) !== withoutOneTrailingSlash(parsed.href)) {
    throw new Error('prestashop_base_url_invalid');
  }
  if (parsed.username !== '' || parsed.password !== '' || authorityHasUserinfo(baseUrl)) {
    throw new Error('prestashop_base_url_invalid');
  }
  if (parsed.search !== '' || parsed.hash !== '' || parsed.hostname === '') {
    throw new Error('prestashop_base_url_invalid');
  }
  if (!allowedShopProtocol(parsed) || hasParentSegment(rawPathname(baseUrl))) {
    throw new Error('prestashop_base_url_invalid');
  }
  const prefix = parsed.pathname.replace(/\/+$/, '');
  if (prefix.split('/').includes('..')) {
    throw new Error('prestashop_base_url_invalid');
  }
  return `${parsed.origin}${prefix}`;
}

function withoutOneTrailingSlash(value: string): string {
  if (value.endsWith('/')) {
    return value.slice(0, -1);
  }
  return value;
}

function hasWhitespaceOrControl(value: string): boolean {
  if (/\s/u.test(value)) {
    return true;
  }
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function parseShopUrl(baseUrl: string): URL {
  try {
    return new URL(baseUrl);
  } catch {
    throw new Error('prestashop_base_url_invalid');
  }
}

function allowedShopProtocol(url: URL): boolean {
  if (url.protocol === 'https:') {
    return true;
  }
  return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
}

function authorityHasUserinfo(baseUrl: string): boolean {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(baseUrl);
  return (match?.[1] ?? '').includes('@');
}

/** The path before the URL parser folds `..` or a backslash into another prefix. */
function rawPathname(baseUrl: string): string {
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(baseUrl);
  if (scheme === null || !baseUrl.startsWith('//', scheme[0].length)) {
    return '';
  }
  const authorityAndPath = baseUrl.slice(scheme[0].length + 2);
  const splitAt = authorityAndPath.search(/[/?#\\]/);
  if (splitAt < 0) {
    return '';
  }
  const pathAndMore = authorityAndPath.slice(splitAt);
  const end = pathAndMore.search(/[?#]/);
  return end < 0 ? pathAndMore : pathAndMore.slice(0, end);
}

function hasParentSegment(path: string): boolean {
  for (const segment of path.split(/[/\\]/)) {
    if (segment === '..' || decodesToParent(segment)) {
      return true;
    }
  }
  return false;
}

function decodesToParent(segment: string): boolean {
  if (!segment.includes('%')) {
    return false;
  }
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.split(/[/\\]/).includes('..');
  } catch {
    return true;
  }
}

function authorizationHeader(apiKey: string): string {
  if (!API_KEY.test(apiKey)) {
    throw new Error('prestashop_api_key_invalid');
  }
  return `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}`;
}

function resourceUrl(base: string, resource: string, params: URLSearchParams): string {
  const url = new URL(`${base}/api/${resource}`);
  url.search = '';
  for (const [key, value] of params) {
    url.searchParams.append(key, value);
  }
  return url.href;
}

function shopLocalTime(value: string): string {
  if (!SHOP_LOCAL_TIME.test(value)) {
    throw new Error('prestashop_date_invalid');
  }
  return value;
}

function pageCount(value: number): string {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('prestashop_page_invalid');
  }
  return String(value);
}

function chunkIds(ids: readonly string[]): string[][] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!SHOP_ID.test(id)) {
      throw new Error('prestashop_id_invalid');
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    unique.push(id);
  }
  const groups: string[][] = [];
  for (let index = 0; index < unique.length; index += MAX_IDS_PER_REQUEST) {
    groups.push(unique.slice(index, index + MAX_IDS_PER_REQUEST));
  }
  return groups;
}

/** An empty PrestaShop list is `[]`. Any other list is `{ "<resource>": [ ... ] }`. */
function parseList<S extends z.ZodType>(
  body: unknown,
  resource: string,
  item: S,
  status: number,
): z.infer<S>[] {
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return [];
    }
    throw new PrestashopBadResponse(status);
  }
  if (!isRecord(body)) {
    throw new PrestashopBadResponse(status);
  }
  const parsed = z.array(item).safeParse(body[resource]);
  if (!parsed.success) {
    throw new PrestashopBadResponse(status);
  }
  return parsed.data;
}

function readJson(response: SafeResponse): unknown {
  try {
    return JSON.parse(response.body.toString('utf8'), reviveShopValue(response.status)) as unknown;
  } catch (error) {
    if (error instanceof PrestashopBadResponse) {
      throw error;
    }
    throw new PrestashopBadResponse(response.status);
  }
}

type JsonNumberContext = {
  source?: unknown;
};

/**
 * Every JSON number becomes its original token before a schema sees it.
 * The JavaScript number is not used. An id, `id_*` field, `current_state`,
 * `gift` or language id must be digits. Money and `product_quantity` must be a
 * plain decimal. A number on a text field is a bad response. A number on any
 * other field keeps that token so the schema can drop a shop property this
 * client does not read.
 */
function reviveShopValue(
  status: number,
): (key: string, value: unknown, context?: JsonNumberContext) => unknown {
  return (key, value, context) => {
    if (typeof value !== 'number') {
      return value;
    }
    if (typeof context?.source !== 'string') {
      throw new PrestashopBadResponse(status);
    }
    return shopNumberToken(key, context.source, status);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MONEY_FIELDS = new Set([
  'total_paid_tax_excl',
  'total_paid_tax_incl',
  'total_products_wt',
  'total_shipping_tax_incl',
  'unit_price_tax_incl',
]);

const TEXT_FIELDS = new Set([
  'reference',
  'date_add',
  'date_upd',
  'gift_message',
  'product_reference',
  'product_name',
  'firstname',
  'lastname',
  'email',
  'company',
  'address1',
  'address2',
  'postcode',
  'city',
  'phone',
  'phone_mobile',
  'iso_code',
  'name',
  'value',
]);

function shopNumberToken(key: string, token: string, status: number): string {
  if (isIntegerField(key)) {
    if (!INTEGER_TOKEN.test(token)) {
      throw new PrestashopBadResponse(status);
    }
    return token;
  }
  if (isDecimalField(key)) {
    if (!DECIMAL_TOKEN.test(token)) {
      throw new PrestashopBadResponse(status);
    }
    return token;
  }
  if (TEXT_FIELDS.has(key)) {
    throw new PrestashopBadResponse(status);
  }
  return token;
}

function isIntegerField(key: string): boolean {
  return (
    key === 'id' ||
    key.startsWith('id_') ||
    key === 'product_id' ||
    key === 'product_attribute_id' ||
    key === 'current_state' ||
    key === 'gift'
  );
}

function isDecimalField(key: string): boolean {
  return key === 'product_quantity' || MONEY_FIELDS.has(key);
}
