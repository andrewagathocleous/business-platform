import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../core/session.store';
import { CreateRequests } from './create-requests';
import { PendingRequest } from './pending-request';

const URL = '/api/c/company-1/payments';
const BODY = { amount: '20.00' };

beforeEach(() => {
  sessionStorage.clear();
});

describe('CreateRequests', () => {
  it.each([401, 403, 409, 422])(
    'keeps a lost answer after a %i retry until an explicit Discard',
    (status) => {
      const { creates, http, succeeded } = setup();
      creates.start('payments', BODY);
      const first = http.expectOne(URL);
      const key = first.request.headers.get('Idempotency-Key');
      first.error(new ProgressEvent('error'));
      creates.discard(); // An unanswered request alone is not enough to allow discarding.
      expect(creates.pending()?.request.key).toBe(key);
      creates.retry();
      const retry = http.expectOne(URL);
      expect(retry.request.headers.get('Idempotency-Key')).toBe(key);
      expect(retry.request.body).toEqual(BODY);
      retry.flush({}, { status, statusText: 'Refused' });
      expect(creates.pending()?.request.key).toBe(key);
      expect(creates.retryRefused()).toBe(true);
      creates.start('payments', { amount: '99.00' });
      http.expectNone(URL);
      expect(succeeded).not.toHaveBeenCalled();
      expect(sessionStorage.length).toBe(1);
      creates.discard();
      expect(creates.pending()).toBeNull();
      expect(sessionStorage.length).toBe(0);
      http.verify();
    },
  );

  it('settles a first definite 4xx without an earlier lost answer', () => {
    const { creates, http, user } = setup();
    creates.start('payments', BODY);
    user.set(null); // The interceptor abandons the session before the error subscriber runs.
    http.expectOne(URL).flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(creates.pending()).toBeNull();
    expect(creates.retryRefused()).toBe(false);
    expect(sessionStorage.length).toBe(0);
    http.verify();
  });

  it('keeps an unanswered attempt when a refused retry abandons the session', () => {
    const { creates, http, user } = setup();
    creates.start('payments', BODY);
    const first = http.expectOne(URL);
    const key = first.request.headers.get('Idempotency-Key');
    first.error(new ProgressEvent('error'));
    creates.retry();
    user.set(null);
    http.expectOne(URL).flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(creates.pending()?.request.key).toBe(key);
    expect(creates.retryRefused()).toBe(true);
    expect(sessionStorage.length).toBe(1);
    http.verify();
  });

  it('settles a lost answer only on a readable success even after a refused retry', () => {
    const { creates, http, succeeded } = setup();
    creates.start('payments', BODY);
    http.expectOne(URL).flush({});
    creates.retry();
    http.expectOne(URL).flush({}, { status: 403, statusText: 'Forbidden' });
    creates.retry();
    http.expectOne(URL).flush({ payment: { id: 'p' } });
    expect(creates.pending()).toBeNull();
    expect(creates.retryRefused()).toBe(false);
    expect(succeeded).toHaveBeenCalledOnce();
    expect(sessionStorage.length).toBe(0);
    http.verify();
  });

  it("restores this tab's pending attempt and keeps it after a refused retry", () => {
    const store = new PendingRequest('company-1', 'payments', 'invoice.invoice-1', () => 'user-1');
    const request = store.prepare(BODY);
    const { creates, http } = setup();
    expect(creates.pending()?.request).toEqual({ ...request, lost: true });
    creates.start('payments', { amount: '99.00' });
    http.expectNone(URL);
    creates.retry();
    const retry = http.expectOne(URL);
    expect(retry.request.body).toEqual(BODY);
    expect(retry.request.headers.get('Idempotency-Key')).toBe(request.key);
    retry.flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(creates.pending()?.request.key).toBe(request.key);
    expect(creates.retryRefused()).toBe(true);
    expect(store.read()?.lost).toBe(true);
    http.verify();
  });

  it('never lets a late success remove a newer attempt in the same context', () => {
    const { creates, http, succeeded } = setup();
    creates.start('payments', BODY);
    const old = http.expectOne(URL);
    const store = new PendingRequest('company-1', 'payments', 'invoice.invoice-1', () => 'user-1');
    store.settle(creates.pending()?.request.key ?? '');
    const newer = store.prepare({ amount: '30.00' });
    old.flush({ payment: { id: 'old-payment' } });
    expect(store.read()?.key).toBe(newer.key);
    expect(creates.pending()?.request.key).toBe(newer.key);
    expect(succeeded).not.toHaveBeenCalled();
    http.verify();
  });

  it("never resends another user's cached request after the active user changes", () => {
    const { creates, http, user } = setup();
    creates.start('payments', BODY);
    http.expectOne(URL).error(new ProgressEvent('error'));
    expect(creates.pending()?.request.ownerId).toBe('user-1');
    user.set({ id: 'user-2' });
    creates.retry();
    expect(creates.pending()).toBeNull();
    expect(sessionStorage.length).toBe(0);
    http.expectNone(URL);
    http.verify();
  });

  it.each(['throws', 'silently refuses'])('sends nothing when sessionStorage %s writes', (mode) => {
    const { creates, http } = setup();
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      if (mode === 'throws') throw new Error('blocked');
    });
    try {
      creates.start('payments', BODY);
      expect(creates.blocked()).toBe(true);
      expect(creates.failure()?.key).toBe('payments.errors.storage');
      http.expectNone(URL);
    } finally {
      write.mockRestore();
    }
    http.verify();
  });

  it.each(['throws', 'silently refuses'])(
    'keeps a lost attempt blocked when sessionStorage %s the loss marker',
    (mode) => {
      const { creates, http } = setup();
      creates.start('payments', BODY);
      const original = http.expectOne(URL);
      const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        if (mode === 'throws') throw new Error('blocked');
      });
      try {
        original.error(new ProgressEvent('error'));
        expect(creates.pending()?.request.lost).toBe(true);
        creates.retry();
        expect(creates.blocked()).toBe(true);
        http.expectNone(URL);
      } finally {
        write.mockRestore();
      }
      creates.retry();
      http.expectOne(URL).flush({}, { status: 401, statusText: 'Unauthorized' });
      expect(creates.pending()).not.toBeNull();
      expect(creates.retryRefused()).toBe(true);
      http.verify();
    },
  );
});

function setup() {
  const user = signal<{ id: string } | null>({ id: 'user-1' });
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: SessionStore, useValue: { user } },
    ],
  });
  const creates = TestBed.runInInjectionContext(() => new CreateRequests());
  const succeeded = vi.fn();
  creates.reset('company-1', 'invoice.invoice-1', ['payments'], succeeded);
  return { creates, succeeded, user, http: TestBed.inject(HttpTestingController) };
}
