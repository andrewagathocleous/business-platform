import { readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { scrub } from './report';

export type Reply = {
  status: number;
  text: string;
  bytes: Buffer;
  body: unknown;
  headers: { get(name: string): string | null };
};

export function localAgent(caPath: string): Agent {
  return new Agent({ connect: { ca: readFileSync(caPath) } });
}

export class Session {
  readonly jar = new Map<string, string>();

  constructor(
    private readonly origin: string,
    private readonly dispatcher: Dispatcher,
  ) {}

  async send(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    payload?: unknown,
    authorization?: string,
    cookie?: string,
  ): Promise<Reply> {
    const headers: Record<string, string> = {};
    const cookieHeader =
      cookie ??
      (this.jar.size > 0
        ? [...this.jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
        : undefined);
    if (cookieHeader) {
      headers.cookie = cookieHeader;
    }
    const xsrf = this.jar.get('XSRF-TOKEN');
    if (xsrf && method !== 'GET' && cookie === undefined) {
      headers['x-xsrf-token'] = xsrf;
    }
    if (authorization) {
      headers.authorization = authorization;
    }
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
    }
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(`${this.origin}${path}`, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        dispatcher: this.dispatcher,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request failed';
      throw new Error(scrub(`request failed: ${message}`));
    }
    if (cookie === undefined) {
      storeCookies(this.jar, response);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString('utf8');
    let body: unknown = {};
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = {};
      }
    }
    return { status: response.status, text, bytes, body, headers: response.headers };
  }
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}

/** The staff session cookie captured before logout, so a later request can replay it. */
export function staffSessionCookie(jar: ReadonlyMap<string, string>): string {
  for (const name of ['__Host-bp_session', 'bp_session']) {
    const value = jar.get(name);
    if (typeof value === 'string' && value.length > 0) {
      return `${name}=${value}`;
    }
  }
  throw new Error('session cookie is missing');
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function field(body: unknown, key: string): string {
  const record = asRecord(body);
  const value = record?.[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} is missing`);
  }
  return value;
}

export function nested(body: unknown, key: string): Record<string, unknown> {
  const record = asRecord(asRecord(body)?.[key]);
  if (!record) {
    throw new Error(`${key} is missing`);
  }
  return record;
}

export function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${key} is missing`);
  }
  return value;
}

function storeCookies(
  jar: Map<string, string>,
  response: Awaited<ReturnType<typeof undiciFetch>>,
): void {
  const lines =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const line of lines) {
    const pair = line.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) {
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }
}
