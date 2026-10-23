import type { LookupOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP, type Socket, type TcpNetConnectOpts } from 'node:net';
import { Agent, buildConnector, request as undiciRequest } from 'undici';
import { isBlockedAddress, isLoopbackHostname, stripBrackets } from './address-policy';
import {
  BlockedDestination,
  ConnectFailure,
  DnsFailure,
  RequestUncertain,
  ResponseTooLarge,
  SafeFetchError,
  TooManyRedirects,
  UnexpectedRedirect,
} from './errors';

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Method = (typeof METHODS)[number];

const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);
const FOLLOWABLE_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * One call, including its redirects. `owned` holds only the errors this call constructed.
 * A SafeFetchError returned by an earlier call is not a member, so it cannot be reused
 * as an abort reason to make a sent request look retryable.
 */
type CallContext = {
  owned: WeakSet<SafeFetchError>;
  state: ConnectionState;
};

function own<T extends SafeFetchError>(context: CallContext, error: T): T {
  context.owned.add(error);
  return error;
}

function isOwned(context: CallContext, error: unknown): error is SafeFetchError {
  return error instanceof SafeFetchError && context.owned.has(error);
}

export type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export type SafeFetchConfig = {
  /** Injected for tests. Default: node:dns/promises lookup with { all: true, verbatim: true }. */
  resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  /**
   * Allows loopback addresses and http: to loopback hosts only.
   * Accepted only when appEnv === 'test'. Any other appEnv with this true throws at creation.
   */
  allowLoopbackForTests?: boolean;
  appEnv: string;
};

export type SafeFetchRequest = {
  method?: Method;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Total time, including redirects. Default 30 seconds. */
  timeoutMs?: number;
  /** Default 10 seconds. */
  connectTimeoutMs?: number;
  /** Default 10 MiB. */
  maxResponseBytes?: number;
  /** Default 3. Followed only for GET and HEAD. */
  maxRedirects?: number;
  /** Default [443]. Test mode also allows any port on loopback. */
  allowedPorts?: readonly number[];
  signal?: AbortSignal;
};

export type SafeResponse = {
  status: number;
  /** Lower-case names. Repeated values are joined with `, `. */
  headers: Record<string, string>;
  body: Buffer;
  /** Final URL after redirects. */
  url: string;
};

type NetLookup = NonNullable<TcpNetConnectOpts['lookup']>;

type ResponseStream = AsyncIterable<unknown> & {
  on(event: 'error', listener: () => void): void;
  destroy(error?: Error): void;
};

type HeaderFields = Record<string, string | string[] | undefined>;

type ClientOptions = {
  allowLoopback: boolean;
  resolve: (hostname: string) => Promise<readonly ResolvedAddress[]>;
};

type Hop =
  | { kind: 'done'; status: number; headers: Record<string, string>; body: Buffer }
  | { kind: 'redirect'; location: string };

/**
 * `connected` becomes true only when the connector callback succeeds. Undici writes
 * the request after that. `pendingSocket` is the socket the connector returns while
 * the handshake is still in progress, so an abort can destroy it.
 */
export type ConnectionState = {
  connected: boolean;
  pendingSocket: Socket | null;
};

/**
 * Lookup passed to the undici Agent as `connect.lookup`.
 * It returns only the addresses already checked for this hop, so the socket cannot resolve again.
 */
export function createPinnedLookup(addresses: readonly ResolvedAddress[]): NetLookup {
  const lookupAddresses: NetLookup = (_hostname, options: LookupOptions, callback) => {
    const requested = options.family;
    const family = requested === 'IPv4' ? 4 : requested === 'IPv6' ? 6 : requested;
    const selected =
      family === 4 || family === 6
        ? addresses.filter((entry) => entry.family === family)
        : addresses;
    process.nextTick(() => {
      const first = selected[0];
      if (!first) {
        const error = new Error('pinned address list is empty') as NodeJS.ErrnoException;
        error.code = 'ENOTFOUND';
        callback(error, '');
        return;
      }
      if (options.all === true) {
        callback(
          null,
          selected.map((entry) => ({ address: entry.address, family: entry.family })),
        );
        return;
      }
      callback(null, first.address, first.family);
    });
  };
  return lookupAddresses;
}

