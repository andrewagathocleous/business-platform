import { describe, expect, it } from 'vitest';
import { accessForStoredFile } from './file.scope';

const order = { storeId: 'store-1', locationId: 'location-1' };

describe('accessForStoredFile', () => {
  it('rejects an unknown kind', () => {
    expect(
      accessForStoredFile('invoice', { sourceType: null, sourceId: null, order: null }),
    ).toEqual({ found: false });
    expect(
      accessForStoredFile('other', { sourceType: 'order', sourceId: 'order-1', order }),
    ).toEqual({ found: false });
  });

  it('rejects a packing slip or gift message without a resolvable order', () => {
    expect(
      accessForStoredFile('packing_slip', { sourceType: null, sourceId: null, order: null }),
    ).toEqual({
      found: false,
    });
    expect(
      accessForStoredFile('gift_message', {
        sourceType: 'order',
        sourceId: 'missing',
        order: null,
      }),
    ).toEqual({
      found: false,
    });
    expect(
      accessForStoredFile('packing_slip', { sourceType: 'note', sourceId: 'note-1', order }),
    ).toEqual({
      found: false,
    });
  });

  it('names invoice, test print, and an order-backed document', () => {
    expect(
      accessForStoredFile('invoice_pdf', { sourceType: null, sourceId: null, order: null }),
    ).toEqual({
      found: true,
      scopes: [{ type: 'company', id: null }],
      permission: 'invoice.view',
    });
    expect(
      accessForStoredFile('test_print', { sourceType: null, sourceId: null, order: null }),
    ).toEqual({
      found: true,
      scopes: [{ type: 'company', id: null }],
      permission: 'document.download',
    });
    expect(
      accessForStoredFile('gift_message', { sourceType: 'order', sourceId: 'order-1', order }),
    ).toEqual({
      found: true,
      scopes: [
        { type: 'store', id: 'store-1' },
        { type: 'location', id: 'location-1' },
      ],
      permission: 'document.download',
    });
  });
});
