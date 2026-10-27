import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { type Socket } from 'node:net';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { money, parseAmount } from '@bp/domain';
import { createSafeFetch } from '../http/safe-fetch';
import { createPrestashopClient } from './client';
import {
  PrestashopMapError,
  mapPrestashopOrder,
  prestashopFixturesDirectory,
  readPrestashopEventIdentity,
  type PrestashopConnectionConfig,
} from './map-order';
import {
  buildPrestashopOrderPayload,
  prestashopOrderPayloadSchema,
  type PrestashopOrderPayload,
} from './payload';

const KEY = '0123456789abcdef0123456789abcdef';
const GIFT = 'Χρόνια πολλά, Μαρία!\n\nΜε αγάπη,\nΓιώργος & Ελένη — «καλή χρονιά» ';

const CONFIG: PrestashopConnectionConfig = {
  timezone: 'Asia/Nicosia',
  stateMap: {
    '2': { payment: 'paid', cancelled: false },
    '10': { payment: 'pending', cancelled: false },
    '6': { payment: 'voided', cancelled: true },
  },
  carrierMap: {
    '2': 'courier_cy',
  },
};

const FIXTURES: Record<string, string> = {
  '/api/orders': 'orders-page-1.json',
  '/api/customers': 'customers.json',
  '/api/addresses': 'addresses.json',
  '/api/countries': 'countries.json',
  '/api/carriers': 'carriers.json',
  '/api/currencies': 'currencies.json',
  '/api/order_states': 'order-states.json',
};

let paid: PrestashopOrderPayload | undefined;
let awaiting: PrestashopOrderPayload | undefined;

beforeAll(async () => {
  const loaded = await loadPayloads();
  paid = loaded.paid;
  awaiting = loaded.awaiting;
});