/**
 * One connector per hop. `state.connected` becomes true only when undici's connector
 * returns a socket without an error: after the TLS handshake for https, or after the
 * TCP connect for http. The connector returns that socket synchronously, before the
 * callback, and `state.pendingSocket` holds it until the callback fires. With keepAlive
 * off and one agent per hop, that is one connection.
 */
export function createHopConnector(
  state: ConnectionState,
  options: {
    connectTimeoutMs: number;
    addresses: readonly ResolvedAddress[];
    servername?: string;
  },
): buildConnector.connector {
  // The published connector type returns void. At runtime buildConnector returns the socket.
  const connector = buildConnector({
    timeout: options.connectTimeoutMs,
    lookup: createPinnedLookup(options.addresses),
    keepAlive: false,
    autoSelectFamily: false,
    ...(options.servername === undefined ? {} : { servername: options.servername }),
  }) as (options: buildConnector.Options, callback: buildConnector.Callback) => Socket;
  return (connectOptions, callback) => {
    // buildConnector can run the callback before it returns. This records that.
    const progress = { settled: false };
    const socket = connector(connectOptions, (error, connected) => {
      progress.settled = true;
      state.pendingSocket = null;
      if (error) {
        callback(error, null);
        return;
      }
      state.connected = true;
      callback(null, connected);
    });
    if (!progress.settled) {
      state.pendingSocket = socket;
    }
  };
}

export function createSafeFetch(
  config: SafeFetchConfig,
): (url: string | URL, request?: SafeFetchRequest) => Promise<SafeResponse> {
  if (config.allowLoopbackForTests === true && config.appEnv !== 'test') {
    throw new Error("allowLoopbackForTests is only accepted when appEnv is 'test'");
  }
  const options: ClientOptions = {
    allowLoopback: config.allowLoopbackForTests === true,
    resolve: config.resolve ?? defaultResolve,
  };
  return (url, request) => execute(url, request ?? {}, options);
}

async function defaultResolve(hostname: string): Promise<readonly ResolvedAddress[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => {
    if (record.family !== 4 && record.family !== 6) {
      throw new Error('unexpected address family');
    }
    return { address: record.address, family: record.family };
  });
}

async function execute(
  input: string | URL,
  request: SafeFetchRequest,
  options: ClientOptions,
): Promise<SafeResponse> {
  const method = request.method ?? 'GET';
  assertMethod(method);
  const timeoutMs = request.timeoutMs ?? 30_000;
  const connectTimeoutMs = request.connectTimeoutMs ?? 10_000;
  const maxResponseBytes = request.maxResponseBytes ?? 10 * 1024 * 1024;
  const maxRedirects = request.maxRedirects ?? 3;
  const allowedPorts = request.allowedPorts ?? [443];
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
  const context: CallContext = {
    owned: new WeakSet(),
    state: { connected: false, pendingSocket: null },
  };

  let current = parseUrl(input, method, context);
  let previous: URL | undefined;
  let headers = { ...(request.headers ?? {}) };
  let body = request.body;
  let followed = 0;

  for (;;) {
    assertDestination(current, method, allowedPorts, options.allowLoopback, previous, context);
    const addresses = await resolveAddresses(current, method, options, signal, context);
    const hop = await dispatch({
      url: current,
      method,
      headers,
      body,
      signal,
      connectTimeoutMs,
      timeoutMs,
      maxResponseBytes,
      addresses,
      redirectsLeft: maxRedirects - followed,
      context,
    });
    if (hop.kind === 'done') {
      return { status: hop.status, headers: hop.headers, body: hop.body, url: current.href };
    }
    const next = resolveLocation(hop.location, current, method, context);
    headers = headersAfterRedirect(headers, current, next);
    body = undefined;
    previous = current;
    current = next;
    followed += 1;
  }
}

function assertMethod(method: string): asserts method is Method {
  if (!(METHODS as readonly string[]).includes(method)) {
    throw new Error('unsupported method');
  }
}

