import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectFailure } from '../http/errors';
import { createSafeFetch } from '../http/safe-fetch';
import { prestashopFixturesDirectory } from './map-order';
import {
  PrestashopAuthFailed,
  PrestashopBadResponse,
  createPrestashopClient,
  type PrestashopClient,
} from './client';

const KEY = '0123456789abcdef0123456789abcdef';
const BASIC = `Basic ${Buffer.from(`${KEY}:`, 'utf8').toString('base64')}`;
const PAGE = {
  from: '2026-01-01 00:00:00',
  to: '2026-12-31 23:59:59',
  offset: 0,
  limit: 50,
} as const;

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('createPrestashopClient', () => {
  it('requests each resource with the decoded query and Basic auth', async () => {
    const seen: Seen[] = [];
    const client = await clientFor((req, res) => {
      seen.push(capture(req));
      req.resume();
      json(res, 200, []);
    });
    expect(KEY).toHaveLength(32);
    await expect(client.ping()).resolves.toBe(true);
    await expect(
      client.listOrdersUpdatedBetween({
        from: '2026-01-01 00:00:00',
        to: '2026-12-31 23:59:59',
        offset: 10,
        limit: 25,
      }),
    ).resolves.toEqual([]);
    await expect(client.getCustomers(['301', '302'])).resolves.toEqual([]);
    await expect(client.getAddresses(['401'])).resolves.toEqual([]);
    await expect(client.getCountries(['101', '102'])).resolves.toEqual([]);
    await expect(client.getCarriers(['7'])).resolves.toEqual([]);
    await expect(client.getCurrencies(['1'])).resolves.toEqual([]);
    await expect(client.getOrderStates()).resolves.toEqual([]);

    expect(seen.map((entry) => entry.pathname)).toEqual([
      '/api/orders',
      '/api/orders',
      '/api/customers',
      '/api/addresses',
      '/api/countries',
      '/api/carriers',
      '/api/currencies',
      '/api/order_states',
    ]);
    for (const entry of seen) {
      assertSafeRequest(entry);
    }
    expect(seen[0]?.params).toEqual({ display: '[id]', limit: '1' });
    expect(seen[1]?.params).toEqual({
      display: 'full',
      date: '1',
      'filter[date_upd]': '[2026-01-01 00:00:00,2026-12-31 23:59:59]',
      sort: '[date_upd_ASC,id_ASC]',
      limit: '10,25',
    });
    expect(seen[2]?.params).toEqual({
      display: '[id,firstname,lastname,email]',
      'filter[id]': '[301|302]',
    });
    expect(seen[2]?.params['display']).not.toContain('passwd');
    expect(seen[2]?.params['display']).not.toContain('secure_key');
    expect(seen[3]?.params).toEqual({
      display:
        '[id,firstname,lastname,company,address1,address2,postcode,city,id_country,id_state,phone,phone_mobile]',
      'filter[id]': '[401]',
    });
    expect(seen[4]?.params).toEqual({
      display: '[id,iso_code,name]',
      'filter[id]': '[101|102]',
    });
    expect(seen[5]?.params).toEqual({
      display: '[id,id_reference,name]',
      'filter[id]': '[7]',
    });
    expect(seen[6]?.params).toEqual({
      display: '[id,iso_code]',
      'filter[id]': '[1]',
    });
    expect(seen[7]?.params).toEqual({ display: '[id,name]' });
    expect(seen[7]?.params['filter[id]']).toBeUndefined();
  });

  it('reads the fictional page, keeps strings and drops secrets', async () => {
    const client = await clientFor((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      req.resume();
      const file = FIXTURES[pathname];
      if (file === undefined) {
        json(res, 404, []);
        return;
      }
      sendFile(res, file);
    });
    const orders = await client.listOrdersUpdatedBetween({
      from: '2026-01-01 00:00:00',
      to: '2026-12-31 23:59:59',
      offset: 0,
      limit: 50,
    });
    expect(orders).toHaveLength(2);
    const paid = orders[0];
    const awaiting = orders[1];
    if (paid === undefined || awaiting === undefined) {
      throw new Error('fixture orders missing');
    }
    const fixtureGift = giftFromFixture();
    expect(
      Buffer.compare(Buffer.from(paid.gift_message, 'utf8'), Buffer.from(fixtureGift, 'utf8')),
    ).toBe(0);
    expect(paid.rows).toHaveLength(2);
    expect(paid.id).toBe('501');
    expect(paid.current_state).toBe('2');
    expect(paid.gift).toBe('1');
    expect(paid.id_customer).toBe('301');
    expect(paid.total_paid_tax_incl).toBe('51.500000');
    const oil = paid.rows[0];
    if (oil === undefined) {
      throw new Error('fixture row missing');
    }
    expect(oil.id).toBe('901');
    expect(oil.product_quantity).toBe('2');
    expect(oil.unit_price_tax_incl).toBe('20.000000');
    expect(awaiting.id).toBe('502');
    expect(awaiting.current_state).toBe('10');
    expect(awaiting.gift_message).toBe('');
    expect(JSON.stringify(orders)).not.toContain('fixture-not-a-secret');
    expect(JSON.stringify(orders)).not.toContain('16.806723');

    const customers = await client.getCustomers([paid.id_customer, awaiting.id_customer]);
    expect(customers).toEqual([
      {
        id: '301',
        firstname: 'Eleni',
        lastname: 'Charalambous',
        email: 'eleni.charalambous@example.test',
      },
      {
        id: '302',
        firstname: 'Jonas',
        lastname: 'Meier',
        email: 'jonas.meier@example.test',
      },
    ]);
    expect(JSON.stringify(customers)).not.toContain('fixture-not-a-password');
    expect(JSON.stringify(customers)).not.toContain('fixture-not-a-customer-secret');

    const countries = await client.getCountries(['101', '102']);
    expect(countries).toEqual([
      { id: '101', iso_code: 'CY', name: 'Cyprus' },
      { id: '102', iso_code: 'GR', name: 'Greece' },
    ]);
    const states = await client.getOrderStates();
    expect(states).toEqual([
      { id: '2', name: 'Paid demo' },
      { id: '10', name: 'Awaiting payment demo' },
    ]);
    const carriers = await client.getCarriers(['7', '8']);
    expect(carriers).toEqual([
      { id: '7', id_reference: '2', name: 'Demo courier' },
      { id: '8', id_reference: '9', name: 'Demo international post' },
    ]);
  });

  it('accepts a numeric order id', async () => {
    const client = await clientFor((req, res) => {
      req.resume();
      json(res, 200, { orders: [{ id: 501 }] });
    });
    await expect(client.ping()).resolves.toBe(true);
  });

  it('keeps an integer money amount as a string and rejects a numeric gift message', async () => {
    const accepted = ordersFixture();
    firstOrder(accepted)['total_shipping_tax_incl'] = 12;
    const client = await clientFor((req, res) => {
      req.resume();
      json(res, 200, accepted);
    });
    const orders = await client.listOrdersUpdatedBetween(PAGE);
    expect(orders[0]?.total_shipping_tax_incl).toBe('12');
    expect(orders[0]?.gift_message).toBe(giftFromFixture());

    const gift = ordersFixture();
    firstOrder(gift)['gift_message'] = 1;
    const giftClient = await clientFor((req, res) => {
      req.resume();
      json(res, 200, gift);
    });
    const giftError = await settle(giftClient.listOrdersUpdatedBetween(PAGE));
    expect(giftError).toBeInstanceOf(PrestashopBadResponse);
    expect((giftError as PrestashopBadResponse).status).toBe(200);
    expect((giftError as Error).message).toBe('prestashop_bad_response');
  });

  it('reads a JSON number from its original token', () => {
    let source: unknown;
    JSON.parse('4503599627370495.99', (_key, value, context?: { source?: unknown }) => {
      if (typeof value === 'number') {
        source = context?.source;
      }
      return null;
    });
    expect(typeof source).toBe('string');
    expect(source).toBe('4503599627370495.99');
  });

  it('keeps exact decimal tokens, rejects an exponent, and leaves strings unchanged', async () => {
    const source = ordersFixtureText();
    const numbers = source
      .replace('"total_paid_tax_incl": "51.500000"', '"total_paid_tax_incl": 4503599627370495.99')
      .replace('"product_quantity": 2', '"product_quantity": 0.0000001');
    const parsed = await readOrders(numbers);
    expect(parsed[0]?.total_paid_tax_incl).toBe('4503599627370495.99');
    expect(parsed[0]?.rows[0]?.product_quantity).toBe('0.0000001');

    const exponent = await settle(
      readOrders(source.replace('"product_quantity": 2', '"product_quantity": 1e-7')),
    );
    expect(exponent).toBeInstanceOf(PrestashopBadResponse);
    expect((exponent as PrestashopBadResponse).status).toBe(200);
    expect((exponent as Error).message).toBe('prestashop_bad_response');

    const strings = source
      .replace('"total_paid_tax_incl": "51.500000"', '"total_paid_tax_incl": "4503599627370495.99"')
      .replace('"product_quantity": 2', '"product_quantity": "0.0000001"');
    const text = await readOrders(strings);
    expect(text[0]?.total_paid_tax_incl).toBe('4503599627370495.99');
    expect(text[0]?.rows[0]?.product_quantity).toBe('0.0000001');

    const exponentText = await readOrders(
      source.replace('"product_quantity": 2', '"product_quantity": "1e-7"'),
    );
    expect(exponentText[0]?.rows[0]?.product_quantity).toBe('1e-7');
  });

  it('keeps an optional shop path and rejects a base URL that is not a plain https shop', async () => {
    for (const baseUrl of ['https://shop.example.test', 'https://shop.example.test/']) {
      expect(await pingPath(baseUrl)).toBe('/api/orders');
    }
    for (const baseUrl of [
      'https://shop.example.test/prestashop',
      'https://shop.example.test/prestashop/',
    ]) {
      expect(await pingPath(baseUrl)).toBe('/prestashop/api/orders');
    }
    for (const baseUrl of ['https://shop.example.test/x', 'https://shop.example.test/x/']) {
      expect(await pingPath(baseUrl)).toBe('/x/api/orders');
    }

    const samples = [
      'https://shop.example.test/prestashop?display=full',
      'https://shop.example.test/prestashop#orders',
      'https://user:secret@shop.example.test/prestashop',
      'http://shop.example.test/prestashop',
      'https://shop.example.test/prestashop/../admin',
      'https://shop.example.test/prestashop/%2e%2e/admin',
      'https://shop.example.test/prestashop\\../admin',
      ' https://shop.example.test/prestashop/../admin',
      'https://shop.example.test/prestashop/.\t./admin',
      'HTTPS://Shop.example.test/x',
      'https://shop.example.test:443/x',
    ];
    for (const baseUrl of samples) {
      let calls = 0;
      let rejected: unknown;
      try {
        createPrestashopClient({
          fetch: () => {
            calls += 1;
            return Promise.reject(new Error('should not run'));
          },
          baseUrl,
          apiKey: KEY,
        });
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeInstanceOf(Error);
      const message = (rejected as Error).message;
      expect(message).toBe('prestashop_base_url_invalid');
      expect(message).not.toContain(baseUrl);
      expect(message).not.toContain('shop.example.test');
      expect(message).not.toContain('secret');
      expect(calls).toBe(0);
    }
  });

  it('treats [] as an empty list', async () => {
    const body = readFileSync(resolve(prestashopFixturesDirectory(), 'orders-empty.json'), 'utf8');
    expect(JSON.parse(body)).toEqual([]);
    const client = await clientFor((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    await expect(
      client.listOrdersUpdatedBetween({
        from: '2026-06-01 00:00:00',
        to: '2026-06-02 00:00:00',
        offset: 0,
        limit: 50,
      }),
    ).resolves.toEqual([]);
  });

  it('chunks ids at 100 and drops duplicates', async () => {
    const filters: string[] = [];
    const displays: string[] = [];
    const client = await clientFor((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      filters.push(url.searchParams.get('filter[id]') ?? '');
      displays.push(url.searchParams.get('display') ?? '');
      assertSafeRequest(capture(req));
      req.resume();
      json(res, 200, []);
    });
    const hundred = Array.from({ length: 100 }, (_, index) => String(index + 1));
    await client.getCustomers([...hundred, '1']);
    expect(filters).toEqual([`[${hundred.join('|')}]`]);
    expect(displays).toEqual(['[id,firstname,lastname,email]']);

    filters.length = 0;
    displays.length = 0;
    await client.getCustomers([...hundred, '101', '50']);
    expect(filters).toEqual([`[${hundred.join('|')}]`, '[101]']);
    expect(idsOf(filters[0] ?? '')).toHaveLength(100);
    expect(idsOf(filters[1] ?? '')).toEqual(['101']);

    filters.length = 0;
    await client.getAddresses(['3', '1', '3', '2']);
    expect(filters).toEqual(['[3|1|2]']);

    const before = filters.length;
    await expect(client.getCustomers([])).resolves.toEqual([]);
    expect(filters).toHaveLength(before);
  });

  it('reads a numeric language id as the first value', async () => {
    const client = await clientFor((req, res) => {
      req.resume();
      json(res, 200, {
        countries: [{ id: '101', iso_code: 'CY', name: [{ id: 1, value: 'Cyprus' }] }],
      });
    });
    await expect(client.getCountries(['101'])).resolves.toEqual([
      { id: '101', iso_code: 'CY', name: 'Cyprus' },
    ]);
  });

  it('uses a 20 second timeout unless one is given', async () => {
    const seen: number[] = [];
    const server = await listen((req, res) => {
      req.resume();
      json(res, 200, []);
    });
    const inner = createSafeFetch({ appEnv: 'test', allowLoopbackForTests: true });
    const client = createPrestashopClient({
      fetch: (url, request) => {
        seen.push(request?.timeoutMs ?? -1);
        return inner(url, request);
      },
      baseUrl: `${server.origin}/`,
      apiKey: KEY,
    });
    await client.ping();
    const custom = createPrestashopClient({
      fetch: (url, request) => {
        seen.push(request?.timeoutMs ?? -1);
        return inner(url, request);
      },
      baseUrl: server.origin,
      apiKey: KEY,
      timeoutMs: 5_000,
    });
    await custom.ping();
    expect(seen).toEqual([20_000, 5_000]);
  });

  it('fails auth on 401 and 403, and rejects any other bad response without the key', async () => {
    const auth = await callStatus(401, { message: KEY });
    expect(auth).toBeInstanceOf(PrestashopAuthFailed);
    expect((auth as Error).message).toBe('prestashop_auth_failed');
    assertHidden(auth, KEY);

    const forbidden = await callText(403, KEY);
    expect(forbidden).toBeInstanceOf(PrestashopAuthFailed);
    assertHidden(forbidden, KEY);

    const bad = await callStatus(500, { errors: [{ message: KEY }] });
    expect(bad).toBeInstanceOf(PrestashopBadResponse);
    expect((bad as PrestashopBadResponse).status).toBe(500);
    expect((bad as Error).message).toBe('prestashop_bad_response');
    assertHidden(bad, KEY);

    const garbled = await callText(200, KEY);
    expect(garbled).toBeInstanceOf(PrestashopBadResponse);
    expect((garbled as PrestashopBadResponse).status).toBe(200);
    assertHidden(garbled, KEY);
  });

  it('lets a transport error through and rejects a bad id before calling the shop', async () => {
    const closed = await closedPort();
    const offline = createPrestashopClient({
      fetch: createSafeFetch({ appEnv: 'test', allowLoopbackForTests: true }),
      baseUrl: `http://127.0.0.1:${String(closed)}`,
      apiKey: KEY,
    });
    const network = await settle(offline.ping());
    expect(network).toBeInstanceOf(ConnectFailure);
    expect(network).not.toBeInstanceOf(PrestashopBadResponse);
    assertHidden(network, KEY);

    let requests = 0;
    const client = await clientFor((req, res) => {
      requests += 1;
      req.resume();
      json(res, 200, []);
    });
    const invalidId = await settle(client.getCustomers([KEY]));
    expect(invalidId).toBeInstanceOf(Error);
    expect((invalidId as Error).message).toBe('prestashop_id_invalid');
    expect(requests).toBe(0);
    assertHidden(invalidId, KEY);

    let calls = 0;
    let rejected: unknown;
    try {
      createPrestashopClient({
        fetch: () => {
          calls += 1;
          return Promise.reject(new Error('should not run'));
        },
        baseUrl: 'https://shop.example.test',
        apiKey: `${KEY}extra`,
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toBe('prestashop_api_key_invalid');
    expect(calls).toBe(0);
    assertHidden(rejected, KEY);
  });
});

const FIXTURES: Record<string, string> = {
  '/api/orders': 'orders-page-1.json',
  '/api/customers': 'customers.json',
  '/api/countries': 'countries.json',
  '/api/carriers': 'carriers.json',
  '/api/order_states': 'order-states.json',
};

type Seen = {
  method: string | undefined;
  pathname: string;
  params: Record<string, string>;
  authorization: string | undefined;
  outputFormat: string | string[] | undefined;
  raw: string;
};

function ordersFixtureText(): string {
  return readFileSync(resolve(prestashopFixturesDirectory(), 'orders-page-1.json'), 'utf8');
}

function ordersFixture(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(ordersFixtureText());
  if (!isRecord(parsed)) {
    throw new Error('orders fixture missing');
  }
  return parsed;
}

function firstOrder(body: Record<string, unknown>): Record<string, unknown> {
  const orders = body['orders'];
  if (!isUnknownArray(orders) || !isRecord(orders[0])) {
    throw new Error('orders fixture missing');
  }
  return orders[0];
}

async function pingPath(baseUrl: string): Promise<string> {
  let pathname = '';
  const client = createPrestashopClient({
    fetch: (url) => {
      const href = url instanceof URL ? url.href : url;
      pathname = new URL(href).pathname;
      return Promise.resolve({
        status: 200,
        headers: {},
        body: Buffer.from('[]'),
        url: href,
      });
    },
    baseUrl,
    apiKey: KEY,
  });
  await client.ping();
  return pathname;
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

function idsOf(filter: string): string[] {
  return filter.slice(1, -1).split('|');
}

function assertSafeRequest(entry: Seen): void {
  expect(entry.method).toBe('GET');
  expect(entry.authorization).toBe(BASIC);
  expect(entry.outputFormat).toBe('JSON');
  expect(entry.raw.toLowerCase()).not.toContain('ws_key');
  expect(entry.raw.toLowerCase()).not.toContain('output_format');
  expect(entry.raw).not.toContain(KEY);
}

function capture(req: IncomingMessage): Seen {
  const raw = req.url ?? '';
  const url = new URL(raw, 'http://127.0.0.1');
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    params[key] = value;
  }
  return {
    method: req.method,
    pathname: url.pathname,
    params,
    authorization: req.headers.authorization,
    outputFormat: req.headers['output-format'],
    raw,
  };
}

async function callStatus(status: number, body: unknown): Promise<unknown> {
  const client = await clientFor((req, res) => {
    req.resume();
    json(res, status, body);
  });
  return settle(client.ping());
}

async function callText(status: number, body: string): Promise<unknown> {
  const client = await clientFor((req, res) => {
    req.resume();
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(body);
  });
  return settle(client.ping());
}

async function readOrders(body: string) {
  const client = await clientFor((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  return client.listOrdersUpdatedBetween(PAGE);
}

async function clientFor(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<PrestashopClient> {
  const server = await listen(handler);
  return createPrestashopClient({
    fetch: createSafeFetch({ appEnv: 'test', allowLoopbackForTests: true }),
    baseUrl: `${server.origin}/`,
    apiKey: KEY,
  });
}

function sendFile(res: ServerResponse, name: string): void {
  const body = readFileSync(resolve(prestashopFixturesDirectory(), name));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function settle(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return null;
  } catch (error) {
    return error;
  }
}

function assertHidden(error: unknown, secret: string): void {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || depth > 6) {
      return;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      expect(String(value)).not.toContain(secret);
      return;
    }
    if (typeof value !== 'object') {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    if (value instanceof Error) {
      expect(value.message).not.toContain(secret);
      expect(value.stack ?? '').not.toContain(secret);
    }
    for (const name of Object.getOwnPropertyNames(value)) {
      visit((value as Record<string, unknown>)[name], depth + 1);
    }
  };
  visit(error, 0);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ origin: string }> {
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
  closers.push(() => closeServer(server, sockets));
  return { origin: `http://127.0.0.1:${String(address.port)}` };
}

async function closedPort(): Promise<number> {
  const server = createNetServer();
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
  await closeServer(server, new Set());
  return address.port;
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
