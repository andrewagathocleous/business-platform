import type { IncomingMessage } from 'node:http';
import { stdSerializers } from 'pino';

/** Pino redact paths from the Step B plan, including nested copies of the same keys. */
export const LOG_REDACT_CENSOR = '[Redacted]';

const SENSITIVE_KEYS = ['token', 'secret', 'password', 'iban', 'ciphertext'] as const;

const SENSITIVE_QUERY_KEYS = new Set([
  'invitation',
  'enrolment',
  'code',
  'state',
  'session_state',
  'id_token',
  'token',
  'access_token',
]);

export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'res.headers.location',
  '*.["set-cookie"]',
  '*.*.["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`, `*.*.*.*.${key}`]),
];

type LoggedRequest = IncomingMessage & { query?: unknown; originalUrl?: string };

/** Replaces sensitive query values in the logged URL and query object. */
export function redactLoggedRequest(req: LoggedRequest): Record<string, unknown> {
  const urlSource = typeof req.originalUrl === 'string' && req.originalUrl.length > 0 ? req.originalUrl : (req.url ?? '');
  const serialized = stdSerializers.req(req);
  return {
    ...serialized,
    url: redactRequestUrl(urlSource),
    query: redactQuery(req.query),
    headers: redactHeaders(serialized.headers),
  };
}

const SENSITIVE_HEADER = /token|secret|key/i;

function redactHeaders(headers: unknown): unknown {
  if (Array.isArray(headers)) {
    return headers.map((item) => redactHeaders(item));
  }
  if (!headers || typeof headers !== 'object') {
    return headers;
  }
  const output: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER.test(name)) {
      output[name] = LOG_REDACT_CENSOR;
      continue;
    }
    if (name.toLowerCase() === 'referer' || name.toLowerCase() === 'referrer') {
      output[name] = redactReferer(value);
      continue;
    }
    output[name] = value;
  }
  return output;
}

function redactReferer(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactRequestUrl(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactReferer(item));
  }
  return value;
}

export function redactRequestUrl(url: string): string {
  const hashIndex = url.indexOf('#');
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : url.slice(hashIndex);
  const queryIndex = withoutHash.indexOf('?');
  if (queryIndex === -1) {
    return url;
  }
  const path = withoutHash.slice(0, queryIndex);
  const query = withoutHash.slice(queryIndex + 1);
  const redacted = query
    .split('&')
    .map((part) => redactQueryPart(part))
    .join('&');
  return `${path}?${redacted}${hash}`;
}

export function redactQuery(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactQuery(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      output[key] = Array.isArray(child) ? child.map(() => LOG_REDACT_CENSOR) : LOG_REDACT_CENSOR;
      continue;
    }
    output[key] = redactQuery(child);
  }
  return output;
}

function redactQueryPart(part: string): string {
  if (part.length === 0) {
    return part;
  }
  const eq = part.indexOf('=');
  const rawKey = eq === -1 ? part : part.slice(0, eq);
  const key = decodeQueryComponent(rawKey).toLowerCase();
  if (!SENSITIVE_QUERY_KEYS.has(key)) {
    return part;
  }
  const rawValue = eq === -1 ? '' : part.slice(eq + 1);
  if (rawValue.length === 0) {
    return part;
  }
  return `${rawKey}=${LOG_REDACT_CENSOR}`;
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}