describe('mapPrestashopOrder', () => {
  it('keeps the Greek gift message bytes and drops an empty one', () => {
    const order = paidOrder();
    const mapped = mapPrestashopOrder(order, CONFIG);
    const fixtureGift = giftFromFixture();
    expect(Buffer.compare(Buffer.from(fixtureGift, 'utf8'), Buffer.from(GIFT, 'utf8'))).toBe(0);
    expect(
      Buffer.compare(Buffer.from(order.order.gift_message, 'utf8'), Buffer.from(GIFT, 'utf8')),
    ).toBe(0);
    expect(
      Buffer.compare(Buffer.from(mapped.giftMessage ?? '', 'utf8'), Buffer.from(GIFT, 'utf8')),
    ).toBe(0);
    expect(GIFT.endsWith(' ')).toBe(true);
    expect(GIFT).toContain('\n\n');
    expect(GIFT).toContain('«καλή χρονιά»');
    expect(mapped.customerNote).toBeNull();
    expect(mapPrestashopOrder(awaitingOrder(), CONFIG).giftMessage).toBeNull();
  });

  it('maps an unmapped state to unknown and a cancelled state to cancelledAt', () => {
    const unmapped = clone(paidOrder());
    unmapped.order.current_state = '99';
    unmapped.state = null;
    const unknown = mapPrestashopOrder(unmapped, CONFIG);
    expect(unknown.paymentStatus).toBe('unknown');
    expect(unknown.sourceStatus.cancelledAt).toBeNull();
    expect(unknown.sourceStatus.displayFulfillmentStatus).toBe('state:99');

    const cancelled = clone(paidOrder());
    cancelled.order.current_state = '6';
    cancelled.state = { id: '6', name: 'Cancelled demo' };
    const mapped = mapPrestashopOrder(cancelled, CONFIG);
    expect(mapped.paymentStatus).toBe('voided');
    expect(mapped.sourceStatus.displayFulfillmentStatus).toBe('Cancelled demo');
    expect(mapped.sourceStatus.cancelledAt).toBe('2026-06-15T13:45:00.000Z');
    expect(mapped.sourceStatus.cancelledAt).toBe(mapped.sourceUpdatedAt.toISOString());
  });

  it('maps an unknown carrier to unknown delivery', () => {
    const mapped = mapPrestashopOrder(awaitingOrder(), CONFIG);
    expect(mapped.deliveryMethod).toBe('unknown');
    expect(mapped.shippingLine).toEqual({ code: '9', title: 'Demo international post' });
    const missing = clone(awaitingOrder());
    missing.carrier = null;
    const without = mapPrestashopOrder(missing, CONFIG);
    expect(without.deliveryMethod).toBe('unknown');
    expect(without.shippingLine).toBeNull();
  });

  it('normalises money to 2 decimal places and subtracts tax', () => {
    const paidMapped = mapPrestashopOrder(paidOrder(), CONFIG);
    expect(paidMapped.currency).toBe('EUR');
    expect(paidMapped.lines).toEqual([
      {
        externalLineId: '901',
        sku: 'DEMO-OIL',
        title: 'Olive oil tin',
        variantTitle: null,
        quantity: '2.0000',
        unitPrice: '20.00',
        total: '40.00',
      },
      {
        externalLineId: '902',
        sku: 'DEMO-HONEY',
        title: 'Honey jar',
        variantTitle: null,
        quantity: '1.0000',
        unitPrice: '5.50',
        total: '5.50',
      },
    ]);
    expect(paidMapped.subtotal).toBe('45.50');
    expect(paidMapped.shippingTotal).toBe('6.00');
    expect(paidMapped.taxTotal).toBe('8.22');
    expect(paidMapped.total).toBe('51.50');

    const trailing = clone(paidOrder());
    trailing.order.total_products_wt = '45.000000';
    expect(mapPrestashopOrder(trailing, CONFIG).subtotal).toBe('45.00');

    const awaitingMapped = mapPrestashopOrder(awaitingOrder(), CONFIG);
    expect(awaitingMapped.lines).toEqual([
      {
        externalLineId: '903',
        sku: null,
        title: 'Tea tin',
        variantTitle: null,
        quantity: '3.0000',
        unitPrice: '10.13',
        total: '30.38',
      },
    ]);
    expect(awaitingMapped.subtotal).toBe('30.38');
    expect(awaitingMapped.shippingTotal).toBe('12.00');
    expect(awaitingMapped.taxTotal).toBe('7.38');
    expect(awaitingMapped.total).toBe('42.38');

    const lower = clone(paidOrder());
    if (lower.currency === null) {
      throw new Error('currency missing');
    }
    lower.currency = { id: '1', iso_code: 'eur' };
    expect(mapPrestashopOrder(lower, CONFIG).currency).toBe('EUR');
  });

  it('rounds each line from the unrounded unit price so the lines sum to the shop subtotal', () => {
    const order = clone(paidOrder());
    order.order.rows = [
      {
        id: '911',
        product_id: '21',
        product_attribute_id: '0',
        product_reference: 'DEMO-TIN',
        product_name: 'Demo tin',
        product_quantity: '2',
        unit_price_tax_incl: '19.995000',
      },
      {
        id: '912',
        product_id: '22',
        product_attribute_id: '0',
        product_reference: 'DEMO-JAR',
        product_name: 'Demo jar',
        product_quantity: '3',
        unit_price_tax_incl: '10.126000',
      },
    ];
    order.order.total_products_wt = '70.370000';
    const mapped = mapPrestashopOrder(order, CONFIG);
    const first = mapped.lines[0];
    const second = mapped.lines[1];
    if (first === undefined || second === undefined) {
      throw new Error('lines missing');
    }
    expect(first.unitPrice).toBe('20.00');
    expect(second.unitPrice).toBe('10.13');
    expect(first.total).toBe('39.99');
    expect(second.total).toBe('30.38');
    expect(money(parseAmount(first.total, 2).plus(parseAmount(second.total, 2)))).toBe(
      mapped.subtotal,
    );
    expect(mapped.subtotal).toBe('70.37');
  });

  it('maps a numeric id and current_state like the string order', async () => {
    const loaded = await loadPayloads(awaitingWithNumericIdentity());
    expect(loaded.awaiting.order.id).toBe('502');
    expect(loaded.awaiting.order.current_state).toBe('10');
    expect(mapPrestashopOrder(loaded.awaiting, CONFIG)).toEqual(
      mapPrestashopOrder(awaitingOrder(), CONFIG),
    );
  });

  it('converts shop wall time, including an ambiguous and a skipped Nicosia hour', () => {
    const mapped = mapPrestashopOrder(paidOrder(), CONFIG);
    expect(mapped.sourceCreatedAt.toISOString()).toBe('2026-06-15T11:30:00.000Z');
    expect(mapped.sourceUpdatedAt.toISOString()).toBe('2026-06-15T13:45:00.000Z');
    const winter = mapPrestashopOrder(awaitingOrder(), CONFIG);
    expect(winter.sourceCreatedAt.toISOString()).toBe('2026-01-20T07:15:00.000Z');

    const dst = clone(paidOrder());
    dst.order.date_add = '2026-10-25 03:30:00';
    dst.order.date_upd = '2026-03-29 03:30:00';
    const shifted = mapPrestashopOrder(dst, CONFIG);
    expect(shifted.sourceCreatedAt.toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(shifted.sourceUpdatedAt.toISOString()).toBe('2026-03-29T01:00:00.000Z');
  });

  it('rejects an invalid payload and a missing currency', () => {
    const invalid = mapError({ schema: 'prestashop.order.v1' });
    expect(invalid).toBeInstanceOf(PrestashopMapError);
    expect((invalid as PrestashopMapError).message).toBe('prestashop_payload_invalid');
    expect(() => readPrestashopEventIdentity({}, 'Asia/Nicosia')).toThrow(PrestashopMapError);

    const missing = clone(paidOrder());
    missing.currency = null;
    const error = mapError(missing);
    expect(error).toBeInstanceOf(PrestashopMapError);
    expect((error as PrestashopMapError).message).toBe('prestashop_currency_missing');
  });

  it('reads the event identity from the shop clock', () => {
    expect(readPrestashopEventIdentity(paidOrder(), 'Asia/Nicosia')).toEqual({
      externalId: '501',
      sourceUpdatedAt: new Date('2026-06-15T13:45:00.000Z'),
    });
    const skipped = clone(paidOrder());
    skipped.order.date_upd = '2026-03-29 03:30:00';
    expect(readPrestashopEventIdentity(skipped, 'Asia/Nicosia').sourceUpdatedAt.toISOString()).toBe(
      '2026-03-29T01:00:00.000Z',
    );
  });

  it('fills the party fields the order screen reads', () => {
    const mapped = mapPrestashopOrder(paidOrder(), CONFIG);
    expect(mapped.externalId).toBe('501');
    expect(mapped.externalNumber).toBe('DEMOA501');
    expect(mapped.paymentStatus).toBe('paid');
    expect(mapped.sourceStatus).toEqual({
      displayFulfillmentStatus: 'Paid demo',
      cancelledAt: null,
    });
    expect(mapped.deliveryMethod).toBe('courier_cy');
    expect(mapped.shippingLine).toEqual({ code: '2', title: 'Demo courier' });
    expect(mapped.customer).toEqual({
      id: '301',
      displayName: 'Eleni Charalambous',
      email: 'eleni.charalambous@example.test',
      phone: '+35799000501',
    });
    expect(mapped.recipient).toEqual({
      name: 'Eleni Charalambous',
      firstName: 'Eleni',
      lastName: 'Charalambous',
      company: null,
      address1: '12 Demo Street',
      address2: null,
      city: 'Nicosia',
      zip: '9990',
      province: null,
      country: 'Cyprus',
      countryCode: 'CY',
      phone: '+35799000501',
    });
    expect(mapped.billingAddress).toEqual({
      name: 'Eleni Charalambous',
      firstName: 'Eleni',
      lastName: 'Charalambous',
      company: 'Demo Gifts',
      address1: '4 Warehouse Lane',
      address2: 'Unit B',
      city: 'Nicosia',
      zip: '9991',
      province: null,
      country: 'Cyprus',
      countryCode: 'CY',
      phone: '+35799000502',
    });

    const abroad = mapPrestashopOrder(awaitingOrder(), CONFIG);
    expect(abroad.paymentStatus).toBe('pending');
    expect(abroad.customer.phone).toBe('+30199000502');
    expect(abroad.recipient).toMatchObject({
      city: 'Athens',
      country: 'Greece',
      countryCode: 'GR',
      address2: 'Floor 2',
      phone: '+30199000502',
    });
  });
});

describe('buildPrestashopOrderPayload', () => {
  it('copies the gift message unchanged and matches the payload schema', () => {
    const order = paidOrder();
    expect(prestashopOrderPayloadSchema.safeParse(order).success).toBe(true);
    expect(prestashopOrderPayloadSchema.safeParse(awaitingOrder()).success).toBe(true);
    expect(
      Buffer.compare(Buffer.from(order.order.gift_message, 'utf8'), Buffer.from(GIFT, 'utf8')),
    ).toBe(0);
    expect(order.order.total_paid_tax_incl).toBe('51.500000');
    expect(awaitingOrder().order.gift_message).toBe('');
    expect(prestashopFixturesDirectory().endsWith('/prestashop/fixtures')).toBe(true);
    expect(readFileSync(resolve(prestashopFixturesDirectory(), 'README.md'), 'utf8')).toContain(
      'modelled on PrestaShop 1.7.7 JSON output; checked against the live shop at R1-H',
    );
  });
});

function paidOrder(): PrestashopOrderPayload {
  if (paid === undefined) {
    throw new Error('fixtures were not loaded');
  }
  return paid;
}

function awaitingOrder(): PrestashopOrderPayload {
  if (awaiting === undefined) {
    throw new Error('fixtures were not loaded');
  }
  return awaiting;
}

function clone(payload: PrestashopOrderPayload): PrestashopOrderPayload {
  const parsed: unknown = JSON.parse(JSON.stringify(payload));
  return prestashopOrderPayloadSchema.parse(parsed);
}

function mapError(payload: unknown): unknown {
  try {
    mapPrestashopOrder(payload, CONFIG);
    return null;
  } catch (error) {
    return error;
  }
}

function giftFromFixture(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(prestashopFixturesDirectory(), 'orders-page-1.json'), 'utf8'),
  );
  if (!isRecord(parsed) || !isUnknownArray(parsed['orders'])) {
    throw new Error('orders fixture missing');
  }
  const order = parsed['orders'][0];
  if (!isRecord(order) || typeof order['gift_message'] !== 'string') {
    throw new Error('gift message missing');
  }
  return order['gift_message'];
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function awaitingWithNumericIdentity(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(prestashopFixturesDirectory(), 'orders-page-1.json'), 'utf8'),
  );
  if (!isRecord(parsed) || !isUnknownArray(parsed['orders'])) {
    throw new Error('orders fixture missing');
  }
  const order = parsed['orders'][1];
  if (!isRecord(order)) {
    throw new Error('second order missing');
  }
  order['id'] = 502;
  order['current_state'] = 10;
  return JSON.stringify(parsed);
}

