import { z } from 'zod';
import type { SafeFetchRequest, SafeResponse } from '../http/safe-fetch';
import { SafeFetchError } from '../http/errors';
import {
  ProviderRejected,
  ProviderUncertain,
  type ListedPrinter,
  type PrintAccount,
  type PrintProvider,
  type PrintSubmitInput,
  type ProviderJobStatus,
} from './provider';

/** The function returned by `createSafeFetch`. */
export type SafeFetch = (url: string | URL, request?: SafeFetchRequest) => Promise<SafeResponse>;

const DEFAULT_BASE_URL = 'https://api.printnode.com';
const DEFAULT_TIMEOUT_MS = 20_000;
const EXPIRE_AFTER_SECONDS = 86_400;

const jobIdSchema = z.number().int().positive();

const printerSchema = z.object({
  id: z.number(),
  name: z.string(),
  state: z.string().nullish(),
  computer: z
    .object({
      name: z.string().optional(),
    })
    .nullish(),
  capabilities: z
    .object({
      papers: z.record(z.string(), z.unknown()).nullish(),
    })
    .nullish(),
});

const printerListSchema = z.array(printerSchema);

const stateObjectSchema = z.object({
  printJobId: z.union([z.number(), z.string()]),
  state: z.string(),
  createTimestamp: z.string(),
  message: z.string().nullish(),
});

const statesSchema = z.array(z.union([stateObjectSchema, z.array(stateObjectSchema)]));

type StateObject = z.infer<typeof stateObjectSchema>;

/**
 * PrintNode over the shared outbound client.
 * `done` means the provider handed the job to the OS queue. It does not mean paper came out.
 */
