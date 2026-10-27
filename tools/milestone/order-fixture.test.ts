import { describe, expect, it } from 'vitest';
import { giftMessageSha256 } from './gift';
import { milestoneExternalId, milestoneGiftMessage, milestoneOrderPayload } from './order-fixture';

describe('milestone order fixture', () => {
  it('uses a unique fictional id and keeps greek line breaks in the gift message', () => {
    const externalId = milestoneExternalId(1_700_000_000_000);
    expect(externalId).toBe('MS-1700000000000');
    const gift = milestoneGiftMessage(externalId);
    expect(gift).toContain('Με αγάπη, \n');
    expect(gift.endsWith(externalId)).toBe(true);
    const payload = milestoneOrderPayload(externalId, gift, '2026-03-01T00:00:00.000Z');
    expect(payload.id).toBe(externalId);
    expect(payload.name).toBe('#MS-1700000000000');
    const attributes = payload.customAttributes as { key: string; value: string }[];
    expect(attributes[0]?.value).toBe(gift);
    expect(giftMessageSha256(gift)).toMatch(/^[0-9a-f]{64}$/);
    expect(giftMessageSha256(`${gift} `)).not.toBe(giftMessageSha256(gift));
  });
});
