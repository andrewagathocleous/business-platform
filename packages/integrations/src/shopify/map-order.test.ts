import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GIFT_MESSAGE_MAX_CODE_POINTS } from '../gift-message-length';
import {
  FINANCIAL_STATUS_MAP,
  SHOPIFY_ORDER_API_VERSION,
  ShopifyMapError,
  mapShopifyOrder,
  shopifyFixturesDirectory,
  type StoreOrderConfig,
} from './map-order';

const STORE: StoreOrderConfig = {
  giftMessageKeys: ['Gift Message', 'gift_message', 'Gift message'],
  deliveryMethodMap: {
    local: 'courier_cy',
    international: 'post_international',
    collection: 'collection',
  },
};

const FIXTURES = [
  'order-1001-paid-greek-gift.json',
  'order-1001-updated-later.json',
  'order-1001-updated-earlier.json',
  'order-1002-pending-international.json',
  'order-1003-emoji-gift.json',
  'order-2001-company-b.json',
] as const;

describe('mapShopifyOrder', () => {
  it('documents the financial status table and the unverified API version', () => {
    expect(SHOPIFY_ORDER_API_VERSION).toBe('unverified; check in Phase 2');
    expect(FINANCIAL_STATUS_MAP).toEqual({
      PENDING: 'pending',
      AUTHORIZED: 'authorized',
      PARTIALLY_PAID: 'partially_paid',
      PAID: 'paid',
      PARTIALLY_REFUNDED: 'partially_refunded',
      REFUNDED: 'refunded',
      VOIDED: 'voided',
    });
    expect(mapShopifyOrder(load('order-1001-paid-greek-gift.json'), STORE).paymentStatus).toBe(
      'paid',
    );
    const unknown = load('order-1001-paid-greek-gift.json');
    unknown.displayFinancialStatus = 'EXPIRED';
    expect(mapShopifyOrder(unknown, STORE).paymentStatus).toBe('unknown');
  });

  it('keeps the Greek gift message bytes, including the trailing space', () => {
    const payload = load('order-1001-paid-greek-gift.json');
    const gift = giftValue(payload);
    if (gift === undefined) {
      throw new Error('fixture gift message missing');
    }
    const mapped = mapShopifyOrder(payload, STORE);
    expect(Buffer.from(mapped.giftMessage ?? '', 'utf8').equals(Buffer.from(gift, 'utf8'))).toBe(
      true,
    );
    expect(mapped.giftMessage?.includes('Με αγάπη, \n')).toBe(true);
    expect(mapped.customerNote).toBe('Παρακαλώ μετά τις 17:00.');
    expect(mapped.lines).toHaveLength(3);
    expect(mapped.deliveryMethod).toBe('courier_cy');
    expect(mapped.recipient?.phone).toBe('+35799001001');
    expect(mapped.subtotal).toBe('38.00');
    expect(mapped.lines[0]?.unitPrice).toBe('8.5000');
  });

  it('maps the later phone, the stale timestamp, international delivery and the emoji', () => {
    const later = mapShopifyOrder(load('order-1001-updated-later.json'), STORE);
    const earlier = mapShopifyOrder(load('order-1001-updated-earlier.json'), STORE);
    expect(later.externalId).toBe(earlier.externalId);
    expect(later.sourceUpdatedAt.getTime()).toBeGreaterThan(earlier.sourceUpdatedAt.getTime());
    expect(later.recipient?.phone).toBe('+35799001002');
    expect(earlier.recipient?.phone).toBe('+35799001000');
    const international = mapShopifyOrder(load('order-1002-pending-international.json'), STORE);
    expect(international.paymentStatus).toBe('pending');
    expect(international.deliveryMethod).toBe('post_international');
    expect((international.giftMessage ?? '').length).toBeGreaterThanOrEqual(600);
    const emoji = mapShopifyOrder(load('order-1003-emoji-gift.json'), STORE);
    expect(emoji.giftMessage).toBe('Many happy returns 🎁');
    expect(mapShopifyOrder(load('order-2001-company-b.json'), STORE).externalNumber).toBe('#2001');
  });

  it('keeps a gift message that is longer than the card', () => {
    const fitting = load('order-1001-paid-greek-gift.json');
    setGift(fitting, 'i'.repeat(GIFT_MESSAGE_MAX_CODE_POINTS));
    expect(mapShopifyOrder(fitting, STORE).giftMessage).toBe(
      'i'.repeat(GIFT_MESSAGE_MAX_CODE_POINTS),
    );
    const smiles = load('order-1001-paid-greek-gift.json');
    setGift(smiles, '\u{1F60A}'.repeat(5000));
    expect(mapShopifyOrder(smiles, STORE).giftMessage).toBe('\u{1F60A}'.repeat(5000));
    const overText = `${'i'.repeat(GIFT_MESSAGE_MAX_CODE_POINTS)}SENTINEL`;
    const over = load('order-1001-paid-greek-gift.json');
    setGift(over, overText);
    expect(mapShopifyOrder(over, STORE).giftMessage).toBe(overText);
  });

  it('falls back to unknown delivery and rejects a JSON number in a money field', () => {
    const payload = load('order-1001-paid-greek-gift.json');
    payload.shippingLine = { code: 'teleport', title: 'Teleport' };
    expect(mapShopifyOrder(payload, STORE).deliveryMethod).toBe('unknown');
    const money = load('order-1001-paid-greek-gift.json');
    const sets = money.subtotalPriceSet;
    if (!isRecord(sets) || !isRecord(sets.shopMoney)) {
      throw new Error('fixture money missing');
    }
    sets.shopMoney.amount = 38;
    expect(() => mapShopifyOrder(money, STORE)).toThrow(ShopifyMapError);
  });

  it('marks every fixture with the unverified API version', () => {
    for (const name of FIXTURES) {
      const payload = load(name);
      const meta = payload._meta;
      expect(isRecord(meta) ? meta.apiVersion : undefined).toBe(SHOPIFY_ORDER_API_VERSION);
    }
    expect(shopifyFixturesDirectory().endsWith('/shopify/fixtures')).toBe(true);
  });
});

function load(name: (typeof FIXTURES)[number]): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(shopifyFixturesDirectory(), name), 'utf8'),
  );
  if (!isRecord(parsed)) {
    throw new Error(`${name} is not an object`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function setGift(payload: Record<string, unknown>, gift: string): void {
  const attributes = payload['customAttributes'];
  if (!isUnknownArray(attributes)) {
    throw new Error('attributes missing');
  }
  for (const entry of attributes) {
    if (isRecord(entry) && entry['key'] === 'Gift Message') {
      entry['value'] = gift;
      return;
    }
  }
  throw new Error('gift missing');
}

function giftValue(payload: Record<string, unknown>): string | undefined {
  const attributes = payload['customAttributes'];
  if (!isUnknownArray(attributes)) {
    return undefined;
  }
  for (const entry of attributes) {
    if (!isRecord(entry) || entry['key'] !== 'Gift Message' || typeof entry['value'] !== 'string') {
      continue;
    }
    return entry['value'];
  }
  return undefined;
}
