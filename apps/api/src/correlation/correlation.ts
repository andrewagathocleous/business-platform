import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export const CORRELATION_HEADER = 'X-Correlation-Id';
export const CORRELATION_ID = /^[A-Za-z0-9-]{8,64}$/;

type CorrelationStore = {
  correlationId: string;
};

export const correlationStorage = new AsyncLocalStorage<CorrelationStore>();

export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}

export function resolveCorrelationId(header: string | undefined): string {
  if (header !== undefined && CORRELATION_ID.test(header)) {
    return header;
  }
  return uuidv7();
}

/** RFC 9562 UUID version 7: 48-bit Unix time in milliseconds, then random bits. */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(now);
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
