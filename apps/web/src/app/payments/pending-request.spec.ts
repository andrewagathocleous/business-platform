import { HttpErrorResponse } from '@angular/common/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createdId, definiteRefusal, PendingRequest } from './pending-request';

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe('PendingRequest', () => {
  it.each(['user-2', undefined])(
    'removes an attempt owned by %s instead of exposing its body',
    (ownerId) => {
      const other = new PendingRequest('a', 'payments', 'i', () => 'user-2').prepare({
        amount: '20.00',
        reference: 'Private reference',
        notes: 'Private notes',
      });
      sessionStorage.setItem('bp.pending.a.payments.i', JSON.stringify({ ...other, ownerId }));
      const own = new PendingRequest('a', 'payments', 'i', () => 'user-1');
      expect(own.read()).toBeNull();
      expect(sessionStorage.length).toBe(0);
      expect(own.prepare({ amount: '30.00' })).toMatchObject({
        ownerId: 'user-1',
        body: { amount: '30.00' },
      });
    },
  );

  it('hides but preserves an attempt while signed out and restores it for the same user', () => {
    let ownerId: string | null = 'user-1';
    const store = new PendingRequest('a', 'payments', 'i', () => ownerId);
    const attempt = store.prepare({ amount: '20.00' });
    ownerId = null;
    expect(store.read()).toBeNull();
    expect(() => store.prepare({ amount: '30.00' })).toThrow('signed-in user');
    expect(sessionStorage.length).toBe(1);
    ownerId = 'user-1';
    expect(store.read()).toEqual(attempt);
  });

  it("fails closed when another user's attempt cannot be removed", () => {
    new PendingRequest('a', 'payments', 'i', () => 'user-2').prepare({ amount: '20.00' });
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {});
    try {
      const own = new PendingRequest('a', 'payments', 'i', () => 'user-1');
      expect(() => own.read()).toThrow('not cleared');
      expect(() => own.prepare({ amount: '30.00' })).toThrow('not cleared');
    } finally {
      remove.mockRestore();
    }
  });

  it.each([
    ['payments', 'invoice'],
    ['allocations', 'invoice'],
    ['allocations', 'client'],
    ['refunds', 'client'],
  ] as const)('recovers %s attempts for a %s across UUID casing changes', (operation, context) => {
    const companyId = 'e0bd9a30-78a9-48d4-b3f5-69eba6afcb79';
    const contextId = 'a3b7d269-f8e5-4bd7-9cfe-64a6d43c2dbe';
    for (const uppercaseFirst of [true, false]) {
      const first = new PendingRequest(
        uppercaseFirst ? companyId.toUpperCase() : companyId,
        operation,
        `${context}.${uppercaseFirst ? contextId.toUpperCase() : contextId}`,
        () => 'user-1',
      );
      const body = { amount: '20.00', reference: 'ABC', notes: 'Ευχαριστώ\n  as typed ' };
      const followUp = { invoiceId: contextId.toUpperCase(), amount: '20.00' };
      const attempt = first.prepare(body, followUp);
      first.markLost(attempt.key);
      const reopened = new PendingRequest(
        uppercaseFirst ? companyId : companyId.toUpperCase(),
        operation,
        `${context}.${uppercaseFirst ? contextId : contextId.toUpperCase()}`,
        () => 'user-1',
      );
      expect(first.storageKey).toBe(`bp.pending.${companyId}.${operation}.${context}.${contextId}`);
      expect(reopened.storageKey).toBe(first.storageKey);
      expect(reopened.read()).toEqual({ ...attempt, lost: true });
      expect(reopened.prepare({ amount: '99.00' })).toEqual({ ...attempt, lost: true });
      expect(sessionStorage.length).toBe(1);
      reopened.settle(attempt.key);
      expect(first.read()).toBeNull();
    }
  });

  it('stores the body and intent before send and restores the same attempt after reload', () => {
    const helper = new PendingRequest('company-a', 'payments', 'invoice-a', () => 'user-1');
    const body = { amount: '10.00', notes: 'Ευχαριστώ\n  as typed ' };
    const followUp = { invoiceId: 'invoice-a', amount: '10.00' };
    const saved = helper.prepare(body, followUp);
    expect(saved.key).toMatch(/^[a-f0-9-]{36}$/);
    body.amount = '99.00';
    expect(helper.read()).toEqual({
      key: saved.key,
      ownerId: 'user-1',
      body: { amount: '10.00', notes: 'Ευχαριστώ\n  as typed ' },
      followUp,
    });
    const reloaded = new PendingRequest('company-a', 'payments', 'invoice-a', () => 'user-1');
    expect(reloaded.prepare({ amount: '999.00' })).toEqual(helper.read());
    reloaded.settle(saved.key);
    expect(helper.read()).toBeNull();
    expect(helper.prepare({ amount: '10.00' }).key).not.toBe(saved.key);
  });

  it('names the company, operation and context and never clears a newer key', () => {
    const first = new PendingRequest('a', 'refunds', 'client-a', () => 'user-1');
    const attempt = first.prepare({ amount: '10.00' });
    expect(new PendingRequest('b', 'refunds', 'client-a', () => 'user-1').read()).toBeNull();
    expect(new PendingRequest('a', 'allocations', 'client-a', () => 'user-1').read()).toBeNull();
    expect(new PendingRequest('a', 'refunds', 'client-b', () => 'user-1').read()).toBeNull();
    first.settle(attempt.key);
    const newer = first.prepare({ amount: '20.00' });
    first.settle(attempt.key);
    expect(first.read()?.key).toBe(newer.key);
    first.markLost(attempt.key);
    expect(first.read()?.key).toBe(newer.key);
    expect(first.read()?.lost).toBeUndefined();
  });

  it('keeps attempts per tab and never reads or writes them through localStorage', () => {
    const firstTab = new PendingRequest('a', 'payments', 'i', () => 'user-1');
    const first = firstTab.prepare({ amount: '20.00' });
    expect(JSON.parse(sessionStorage.getItem(firstTab.storageKey) ?? 'null')).toEqual(first);
    expect(localStorage.getItem(firstTab.storageKey)).toBeNull();

    // Even a leftover entry in shared storage must not become this tab's pending attempt.
    localStorage.setItem(firstTab.storageKey, JSON.stringify(first));
    const otherTabStorage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => otherTabStorage.get(key) ?? null,
      setItem: (key: string, value: string) => otherTabStorage.set(key, value),
      removeItem: (key: string) => otherTabStorage.delete(key),
    });
    const otherTab = new PendingRequest('a', 'payments', 'i', () => 'user-1');
    expect(otherTab.read()).toBeNull();
    const other = otherTab.prepare({ amount: '30.00' });
    expect(other.key).not.toBe(first.key);
    expect(firstTab.read()).toEqual(first);
    expect(otherTab.read()).toEqual(other);
    expect(JSON.parse(localStorage.getItem(firstTab.storageKey) ?? 'null')).toEqual(first);
  });

  it('saves that an answer was lost so a reload also keeps it after a refusal', () => {
    const first = new PendingRequest('a', 'payments', 'i', () => 'user-1');
    const request = first.prepare({ amount: '20.00' });
    first.markLost(request.key);
    expect(new PendingRequest('a', 'payments', 'i', () => 'user-1').read()).toEqual({
      ...request,
      lost: true,
    });
  });

  it('fails closed when storage throws, silently refuses a write or contains corrupt data', () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn((): void => {
        throw new Error('blocked');
      }),
      removeItem: vi.fn(),
    };
    expect(() =>
      new PendingRequest('a', 'payments', 'i', () => 'user-1', storage).prepare({}),
    ).toThrow();
    storage.setItem.mockImplementation(() => undefined);
    expect(() =>
      new PendingRequest('a', 'payments', 'i', () => 'user-1', storage).prepare({}),
    ).toThrow('not saved');
    sessionStorage.setItem('bp.pending.a.payments.i', '{');
    expect(() => new PendingRequest('a', 'payments', 'i', () => 'user-1').read()).toThrow();
  });

  it('settles only definite refusals, and accepts only a readable created object', () => {
    for (const status of [400, 401, 403, 409, 422])
      expect(definiteRefusal(new HttpErrorResponse({ status }))).toBe(true);
    for (const status of [0, 200, 500, 503])
      expect(definiteRefusal(new HttpErrorResponse({ status }))).toBe(false);
    expect(definiteRefusal(new Error('lost'))).toBe(false);
    expect(createdId({ payment: { id: 'p' } }, 'payment')).toBe('p');
    expect(createdId({ payment: {} }, 'payment')).toBeNull();
    expect(createdId(null, 'payment')).toBeNull();
  });
});