function parseUrl(input: string | URL, method: Method, context: CallContext): URL {
  try {
    return input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw own(context, new BlockedDestination(method, 'unparsed:', '/'));
  }
}

function assertDestination(
  url: URL,
  method: Method,
  allowedPorts: readonly number[],
  allowLoopback: boolean,
  previous: URL | undefined,
  context: CallContext,
): void {
  if (hasUserinfo(url)) {
    throw own(context, new BlockedDestination(method, url.origin, url.pathname));
  }
  if (previous?.protocol === 'https:' && url.protocol === 'http:') {
    throw own(context, new BlockedDestination(method, url.origin, url.pathname));
  }
  const loopback = isLoopbackHostname(url.hostname);
  const httpLoopback = allowLoopback && url.protocol === 'http:' && loopback;
  if (url.protocol !== 'https:' && !httpLoopback) {
    throw own(context, new BlockedDestination(method, url.origin, url.pathname));
  }
  if (stripBrackets(url.hostname).length === 0) {
    throw own(context, new BlockedDestination(method, url.origin, url.pathname));
  }
  const port = portNumber(url);
  if (!allowedPorts.includes(port) && !(allowLoopback && loopback)) {
    throw own(context, new BlockedDestination(method, url.origin, url.pathname));
  }
}

function hasUserinfo(url: URL): boolean {
  if (url.username.length > 0 || url.password.length > 0) return true;
  const afterScheme = url.href.slice(url.protocol.length);
  if (!afterScheme.startsWith('//')) return false;
  const authority = afterScheme.slice(2).split(/[/?#]/, 1)[0] ?? '';
  return authority.includes('@');
}

function portNumber(url: URL): number {
  if (url.port !== '') {
    const parsed = Number(url.port);
    return Number.isInteger(parsed) ? parsed : Number.NaN;
  }
  if (url.protocol === 'https:') return 443;
  if (url.protocol === 'http:') return 80;
  return Number.NaN;
}

async function resolveAddresses(
  url: URL,
  method: Method,
  options: ClientOptions,
  signal: AbortSignal,
  context: CallContext,
): Promise<readonly ResolvedAddress[]> {
  const hostname = stripBrackets(url.hostname);
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isBlockedAddress(hostname, options.allowLoopback)) {
      throw own(context, new BlockedDestination(method, url.origin, url.pathname));
    }
    return [{ address: hostname, family: literalFamily }];
  }

  const records = await resolveWithSignal(
    options.resolve,
    hostname,
    signal,
    method,
    url.origin,
    url.pathname,
    context,
  );
  if (!Array.isArray(records) || records.length === 0) {
    throw own(context, new DnsFailure(method, url.origin, url.pathname));
  }

  const pinned: ResolvedAddress[] = [];
  for (const record of records) {
    if (!isResolvedAddress(record) || isBlockedAddress(record.address, options.allowLoopback)) {
      throw own(context, new BlockedDestination(method, url.origin, url.pathname));
    }
    pinned.push({ address: record.address, family: record.family });
  }
  return pinned;
}

/**
 * Race the resolver against the combined signal. On abort, fail immediately with
 * DnsFailure and do not wait for the resolver to settle.
 */
