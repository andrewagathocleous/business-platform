import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BlockedDestination,
  ConnectFailure,
  DnsFailure,
  RequestUncertain,
  ResponseTooLarge,
  TooManyRedirects,
  UnexpectedRedirect,
} from './errors';
import {
  classifyTransportError,
  createHopConnector,
  createPinnedLookup,
  createSafeFetch,
  type ConnectionState,
  type SafeFetchConfig,
} from './safe-fetch';

type Started = {
  port: number;
  origin: string;
  connections: () => number;
  close: () => Promise<void>;
};

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function testFetch(resolve?: SafeFetchConfig['resolve']) {
  return createSafeFetch({
    appEnv: 'test',
    allowLoopbackForTests: true,
    ...(resolve ? { resolve } : {}),
  });
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Started> {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  let opened = 0;
  server.on('connection', (socket) => {
    opened += 1;
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
  if (!address || typeof address === 'string') throw new Error('missing port');
  const started: Started = {
    port: address.port,
    origin: `http://127.0.0.1:${String(address.port)}`,
    connections: () => opened,
    close: () => closeServer(server, sockets),
  };
  closers.push(started.close);
  return started;
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function listenRaw(): Promise<{ port: number; acceptedClosed: Promise<void> }> {
  const sockets = new Set<Socket>();
  let markClosed: () => void = () => undefined;
  const acceptedClosed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    // Read, and never write, so a peer FIN is observed and the handshake stays unanswered.
    socket.resume();
    socket.on('close', () => {
      sockets.delete(socket);
      markClosed();
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
  if (!address || typeof address === 'string') throw new Error('missing port');
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
  return { port: address.port, acceptedClosed };
}

function driveConnector(
  connector: ReturnType<typeof createHopConnector>,
  port: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    connector(
      {
        hostname: '127.0.0.1',
        host: '127.0.0.1',
        protocol: 'http:',
        port: String(port),
      },
      (error, socket) => {
        if (error) {
          reject(error);
          return;
        }
        socket.destroy();
        resolve();
      },
    );
  });
}

function tlsAlert(): Error {
  return Object.assign(new Error('alert'), { code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR' });
}

async function closedLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

async function listenAnswerThenRetry(
  firstStatus: number,
  firstBody: string,
): Promise<{ origin: string; requests: () => number; bodies: () => readonly string[] }> {
  const bodies: string[] = [];
  let requests = 0;
  const started = await listen((req, res) => {
    const index = requests;
    requests += 1;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      if (index === 0) {
        res.writeHead(firstStatus);
        res.end(firstBody);
        return;
      }
      res.writeHead(200);
      res.end('retried');
    });
  });
  return {
    origin: started.origin,
    requests: () => requests,
    bodies: () => bodies,
  };
}

function assertSecretsAbsent(error: unknown, secrets: readonly string[]): void {
  const record = error as { message?: unknown; cause?: unknown };
  expect(record.cause).toBeUndefined();
  const blobs: string[] = [];
  if (typeof record.message === 'string') blobs.push(record.message);
  if (error && typeof error === 'object') {
    for (const key of Object.keys(error)) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === 'string') blobs.push(value);
    }
  }
  const text = blobs.join('\n');
  for (const secret of secrets) {
    expect(text.includes(secret)).toBe(false);
  }
}

function pinnedAnswer(
  lookup: ReturnType<typeof createPinnedLookup>,
  options: { all?: boolean },
): Promise<{ address: string; family?: number } | { address: string; family: number }[]> {
  return new Promise((resolve, reject) => {
    lookup('example.test', options, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(typeof address === 'string' ? { address, family } : [...address]);
    });
  });
}

describe('createSafeFetch', () => {
  it('refuses http outside test mode before resolving', async () => {
    let calls = 0;
    const fetch = createSafeFetch({
      appEnv: 'production',
      resolve: () => {
        calls += 1;
        return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
      },
    });
    const error = await rejectionOf(fetch('http://example.test'));
    expect(error).toBeInstanceOf(BlockedDestination);
    expect(error).toMatchObject({ code: 'blocked_destination', sent: false });
    expect(calls).toBe(0);
  });

  it('refuses userinfo and keeps it out of the error', async () => {
    let calls = 0;
    const fetch = createSafeFetch({
      appEnv: 'production',
      resolve: () => {
        calls += 1;
        return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
      },
    });
    const error = await rejectionOf(fetch('https://user:pass@example.test'));
    expect(error).toBeInstanceOf(BlockedDestination);
    expect(calls).toBe(0);
    const message = error instanceof Error ? error.message : '';
    expect(message.includes('user')).toBe(false);
    expect(message.includes('pass')).toBe(false);
    assertSecretsAbsent(error, ['user', 'pass']);
  });

  it('refuses a port that is not allowed before resolving', async () => {
    let calls = 0;
    const fetch = createSafeFetch({
      appEnv: 'production',
      resolve: () => {
        calls += 1;
        return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
      },
    });
    const error = await rejectionOf(fetch('https://example.test:8443/'));
    expect(error).toBeInstanceOf(BlockedDestination);
    expect(calls).toBe(0);
  });

  it('rejects a DNS answer that includes a blocked address before connecting', async () => {
    const specified = createSafeFetch({
      appEnv: 'production',
      resolve: () =>
        Promise.resolve([
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.5', family: 4 },
        ]),
    });
    const specifiedError = await rejectionOf(
      specified('https://example.test/mixed', { timeoutMs: 500 }),
    );
    expect(specifiedError).toBeInstanceOf(BlockedDestination);
    expect(specifiedError).toMatchObject({ sent: false });

    const started = await listen((_req, res) => {
      res.writeHead(200);
      res.end('connected');
    });
    const fetch = testFetch(() =>
      Promise.resolve([
        { address: '127.0.0.1', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]),
    );
    const error = await rejectionOf(
      fetch(`http://localhost:${String(started.port)}/mixed`, { timeoutMs: 500 }),
    );
    expect(error).toBeInstanceOf(BlockedDestination);
    await new Promise((resolve) => setImmediate(resolve));
    expect(started.connections()).toBe(0);
  });

  it('resolves once per hop and the agent lookup returns only the pinned address', async () => {
    const started = await listen((_req, res) => {
      res.writeHead(200);
      res.end('pinned');
    });
    let calls = 0;
    const pinned = [{ address: '127.0.0.1', family: 4 as const }];
    const fetch = testFetch((hostname) => {
      calls += 1;
      if (hostname === 'localhost' && calls === 1) return Promise.resolve(pinned);
      return Promise.resolve([{ address: '10.0.0.5', family: 4 }]);
    });
    const response = await fetch(`http://localhost:${String(started.port)}/pin`);
    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('pinned');
    expect(calls).toBe(1);

    const lookup = createPinnedLookup(pinned);
    await expect(pinnedAnswer(lookup, {})).resolves.toEqual({ address: '127.0.0.1', family: 4 });
    await expect(pinnedAnswer(lookup, {})).resolves.toEqual({ address: '127.0.0.1', family: 4 });
    await expect(pinnedAnswer(lookup, { all: true })).resolves.toEqual([
      { address: '127.0.0.1', family: 4 },
    ]);
  });

  it('rejects allowLoopbackForTests unless appEnv is test', () => {
    expect(() => createSafeFetch({ appEnv: 'production', allowLoopbackForTests: true })).toThrow(
      /appEnv is 'test'/,
    );
    expect(() => createSafeFetch({ appEnv: 'development', allowLoopbackForTests: true })).toThrow(
      /appEnv is 'test'/,
    );
    expect(() => createSafeFetch({ appEnv: 'test', allowLoopbackForTests: true })).not.toThrow();
  });

  it('returns every HTTP status and the body', async () => {
    const started = await listen((req, res) => {
      const status = Number(req.url?.split('/').at(-1));
      res.writeHead(status);
      res.end(`body-${String(status)}`);
    });
    const fetch = testFetch();
    for (const status of [200, 401, 409, 429]) {
      const response = await fetch(`${started.origin}/status/${String(status)}`);
      expect(response.status).toBe(status);
      expect(response.body.toString('utf8')).toBe(`body-${String(status)}`);
      expect(response.url).toBe(`${started.origin}/status/${String(status)}`);
    }
  });

  it('follows a GET redirect and drops credentials only when the origin changes', async () => {
    const landed: { authorization?: string; cookie?: string; proxy?: string } = {};
    const other = await listen((req, res) => {
      landed.authorization = req.headers.authorization;
      landed.cookie = req.headers.cookie;
      const proxy = req.headers['proxy-authorization'];
      landed.proxy = Array.isArray(proxy) ? proxy.join(', ') : proxy;
      res.writeHead(200);
      res.end('elsewhere');
    });
    const cross = await listen((_req, res) => {
      res.writeHead(302, { location: `${other.origin}/landed` });
      res.end();
    });
    const fetch = testFetch();
    const crossResponse = await fetch(`${cross.origin}/start`, {
      headers: {
        Authorization: 'Bearer drop-me',
        Cookie: 'sid=drop-me',
        'Proxy-Authorization': 'Basic drop-me',
      },
    });
    expect(crossResponse.status).toBe(200);
    expect(crossResponse.body.toString('utf8')).toBe('elsewhere');
    expect(crossResponse.url).toBe(`${other.origin}/landed`);
    expect(landed.authorization).toBeUndefined();
    expect(landed.cookie).toBeUndefined();
    expect(landed.proxy).toBeUndefined();

    let keptAuthorization: string | undefined;
    let keptCookie: string | undefined;
    const same = await listen((req, res) => {
      if (req.url === '/start') {
        const host = req.headers.host;
        if (!host) {
          res.writeHead(400);
          res.end();
          return;
        }
        res.writeHead(302, { location: `http://${host}/landed` });
        res.end();
        return;
      }
      keptAuthorization = req.headers.authorization;
      keptCookie = req.headers.cookie;
      res.writeHead(200);
      res.end('same');
    });
    const sameResponse = await fetch(`${same.origin}/start`, {
      headers: { Authorization: 'Bearer keep-me', Cookie: 'sid=keep-me' },
    });
    expect(sameResponse.status).toBe(200);
    expect(sameResponse.body.toString('utf8')).toBe('same');
    expect(keptAuthorization).toBe('Bearer keep-me');
    expect(keptCookie).toBe('sid=keep-me');
  });

  it('refuses a redirect to a blocked literal without resolving', async () => {
    let calls = 0;
    const started = await listen((_req, res) => {
      res.writeHead(302, { location: 'http://10.0.0.5/' });
      res.end();
    });
    const fetch = testFetch(() => {
      calls += 1;
      return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
    });
    const error = await rejectionOf(fetch(`${started.origin}/go`));
    expect(error).toBeInstanceOf(BlockedDestination);
    expect(error).toMatchObject({ code: 'blocked_destination', sent: false });
    expect(calls).toBe(0);
  });

  it('stops after the redirect limit', async () => {
    const seen: string[] = [];
    const started = await listen((req, res) => {
      seen.push(req.url ?? '');
      const step = Number(req.url?.slice(1));
      const host = req.headers.host;
      if (Number.isInteger(step) && step < 4 && host) {
        res.writeHead(302, { location: `http://${host}/${String(step + 1)}` });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('done');
    });
    const error = await rejectionOf(testFetch()(`${started.origin}/0`));
    expect(error).toBeInstanceOf(TooManyRedirects);
    expect(error).toMatchObject({ code: 'too_many_redirects', sent: true });
    expect(seen).toEqual(['/0', '/1', '/2', '/3']);
  });

  it('does not resend a POST body when the response is a redirect', async () => {
    const bodies: string[] = [];
    const started = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(307, { location: '/other' });
        res.end();
      });
    });
    const error = await rejectionOf(
      testFetch()(`${started.origin}/submit`, { method: 'POST', body: 'sent-once' }),
    );
    expect(error).toBeInstanceOf(UnexpectedRedirect);
    expect(error).toMatchObject({ code: 'unexpected_redirect', sent: true });
    expect(bodies).toEqual(['sent-once']);
    assertSecretsAbsent(error, ['sent-once']);
  });

  it('treats a timeout after the server accepts as uncertain', async () => {
    const started = await listen(() => {
      // Accept the socket and never write a response.
    });
    const error = await rejectionOf(
      testFetch()(`${started.origin}/callback?key=SECRETVALUE`, {
        timeoutMs: 200,
        headers: { authorization: 'Bearer TOKENVALUE' },
      }),
    );
    expect(error).toBeInstanceOf(RequestUncertain);
    expect(error).toMatchObject({ code: 'request_uncertain', sent: true });
    assertSecretsAbsent(error, ['SECRETVALUE', 'TOKENVALUE', 'Bearer']);
  });

  it('treats a closed loopback port as a connect failure', async () => {
    const port = await closedLoopbackPort();
    const error = await rejectionOf(testFetch()(`http://127.0.0.1:${String(port)}/`));
    expect(error).toBeInstanceOf(ConnectFailure);
    expect(error).toMatchObject({ code: 'connect_failure', sent: false });
  });

  it('rejects a content-length and a streamed body above the cap', async () => {
    const started = await listen((req, res) => {
      if (req.url === '/declared') {
        res.writeHead(200, { 'content-length': '1000' });
        res.end('x');
        return;
      }
      res.write(Buffer.alloc(8, 0x61));
      res.write(Buffer.alloc(8, 0x62));
      res.end();
    });
    const fetch = testFetch();
    const declared = await rejectionOf(
      fetch(`${started.origin}/declared`, { maxResponseBytes: 10 }),
    );
    expect(declared).toBeInstanceOf(ResponseTooLarge);
    expect(declared).toMatchObject({ code: 'response_too_large', sent: true });

    const streamed = await rejectionOf(
      fetch(`${started.origin}/chunked`, { maxResponseBytes: 10 }),
    );
    expect(streamed).toBeInstanceOf(ResponseTooLarge);
    expect(streamed).toMatchObject({ code: 'response_too_large', sent: true });
  });

  it('fails DNS when the resolver rejects or returns nothing', async () => {
    const rejected = createSafeFetch({
      appEnv: 'production',
      resolve: () => Promise.reject(new Error('SERVFAIL-DETAIL')),
    });
    const rejectedError = await rejectionOf(rejected('https://example.test/lookup'));
    expect(rejectedError).toBeInstanceOf(DnsFailure);
    expect(rejectedError).toMatchObject({ code: 'dns_failure', sent: false });
    assertSecretsAbsent(rejectedError, ['SERVFAIL-DETAIL']);

    const empty = createSafeFetch({
      appEnv: 'production',
      resolve: () => Promise.resolve([]),
    });
    const emptyError = await rejectionOf(empty('https://example.test/lookup'));
    expect(emptyError).toBeInstanceOf(DnsFailure);
    expect(emptyError).toMatchObject({ code: 'dns_failure', sent: false });
  });

  it('classifies a TLS alert by connection stage', async () => {
    const alert = tlsAlert();
    const refusedState: ConnectionState = { connected: false, pendingSocket: null };
    const closed = await closedLoopbackPort();
    await expect(
      driveConnector(
        createHopConnector(refusedState, {
          connectTimeoutMs: 1_000,
          addresses: [{ address: '127.0.0.1', family: 4 }],
        }),
        closed,
      ),
    ).rejects.toBeTruthy();
    expect(refusedState.connected).toBe(false);
    const before = classifyTransportError(
      alert,
      refusedState,
      'POST',
      'https://shop.test',
      '/print',
    );
    expect(before).toBeInstanceOf(ConnectFailure);
    expect(before).toMatchObject({ code: 'connect_failure', sent: false });

    const open = await listenRaw();
    const connectedState: ConnectionState = { connected: false, pendingSocket: null };
    await driveConnector(
      createHopConnector(connectedState, {
        connectTimeoutMs: 1_000,
        addresses: [{ address: '127.0.0.1', family: 4 }],
      }),
      open.port,
    );
    expect(connectedState.connected).toBe(true);
    const after = classifyTransportError(
      alert,
      connectedState,
      'POST',
      'https://shop.test',
      '/print',
    );
    expect(after).toBeInstanceOf(RequestUncertain);
    expect(after).toMatchObject({ code: 'request_uncertain', sent: true });
  });

  it('treats a socket reset after the body was read as uncertain', async () => {
    const started = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        expect(Buffer.concat(chunks).toString('utf8')).toBe('PRINT-ONCE');
        req.socket.destroy();
      });
      res.on('error', () => undefined);
    });
    const error = await rejectionOf(
      testFetch()(`${started.origin}/print`, { method: 'POST', body: 'PRINT-ONCE' }),
    );
    expect(error).toBeInstanceOf(RequestUncertain);
    expect(error).toMatchObject({ code: 'request_uncertain', sent: true });
  });

  it('does not let an abort reason make a sent request retryable', async () => {
    const reasons: unknown[] = [
      new ConnectFailure('GET', 'https://other.test', '/'),
      Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
    ];
    for (const reason of reasons) {
      let release: (body: string) => void = () => undefined;
      const received = new Promise<string>((resolve) => {
        release = resolve;
      });
      const started = await listen((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        req.on('end', () => {
          release(Buffer.concat(chunks).toString('utf8'));
        });
        res.on('error', () => undefined);
      });
      const controller = new AbortController();
      const pending = testFetch()(`${started.origin}/print`, {
        method: 'POST',
        body: 'PRINT-ONCE',
        signal: controller.signal,
      });
      expect(await received).toBe('PRINT-ONCE');
      controller.abort(reason);
      const error = await rejectionOf(pending);
      expect(error).toBeInstanceOf(RequestUncertain);
      expect(error).toMatchObject({ code: 'request_uncertain', sent: true });
      assertSecretsAbsent(error, ['other.test', 'ECONNREFUSED']);
    }
  });

  it('classifies a SafeFetchError captured from an earlier call', async () => {
    const port = await closedLoopbackPort();
    const captured = await rejectionOf(testFetch()(`http://127.0.0.1:${String(port)}/`));
    expect(captured).toBeInstanceOf(ConnectFailure);
    expect(captured).toMatchObject({ code: 'connect_failure', sent: false });

    let release: (body: string) => void = () => undefined;
    const received = new Promise<string>((resolve) => {
      release = resolve;
    });
    const started = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        release(Buffer.concat(chunks).toString('utf8'));
      });
      res.on('error', () => undefined);
    });
    const controller = new AbortController();
    const pending = testFetch()(`${started.origin}/print`, {
      method: 'POST',
      body: 'PRINT-ONCE',
      signal: controller.signal,
    });
    expect(await received).toBe('PRINT-ONCE');
    controller.abort(captured);
    const error = await rejectionOf(pending);
    expect(error).toBeInstanceOf(RequestUncertain);
    expect(error).toMatchObject({ code: 'request_uncertain', sent: true });
    expect(error).not.toBe(captured);
    expect(captured).toMatchObject({ code: 'connect_failure', sent: false });
  });

  it('returns 421 for a POST and does not send the body again', async () => {
    const started = await listenAnswerThenRetry(421, 'misdirected');
    const response = await testFetch()(`${started.origin}/print`, {
      method: 'POST',
      body: 'PRINT-ONCE',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(started.requests()).toBe(1);
    expect(started.bodies()).toEqual(['PRINT-ONCE']);
    expect(response.status).toBe(421);
    expect(response.body.toString('utf8')).toBe('misdirected');
  });

  it.each(['PUT', 'PATCH', 'DELETE'] as const)(
    'returns 421 for %s and does not send the body again',
    async (method) => {
      const started = await listenAnswerThenRetry(421, 'misdirected');
      const response = await testFetch()(`${started.origin}/print`, {
        method,
        body: 'PRINT-ONCE',
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(started.requests()).toBe(1);
      expect(started.bodies()).toEqual(['PRINT-ONCE']);
      expect(response.status).toBe(421);
      expect(response.body.toString('utf8')).toBe('misdirected');
    },
  );

  it('returns 407 and its body', async () => {
    const started = await listen((_req, res) => {
      res.writeHead(407);
      res.end('no');
    });
    const response = await testFetch()(`${started.origin}/proxy`);
    expect(response.status).toBe(407);
    expect(response.body.toString('utf8')).toBe('no');
  });

  it('treats an abort while DNS is pending as not sent', async () => {
    const controller = new AbortController();
    let markStarted: () => void = () => undefined;
    const startedResolve = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetch = createSafeFetch({
      appEnv: 'production',
      resolve: () => {
        markStarted();
        return new Promise(() => undefined);
      },
    });
    const pending = fetch('https://example.test/lookup', { signal: controller.signal });
    await startedResolve;
    const start = performance.now();
    controller.abort();
    const error = await Promise.race([
      rejectionOf(pending),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('abort waited for DNS'));
        }, 200);
      }),
    ]);
    expect(performance.now() - start).toBeLessThan(200);
    expect(error).toBeInstanceOf(DnsFailure);
    expect(error).toMatchObject({ code: 'dns_failure', sent: false });
  });

  it('fails a hung resolver when the total timeout fires', async () => {
    const fetch = createSafeFetch({
      appEnv: 'production',
      resolve: () => new Promise(() => undefined),
    });
    const start = performance.now();
    const error = await Promise.race([
      rejectionOf(fetch('https://example.test/lookup', { timeoutMs: 30 })),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('resolver ignored the timeout'));
        }, 200);
      }),
    ]);
    expect(performance.now() - start).toBeLessThan(200);
    expect(error).toBeInstanceOf(DnsFailure);
    expect(error).toMatchObject({ code: 'dns_failure', sent: false });
  });

  it('rejects a stalled TLS handshake within the total timeout', async () => {
    const open = await listenRaw();
    const start = performance.now();
    const error = await Promise.race([
      rejectionOf(
        testFetch()(`https://127.0.0.1:${String(open.port)}/`, {
          timeoutMs: 30,
          connectTimeoutMs: 700,
        }),
      ),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('cleanup waited on the handshake'));
        }, 150);
      }),
    ]);
    const rejectedAt = performance.now();
    expect(rejectedAt - start).toBeLessThan(150);
    expect(error).toBeInstanceOf(ConnectFailure);
    expect(error).toMatchObject({ code: 'connect_failure', sent: false });
    await Promise.race([
      open.acceptedClosed,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('accepted socket stayed open'));
        }, 150);
      }),
    ]);
    expect(performance.now() - rejectedAt).toBeLessThan(150);
  });

  it('treats an empty Location as a redirect', async () => {
    const bodies: string[] = [];
    const posted = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(307, { location: '' });
        res.end();
      });
    });
    const postError = await rejectionOf(
      testFetch()(`${posted.origin}/submit`, { method: 'POST', body: 'once' }),
    );
    expect(postError).toBeInstanceOf(UnexpectedRedirect);
    expect(postError).toMatchObject({ code: 'unexpected_redirect', sent: true });
    expect(bodies).toEqual(['once']);

    let hits = 0;
    const loop = await listen((_req, res) => {
      hits += 1;
      res.writeHead(302, { location: '' });
      res.end();
    });
    const loopError = await rejectionOf(testFetch()(`${loop.origin}/loop`));
    expect(loopError).toBeInstanceOf(TooManyRedirects);
    expect(loopError).toMatchObject({ code: 'too_many_redirects', sent: true });
    expect(hits).toBe(4);
  });

  it('keeps header names that match object properties', async () => {
    const started = await listen((_req, res) => {
      res.setHeader('constructor', 'provider-value');
      res.setHeader('__proto__', 'x');
      res.writeHead(200);
      res.end('ok');
    });
    const response = await testFetch()(`${started.origin}/headers`);
    expect(Object.hasOwn(response.headers, 'constructor')).toBe(true);
    expect(Object.hasOwn(response.headers, '__proto__')).toBe(true);
    expect(response.headers['constructor']).toBe('provider-value');
    expect(response.headers['__proto__']).toBe('x');
  });
});