async function loadPayloads(ordersBody?: string): Promise<{
  paid: PrestashopOrderPayload;
  awaiting: PrestashopOrderPayload;
}> {
  const server = await listen((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    req.resume();
    if (pathname === '/api/orders' && ordersBody !== undefined) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(ordersBody);
      return;
    }
    const name = FIXTURES[pathname];
    if (name === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(readFileSync(resolve(prestashopFixturesDirectory(), name)));
  });
  try {
    const client = createPrestashopClient({
      fetch: createSafeFetch({ appEnv: 'test', allowLoopbackForTests: true }),
      baseUrl: server.origin,
      apiKey: KEY,
    });
    const orders = await client.listOrdersUpdatedBetween({
      from: '2026-01-01 00:00:00',
      to: '2026-12-31 23:59:59',
      offset: 0,
      limit: 50,
    });
    const first = orders[0];
    const second = orders[1];
    if (first === undefined || second === undefined) {
      throw new Error('fixture orders missing');
    }
    const lookups = {
      customers: await client.getCustomers([first.id_customer, second.id_customer]),
      addresses: await client.getAddresses([
        first.id_address_delivery,
        first.id_address_invoice,
        second.id_address_delivery,
      ]),
      countries: await client.getCountries(['101', '102']),
      carriers: await client.getCarriers([first.id_carrier, second.id_carrier]),
      currencies: await client.getCurrencies([first.id_currency, second.id_currency]),
      states: await client.getOrderStates(),
    };
    return {
      paid: buildPrestashopOrderPayload(first, lookups),
      awaiting: buildPrestashopOrderPayload(second, lookups),
    };
  } finally {
    await server.close();
  }
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    try {
      handler(req, res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    }
  });
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('missing port');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () => closeServer(server, sockets),
  };
}

async function closeServer(
  server: { listening: boolean; close(callback: (error?: Error) => void): void },
  sockets: Set<Socket>,
): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolveClose();
      }
    });
  });
}
