import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repositoryRoot } from './root';

export const GIFT_FIXTURE = 'packages/integrations/shopify/fixtures/order-1001-paid-greek-gift.json';

export function giftMessageSha256(message: string): string {
  return createHash('sha256').update(Buffer.from(message, 'utf8')).digest('hex');
}

export function giftMessageFromShopifyPayload(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.customAttributes)) {
    throw new Error('fixture has no customAttributes');
  }
  for (const item of payload.customAttributes) {
    if (isRecord(item) && item.key === 'Gift Message' && typeof item.value === 'string') {
      return item.value;
    }
  }
  throw new Error('fixture has no Gift Message');
}

export function readGiftFixture(root = repositoryRoot()): string {
  const text = readFileSync(resolve(root, GIFT_FIXTURE), 'utf8');
  return giftMessageFromShopifyPayload(JSON.parse(text) as unknown);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