function resolveWithSignal(
  resolve: ClientOptions['resolve'],
  hostname: string,
  signal: AbortSignal,
  method: Method,
  origin: string,
  pathname: string,
  context: CallContext,
): Promise<readonly ResolvedAddress[]> {
  if (signal.aborted) {
    return Promise.reject(own(context, new DnsFailure(method, origin, pathname)));
  }
  return new Promise((resolveRecords, reject) => {
    let settled = false;
    const stop = () => {
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: SafeFetchError) => {
      if (settled) return;
      settled = true;
      stop();
      reject(error);
    };
    const onAbort = () => {
      fail(own(context, new DnsFailure(method, origin, pathname)));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void Promise.resolve()
      .then(() => resolve(hostname))
      .then(
        (records) => {
          if (settled) return;
          if (signal.aborted) {
            fail(own(context, new DnsFailure(method, origin, pathname)));
            return;
          }
          settled = true;
          stop();
          resolveRecords(records);
        },
        (error: unknown) => {
          if (isOwned(context, error) && !signal.aborted) {
            fail(error);
            return;
          }
          fail(own(context, new DnsFailure(method, origin, pathname)));
        },
      );
  });
}

function isResolvedAddress(value: unknown): value is ResolvedAddress {
  if (value === null || typeof value !== 'object') return false;
  const record = value as { address?: unknown; family?: unknown };
  return (
    (record.family === 4 || record.family === 6) &&
    typeof record.address === 'string' &&
    isIP(record.address) === record.family
  );
}

function resolveLocation(
  location: string,
  current: URL,
  method: Method,
  context: CallContext,
): URL {
  try {
    return new URL(location, current);
  } catch {
    throw own(context, new BlockedDestination(method, current.origin, current.pathname));
  }
}

function headersAfterRedirect(
  headers: Record<string, string>,
  from: URL,
  to: URL,
): Record<string, string> {
  if (from.origin === to.origin) return headers;
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) {
      next[name] = value;
    }
  }
  return next;
}

async function dispatch(input: {
  url: URL;
  method: Method;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
  signal: AbortSignal;
  connectTimeoutMs: number;
  timeoutMs: number;
  maxResponseBytes: number;
  addresses: readonly ResolvedAddress[];
  redirectsLeft: number;
  context: CallContext;
}): Promise<Hop> {
  const hostname = stripBrackets(input.url.hostname);
  const servername = isIP(hostname) === 0 ? hostname : undefined;
  // A late callback from the previous hop must not flip this hop's stage.
  const state: ConnectionState = { connected: false, pendingSocket: null };
  input.context.state = state;
  let agent: Agent | undefined;
  // request() honors signal only after the socket exists. buildConnector returns
  // the socket before the handshake finishes, and agent.destroy() does not close
  // it. Destroy that socket first so a cancelled handshake cannot outlive timeoutMs.
  const dropConnection = () => {
    const pending = state.pendingSocket;
    state.pendingSocket = null;
    pending?.destroy();
    agent?.destroy(() => undefined);
  };
  input.signal.addEventListener('abort', dropConnection, { once: true });
  try {
    agent = new Agent({
      connect: createHopConnector(state, {
        connectTimeoutMs: input.connectTimeoutMs,
        addresses: input.addresses,
        ...(servername === undefined ? {} : { servername }),
      }),
      headersTimeout: input.timeoutMs,
      bodyTimeout: input.timeoutMs,
    });
    if (input.signal.aborted) dropConnection();
    // undici's fetch retries a replayable body after 421 and turns 407 into a network
    // error. request() returns every status and does not follow redirects.
    const response = await undiciRequest(input.url, {
      dispatcher: agent,
      method: input.method,
      headers: input.headers,
      signal: input.signal,
      headersTimeout: input.timeoutMs,
      bodyTimeout: input.timeoutMs,
      ...(input.body === undefined ? {} : { body: input.body }),
    });

    const stream = responseStream(response.body);
    const headers = headerFields(response.headers);
    if (declaredTooLarge(headerValue(headers, 'content-length'), input.maxResponseBytes)) {
      destroyBody(stream);
      throw own(
        input.context,
        new ResponseTooLarge(input.method, input.url.origin, input.url.pathname),
      );
    }

    const location = redirectLocation(response.statusCode, headerValue(headers, 'location'));
    if (location !== null && input.method !== 'GET' && input.method !== 'HEAD') {
      destroyBody(stream);
      throw own(
        input.context,
        new UnexpectedRedirect(input.method, input.url.origin, input.url.pathname),
      );
    }
    if (location !== null && FOLLOWABLE_STATUS.has(response.statusCode)) {
      if (input.redirectsLeft <= 0) {
        destroyBody(stream);
        throw own(
          input.context,
          new TooManyRedirects(input.method, input.url.origin, input.url.pathname),
        );
      }
      destroyBody(stream);
      return { kind: 'redirect', location };
    }

    const body = await readCapped(
      stream,
      input.maxResponseBytes,
      input.method,
      input.url.origin,
      input.url.pathname,
      input.context,
    );
    return {
      kind: 'done',
      status: response.statusCode,
      headers: headerRecord(headers),
      body,
    };
  } catch (error) {
    if (isOwned(input.context, error)) throw error;
    throw classifyTransportError(
      error,
      state,
      input.method,
      input.url.origin,
      input.url.pathname,
      input.context,
    );
  } finally {
    input.signal.removeEventListener('abort', dropConnection);
    // destroy() drops the socket. Awaiting close() would wait out a pending handshake
    // and hold the caller past the total timeout.
    if (agent) {
      agent.destroy(() => undefined);
    }
  }
}