export class PrintNodeProvider implements PrintProvider {
  readonly provider = 'printnode' as const;
  readonly label = 'PrintNode';
  private readonly fetch: SafeFetch;
  private readonly apiKeyFor: (companyId: string) => Promise<string>;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(deps: {
    fetch: SafeFetch;
    apiKeyFor: (companyId: string) => Promise<string>;
    baseUrl?: string;
    timeoutMs?: number;
  }) {
    this.fetch = deps.fetch;
    this.apiKeyFor = deps.apiKeyFor;
    this.baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listPrinters(account: PrintAccount): Promise<readonly ListedPrinter[]> {
    const authorization = await this.authorization(account.companyId);
    let response: SafeResponse;
    try {
      response = await this.fetch(this.url('printers?limit=500'), {
        method: 'GET',
        headers: { authorization },
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      if (error instanceof SafeFetchError && !error.sent) {
        throw new ProviderRejected('provider_unreachable');
      }
      throw new ProviderRejected('bad_response');
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProviderRejected('auth_failed');
    }
    if (response.status !== 200) {
      throw new ProviderRejected('bad_response');
    }
    const body = parseBody(response);
    const parsed = printerListSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderRejected('bad_response');
    }
    return parsed.data.map(listedPrinter);
  }

  async submit(input: PrintSubmitInput, signal?: AbortSignal): Promise<{ providerJobId: string }> {
    const printerId = numericPrinterId(input.printerExternalId);
    if (printerId === null) {
      throw new ProviderRejected('bad_request');
    }
    const authorization = await this.authorization(input.companyId);
    const body = JSON.stringify({
      printerId,
      title: input.title,
      contentType: 'pdf_base64',
      content: input.pdf.toString('base64'),
      source: 'business-platform',
      options: { copies: input.copies, paper: input.paperSize },
      expireAfter: EXPIRE_AFTER_SECONDS,
    });
    let response: SafeResponse;
    try {
      response = await this.fetch(this.url('printjobs'), {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'X-Idempotency-Key': input.idempotencyKey,
        },
        body,
        timeoutMs: this.timeoutMs,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw submitTransport(error);
    }
    if (response.status === 201) {
      const parsed = jobIdSchema.safeParse(parseBodyUncertain(response));
      if (!parsed.success) {
        throw new ProviderUncertain('bad_response');
      }
      return { providerJobId: String(parsed.data) };
    }
    if (response.status === 400) {
      throw new ProviderRejected('bad_request');
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProviderRejected('auth_failed');
    }
    if (response.status === 404) {
      throw new ProviderRejected('printer_not_found');
    }
    if (response.status === 409) {
      throw new ProviderUncertain('idempotency_collision');
    }
    if (response.status === 429) {
      throw new ProviderRejected('rate_limited');
    }
    throw new ProviderUncertain(`provider_status_${String(response.status)}`);
  }

  async getJobState(
    input: { companyId: string; providerJobId: string },
    signal?: AbortSignal,
  ): Promise<ProviderJobStatus> {
    const authorization = await this.authorization(input.companyId);
    let response: SafeResponse;
    try {
      response = await this.fetch(
        this.url(`printjobs/${encodeURIComponent(input.providerJobId)}/states`),
        {
          method: 'GET',
          headers: { authorization },
          timeoutMs: this.timeoutMs,
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      if (error instanceof SafeFetchError) {
        throw error;
      }
      throw new ProviderRejected('bad_response');
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProviderRejected('auth_failed');
    }
    if (response.status !== 200) {
      throw new ProviderRejected('bad_response');
    }
    let body: unknown;
    try {
      body = parseJson(response.body);
    } catch {
      throw new ProviderRejected('bad_response');
    }
    const parsed = statesSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderRejected('bad_response');
    }
    return mapLatestState(flattenStates(parsed.data), input.providerJobId);
  }

  private url(path: string): string {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`;
    return new URL(path, base).toString();
  }

  private async authorization(companyId: string): Promise<string> {
    let apiKey: string;
    try {
      apiKey = await this.apiKeyFor(companyId);
    } catch (error) {
      if (error instanceof ProviderRejected) {
        throw error;
      }
      throw new ProviderRejected('credential_unavailable');
    }
    return `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}`;
  }
}

const whoamiSchema = z.object({
  email: z.string().min(1),
});

/**
 * `GET /whoami`. The key is the Basic user and is not put on the error.
 * Transport failures use the same classes as `listPrinters`.
 */
/** A non-200 answer from PrintNode. It carries the status only, never the body. */
export class PrintNodeHttpError extends Error {
  override readonly name = 'PrintNodeHttpError';
  readonly code = 'http_error';
  readonly status: number;

  constructor(status: number) {
    super('printnode_http_error');
    this.status = status;
  }
}

/**
 * `GET /whoami` with the given key.
 * A transport failure throws the shared client's error, a non-200 answer throws
 * `PrintNodeHttpError`, and a body that does not parse throws `ProviderRejected('bad_response')`.
 */
export async function printNodeWhoami(deps: {
  fetch: SafeFetch;
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<{ email: string }> {
  const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const authorization = `Basic ${Buffer.from(`${deps.apiKey}:`, 'utf8').toString('base64')}`;
  // A transport error from the shared client propagates unchanged, so the caller can
  // tell a blocked destination, an unreachable host and a timeout apart.
  const response = await deps.fetch(new URL('whoami', base).toString(), {
    method: 'GET',
    headers: { authorization },
    timeoutMs,
  });
  if (response.status !== 200) {
    throw new PrintNodeHttpError(response.status);
  }
  let body: unknown;
  try {
    body = parseJson(response.body);
  } catch {
    throw new ProviderRejected('bad_response');
  }
  const parsed = whoamiSchema.safeParse(body);
  if (!parsed.success) {
    throw new ProviderRejected('bad_response');
  }
  return { email: parsed.data.email };
}

function numericPrinterId(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return null;
  }
  return parsed;
}

function listedPrinter(printer: z.infer<typeof printerSchema>): ListedPrinter {
  const papers = printer.capabilities?.papers;
  return {
    externalPrinterId: String(printer.id),
    name: printer.name,
    description: printer.computer?.name ?? '',
    paperSizes: papers ? Object.keys(papers) : [],
    status: printerStatus(printer.state),
  };
}

function printerStatus(state: string | null | undefined): ListedPrinter['status'] {
  if (state === 'online') {
    return 'online';
  }
  if (typeof state === 'string' && state.length > 0) {
    return 'offline';
  }
  return 'unknown';
}

function submitTransport(error: unknown): Error {
  if (error instanceof SafeFetchError) {
    if (error.sent) {
      return new ProviderUncertain(error.code);
    }
    return new ProviderRejected('provider_unreachable');
  }
  return new ProviderUncertain('provider_unknown');
}

function parseBody(response: SafeResponse): unknown {
  try {
    return parseJson(response.body);
  } catch {
    throw new ProviderRejected('bad_response');
  }
}

function parseBodyUncertain(response: SafeResponse): unknown {
  try {
    return parseJson(response.body);
  } catch {
    throw new ProviderUncertain('bad_response');
  }
}

function parseJson(body: Buffer): unknown {
  return JSON.parse(body.toString('utf8')) as unknown;
}

function isStateList(entry: StateObject | readonly StateObject[]): entry is readonly StateObject[] {
  return Array.isArray(entry);
}

function flattenStates(entries: readonly (StateObject | readonly StateObject[])[]): StateObject[] {
  const states: StateObject[] = [];
  for (const entry of entries) {
    if (isStateList(entry)) {
      states.push(...entry);
    } else {
      states.push(entry);
    }
  }
  return states;
}

function mapLatestState(states: readonly StateObject[], providerJobId: string): ProviderJobStatus {
  const mine = states.filter((state) => String(state.printJobId) === providerJobId);
  const latest = latestState(mine);
  if (!latest) {
    return { state: 'pending' };
  }
  return mapState(latest);
}

function latestState(states: readonly StateObject[]): StateObject | undefined {
  let best: StateObject | undefined;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const state of states) {
    const parsed = Date.parse(state.createTimestamp);
    const time = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    if (!best || time >= bestTime) {
      best = state;
      bestTime = time;
    }
  }
  return best;
}

function mapState(state: StateObject): ProviderJobStatus {
  const raw = state.state;
  switch (state.state) {
    case 'new':
      return { state: 'pending', raw };
    case 'sent_to_client':
      return { state: 'delivered', raw };
    case 'done':
      return { state: 'done', raw };
    case 'error': {
      const message = cleanMessage(state.message);
      return message
        ? { state: 'failed', reason: 'printer_error', message, raw }
        : { state: 'failed', reason: 'printer_error', raw };
    }
    case 'expired':
      return { state: 'failed', reason: 'expired', raw };
    case 'deleted':
      return { state: 'failed', reason: 'deleted', raw };
    default:
      return { state: 'pending', raw };
  }
}

function cleanMessage(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const cleaned = value
    .replace(/\p{Cc}/gu, '')
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : undefined;
}
