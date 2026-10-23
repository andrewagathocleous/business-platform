import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectFailure, SafeFetchError } from '../http/errors';
import { createSafeFetch } from '../http/safe-fetch';
import { PrintNodeProvider } from './printnode';
import { ProviderRejected, ProviderUncertain, type PrintSubmitInput } from './provider';

const SECRET = 'pn-secret-key-9f3c1a';
const COMPANY = '01932a1e-7b4c-7c2a-8e10-111111111111';

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('PrintNodeProvider', () => {
  it('maps printers and sends the API key as HTTP Basic', async () => {
    const seen: { authorization?: string } = {};
    const provider = await providerFor((req, res) => {
      seen.authorization = req.headers.authorization;
      json(res, 200, [
        {
          id: 1001,
          name: 'Zebra ZD230',
          state: 'online',
          computer: { name: 'Shop PC' },
          capabilities: { papers: { A6: [105, 148], '100x150mm': { width: 100 } } },
        },
        { id: 1002, name: 'HP LaserJet', state: 'disconnected', computer: { name: '' } },
        { id: 1003, name: 'Unknown', state: '' },
        { id: 1004, name: 'No state' },
      ]);
    });
    const listed = await provider.listPrinters({ companyId: COMPANY });
    expect(seen.authorization).toBe(`Basic ${Buffer.from(`${SECRET}:`).toString('base64')}`);
    expect(listed).toEqual([
      {
        externalPrinterId: '1001',
        name: 'Zebra ZD230',
        description: 'Shop PC',
        paperSizes: ['A6', '100x150mm'],
        status: 'online',
      },
      {
        externalPrinterId: '1002',
        name: 'HP LaserJet',
        description: '',
        paperSizes: [],
        status: 'offline',
      },
      {
        externalPrinterId: '1003',
        name: 'Unknown',
        description: '',
        paperSizes: [],
        status: 'unknown',
      },
      {
        externalPrinterId: '1004',
        name: 'No state',
        description: '',
        paperSizes: [],
        status: 'unknown',
      },
    ]);
  });

  it('posts the PDF, the idempotency key and the job options', async () => {
    const pdf = Buffer.from('%PDF-1.4 printnode');
    const seen: { headers: IncomingMessage['headers']; body: string } = { headers: {}, body: '' };
    const provider = await providerFor(async (req, res) => {
      seen.headers = req.headers;
      seen.body = await readBody(req);
      json(res, 201, 77);
    });
    const submitted = await provider.submit(submitInput(pdf));
    expect(submitted).toEqual({ providerJobId: '77' });
    expect(seen.headers['x-idempotency-key']).toBe('pj_job');
    expect(seen.headers['content-type']).toBe('application/json');
    expect(JSON.parse(seen.body)).toEqual({
      printerId: 1001,
      title: 'gift message',
      contentType: 'pdf_base64',
      content: pdf.toString('base64'),
      source: 'business-platform',
      options: { copies: 2, paper: 'A6' },
      expireAfter: 86400,
    });
    expect(JSON.stringify(submitted)).not.toContain(SECRET);
  });

  it('maps submit statuses and hides the API key', async () => {
    await expectRejected(400, 'bad_request');
    await expectRejected(401, 'auth_failed');
    await expectRejected(403, 'auth_failed');
    await expectRejected(404, 'printer_not_found');
    await expectRejected(429, 'rate_limited');
    await expectUncertain(409, 'idempotency_collision');
    await expectUncertain(500, 'provider_status_500');
    await expectUncertain(201, 'bad_response', { leaked: SECRET });
  });

  it('treats a hang after connect as uncertain and a closed port as unreachable', async () => {
    const hanging = await listen((req) => {
      req.resume();
    });
    const hung = await settle(
      client(hanging.origin, { timeoutMs: 200 }).submit(submitInput(Buffer.from('%PDF'))),
    );
    expect(hung).toBeInstanceOf(ProviderUncertain);
    assertKeyHidden(hung, SECRET);

    const closed = await closedPort();
    const refused = await settle(
      client(`http://127.0.0.1:${String(closed)}`).submit(submitInput(Buffer.from('%PDF'))),
    );
    expect(refused).toBeInstanceOf(ProviderRejected);
    expect((refused as ProviderRejected).message).toBe('provider_unreachable');
    assertKeyHidden(refused, SECRET);
  });

  it('rejects a non-numeric printer id before any request', async () => {
    let requests = 0;
    const provider = await providerFor((req, res) => {
      requests += 1;
      req.resume();
      json(res, 201, 1);
    });
    const error = await settle(provider.submit(submitInput(Buffer.from('%PDF'), 'not-a-printer')));
    expect(error).toBeInstanceOf(ProviderRejected);
    expect((error as ProviderRejected).message).toBe('bad_request');
    expect(requests).toBe(0);
    assertKeyHidden(error, SECRET);
  });

  it('turns a credential load failure into credential_unavailable before any request', async () => {
    let requests = 0;
    const secret = 'decrypt failed: pn-secret-key-value';
    const server = await listen((req, res) => {
      requests += 1;
      req.resume();
      json(res, 201, 1);
    });
    const provider = new PrintNodeProvider({
      fetch: createSafeFetch({ appEnv: 'test', allowLoopbackForTests: true }),
      apiKeyFor: () => Promise.reject(new Error(secret)),
      baseUrl: server.origin,
    });
    const submitted = await settle(provider.submit(submitInput(Buffer.from('%PDF'))));
    expect(submitted).toBeInstanceOf(ProviderRejected);
    expect((submitted as ProviderRejected).message).toBe('credential_unavailable');
    assertKeyHidden(submitted, secret);

    const listed = await settle(provider.listPrinters({ companyId: COMPANY }));
    expect(listed).toBeInstanceOf(ProviderRejected);
    expect((listed as ProviderRejected).message).toBe('credential_unavailable');
    assertKeyHidden(listed, secret);

    const state = await settle(provider.getJobState({ companyId: COMPANY, providerJobId: '42' }));
    expect(state).toBeInstanceOf(ProviderRejected);
    expect((state as ProviderRejected).message).toBe('credential_unavailable');
    assertKeyHidden(state, secret);
    expect(requests).toBe(0);

    const rejected = new ProviderRejected('not_configured');
    const passthrough = new PrintNodeProvider({
      fetch: createSafeFetch({ appEnv: 'test', allowLoopbackForTests: true }),
      apiKeyFor: () => Promise.reject(rejected),
      baseUrl: server.origin,
    });
    expect(await settle(passthrough.submit(submitInput(Buffer.from('%PDF'))))).toBe(rejected);
    expect(requests).toBe(0);
  });

  it('maps job states from both body shapes and keeps the latest matching one', async () => {
    const cases: { body: unknown; expected: unknown }[] = [
      { body: [state('new')], expected: { state: 'pending', raw: 'new' } },
      {
        body: [[state('sent_to_client')]],
        expected: { state: 'delivered', raw: 'sent_to_client' },
      },
      { body: [state('done')], expected: { state: 'done', raw: 'done' } },
      {
        body: [state('error', 'paper jam')],
        expected: { state: 'failed', reason: 'printer_error', message: 'paper jam', raw: 'error' },
      },
      {
        body: [state('expired')],
        expected: { state: 'failed', reason: 'expired', raw: 'expired' },
      },
      {
        body: [state('deleted')],
        expected: { state: 'failed', reason: 'deleted', raw: 'deleted' },
      },
      {
        body: [state('queued_elsewhere')],
        expected: { state: 'pending', raw: 'queued_elsewhere' },
      },
      { body: [], expected: { state: 'pending' } },
      {
        body: [
          [state('error', 'older', '2026-10-23T10:00:00.000Z', 99)],
          state('new', undefined, '2026-10-23T11:00:00.000Z'),
          state('done', undefined, '2026-10-23T12:00:00.000Z'),
          state('sent_to_client', undefined, '2026-10-23T11:30:00.000Z'),
        ],
        expected: { state: 'done', raw: 'done' },
      },
    ];
    for (const entry of cases) {
      const provider = await providerFor((req, res) => {
        json(res, 200, entry.body);
      });
      await expect(
        provider.getJobState({ companyId: COMPANY, providerJobId: '42' }),
      ).resolves.toEqual(entry.expected);
    }
  });

  it('cleans and trims a printer error message', async () => {
    const noisy = `  paper jam\u0000\n${'x'.repeat(250)}`;
    const provider = await providerFor((req, res) => {
      json(res, 200, [state('error', noisy)]);
    });
    const status = await provider.getJobState({ companyId: COMPANY, providerJobId: '42' });
    expect(status).toEqual({
      state: 'failed',
      reason: 'printer_error',
      message: `paper jam${'x'.repeat(250)}`.slice(0, 200),
      raw: 'error',
    });
    const blank = await providerFor((req, res) => {
      json(res, 200, [state('error', '\u0000\n\t')]);
    });
    await expect(blank.getJobState({ companyId: COMPANY, providerJobId: '42' })).resolves.toEqual({
      state: 'failed',
      reason: 'printer_error',
      raw: 'error',
    });
  });

  it('rejects a bad state read and rethrows a network failure', async () => {
    const denied = await providerFor((req, res) => {
      json(res, 401, { leaked: SECRET });
    });
    const auth = await settle(denied.getJobState({ companyId: COMPANY, providerJobId: '42' }));
    expect(auth).toBeInstanceOf(ProviderRejected);
    expect((auth as ProviderRejected).message).toBe('auth_failed');
    assertKeyHidden(auth, SECRET);

    const failed = await providerFor((req, res) => {
      json(res, 500, { leaked: SECRET });
    });
    const bad = await settle(failed.getJobState({ companyId: COMPANY, providerJobId: '42' }));
    expect(bad).toBeInstanceOf(ProviderRejected);
    expect((bad as ProviderRejected).message).toBe('bad_response');
    assertKeyHidden(bad, SECRET);

    const closed = await closedPort();
    const network = await settle(
      client(`http://127.0.0.1:${String(closed)}`).getJobState({
        companyId: COMPANY,
        providerJobId: '42',
      }),
    );
    expect(network).toBeInstanceOf(SafeFetchError);
    expect(network).toBeInstanceOf(ConnectFailure);
    expect((network as SafeFetchError).sent).toBe(false);
    assertKeyHidden(network, SECRET);
  });
});