/** A present Location, including "", is a redirect. "" resolves against the current URL. */
function redirectLocation(status: number, location: string | null): string | null {
  if (location === null) return null;
  if (status < 300 || status >= 400) return null;
  return location;
}

function declaredTooLarge(header: string | null, maxResponseBytes: number): boolean {
  if (header === null || !/^\d+$/.test(header)) return false;
  return BigInt(header) > BigInt(maxResponseBytes);
}

function responseStream(body: object): ResponseStream {
  return body as ResponseStream;
}

function destroyBody(body: ResponseStream): void {
  try {
    body.on('error', () => undefined);
    body.destroy();
  } catch {
    // Closing the unread body must not replace the status or error already chosen.
  }
}

function bytesOf(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  throw new Error('unexpected response chunk');
}

async function readCapped(
  body: ResponseStream,
  maxResponseBytes: number,
  method: Method,
  origin: string,
  pathname: string,
  context: CallContext,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  body.on('error', () => undefined);
  try {
    for await (const chunk of body) {
      const bytes = bytesOf(chunk);
      if (bytes.byteLength === 0) continue;
      total += bytes.byteLength;
      if (total > maxResponseBytes) {
        tooLarge = true;
        break;
      }
      chunks.push(Buffer.from(bytes));
    }
  } catch (error) {
    destroyBody(body);
    if (tooLarge) throw own(context, new ResponseTooLarge(method, origin, pathname));
    if (isOwned(context, error)) throw error;
    throw classifyTransportError(error, context.state, method, origin, pathname, context);
  }
  if (tooLarge) {
    destroyBody(body);
    throw own(context, new ResponseTooLarge(method, origin, pathname));
  }
  return Buffer.concat(chunks);
}

function headerFields(headers: object): HeaderFields {
  return headers as HeaderFields;
}

function headerValue(headers: HeaderFields, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || key.toLowerCase() !== wanted) continue;
    return joinHeader(value);
  }
  return null;
}

function joinHeader(value: string | string[]): string {
  return typeof value === 'string' ? value : value.join(', ');
}

function headerRecord(headers: HeaderFields): Record<string, string> {
  const record = Object.create(null) as Record<string, string>;
  for (const name of Object.getOwnPropertyNames(headers)) {
    const descriptor = Object.getOwnPropertyDescriptor(headers, name);
    const value: unknown = descriptor?.value;
    if (typeof value !== 'string' && !isStringList(value)) continue;
    const key = name.toLowerCase();
    const joined = joinHeader(value);
    const previous = record[key];
    record[key] = previous === undefined ? joined : `${previous}, ${joined}`;
  }
  return record;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Classification follows the connection stage, never the error's code or name.
 * Before the connector succeeds, nothing has been written. Afterwards the request
 * may have been sent, including when the abort reason is itself a connect failure.
 * Only an error created for this call is returned unchanged.
 */
export function classifyTransportError(
  error: unknown,
  state: ConnectionState,
  method: Method,
  origin: string,
  pathname: string,
  context?: CallContext,
): SafeFetchError {
  if (context !== undefined && isOwned(context, error)) return error;
  if (state.connected) {
    const uncertain = new RequestUncertain(method, origin, pathname);
    return context === undefined ? uncertain : own(context, uncertain);
  }
  const failure = new ConnectFailure(method, origin, pathname);
  return context === undefined ? failure : own(context, failure);
}