async function expectRejected(status: number, message: string): Promise<void> {
  const error = await submitStatus(status, { leaked: SECRET });
  expect(error).toBeInstanceOf(ProviderRejected);
  expect((error as ProviderRejected).message).toBe(message);
  assertKeyHidden(error, SECRET);
}

async function expectUncertain(
  status: number,
  reason: string,
  body: unknown = { leaked: SECRET },
): Promise<void> {
  const error = await submitStatus(status, body);
  expect(error).toBeInstanceOf(ProviderUncertain);
  expect((error as ProviderUncertain).reason).toBe(reason);
  assertKeyHidden(error, SECRET);
}

async function submitStatus(status: number, body: unknown): Promise<unknown> {
  const provider = await providerFor((req, res) => {
    json(res, status, body);
  });
  return settle(provider.submit(submitInput(Buffer.from('%PDF'))));
}

function submitInput(pdf: Buffer, printerExternalId = '1001'): PrintSubmitInput {
  return {
    companyId: COMPANY,
    printJobId: '01932a1e-7b4c-7c2a-8e10-222222222222',
    printerExternalId,
    pdf,
    copies: 2,
    paperSize: 'A6',
    title: 'gift message',
    idempotencyKey: 'pj_job',
  };
}

function state(
  name: string,
  message?: string,
  createTimestamp = '2026-10-23T12:00:00.000Z',
  printJobId: number | string = 42,
) {
  return {
    printJobId,
    state: name,
    createTimestamp,
    ...(message === undefined ? {} : { message }),
  };
}

function client(origin: string, options?: { timeoutMs?: number }): PrintNodeProvider {
  return new PrintNodeProvider({
    fetch: createSafeFetch({ appEnv: 'test', allowLoopbackForTests: true }),
    apiKeyFor: () => Promise.resolve(SECRET),
    baseUrl: origin,
    ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

async function providerFor(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<PrintNodeProvider> {
  const server = await listen(handler);
  return client(server.origin);
}

async function settle(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return null;
  } catch (error) {
    return error;
  }
}

function assertKeyHidden(error: unknown, secret: string): void {
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
      const cause = (value as { cause?: unknown }).cause;
      visit(cause, depth + 1);
    }
    for (const name of Object.getOwnPropertyNames(value)) {
      visit((value as Record<string, unknown>)[name], depth + 1);
    }
  };
  visit(error, 0);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ origin: string }> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('missing port');
  }
  const close = () => closeServer(server, sockets);
  closers.push(close);
  return { origin: `http://127.0.0.1:${String(address.port)}` };
}

async function closedPort(): Promise<number> {
  const sockets = new Set<Socket>();
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('missing port');
  }
  await closeServer(server, sockets);
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
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
