import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideTransloco } from '@jsverse/transloco';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { LoginPage } from '../pages/login';
import { CreateRequests } from '../payments/create-requests';
import type { MeResponse } from './models';
import { SessionStore } from './session.store';

const PENDING = {
  'bp.pending.company-1.payments.invoice.invoice-1': JSON.stringify({
    ownerId: 'user-1',
    key: 'payment',
    body: { amount: '20.00' },
  }),
  'bp.pending.company-1.allocations.invoice.invoice-1': JSON.stringify({
    ownerId: 'user-1',
    key: 'allocation',
    body: { amount: '20.00' },
  }),
  'bp.pending.company-2.refunds.client.client-1': JSON.stringify({
    ownerId: 'user-2',
    key: 'refund',
    body: { amount: '10.00' },
  }),
  'bp.pending.legacy': JSON.stringify({ key: 'legacy', body: { amount: '30.00' } }),
  'bp.pending.malformed': '{',
};
const UNRELATED = {
  'preferences.locale': 'en',
  'bp.pending': 'different key',
  'bp.pendingOther.invoice': 'different prefix',
  'bp.invoicePrint.company-1.invoice-1': 'unanswered print',
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  for (const [key, value] of Object.entries({ ...PENDING, ...UNRELATED })) {
    sessionStorage.setItem(key, value);
    localStorage.setItem(key, value);
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe('Pending payment attempts at session boundaries', () => {
  it.each([200, 500])(
    'clears only pending attempts before logout responds with %i',
    async (status) => {
      const { session, http } = setup();
      const logout = session.logout();
      expectOnlyUnrelatedStorage();
      const request = http.expectOne('/api/auth/logout');
      if (status === 200) {
        request.flush({});
        await logout;
      } else {
        request.flush({}, { status, statusText: 'Unavailable' });
        await expect(logout).rejects.toMatchObject({ status });
      }
      expectOnlyUnrelatedStorage();
      http.verify();
    },
  );

  it('keeps attempts when /login opens with a live session and only redirects', async () => {
    const { session, http, navigate } = setup();
    const loaded = session.load();
    http.expectOne('/api/me').flush(me('user-1'));
    await expect(loaded).resolves.toBe('ready');
    const before = storedEntries();
    const fixture = TestBed.createComponent(LoginPage);
    await fixture.whenStable();
    expect(storedEntries()).toEqual(before);
    expect(sessionStorage.getItem('bp.pending.company-1.payments.invoice.invoice-1')).toBe(
      PENDING['bp.pending.company-1.payments.invoice.invoice-1'],
    );
    expect(navigate).toHaveBeenCalled();
    http.expectNone('/api/auth/providers');
    http.verify();
  });

  it.each([false, true])(
    'keeps all attempts while the login page is open (expired session: %s)',
    async (expired) => {
      const { session, http } = setup();
      if (expired) {
        const load = session.load();
        http.expectOne('/api/me').flush({}, { status: 401, statusText: 'Unauthorized' });
        await expect(load).resolves.toBe('anonymous');
      }
      const fixture = TestBed.createComponent(LoginPage);
      expect(storedEntries()).toEqual({ ...PENDING, ...UNRELATED });
      http.expectOne('/api/auth/providers').flush({ devLogin: false, oidc: false });
      await fixture.whenStable();
      expect(storedEntries()).toEqual({ ...PENDING, ...UNRELATED });
      http.verify();
    },
  );

  it('resends the original key and body after a lost answer, a 401 retry and the same user signing in', async () => {
    const { session, http } = setup();
    const loaded = session.load();
    http.expectOne('/api/me').flush(me('user-1'));
    await loaded;
    const creates = TestBed.runInInjectionContext(() => new CreateRequests());
    creates.reset('company-3', 'invoice.invoice-3', ['payments'], () => {});
    const body = { amount: '20.00', reference: 'Demo receipt', notes: 'Ευχαριστώ\n  as typed ' };
    creates.start('payments', body);
    const first = http.expectOne('/api/c/company-3/payments');
    const key = first.request.headers.get('Idempotency-Key');
    first.error(new ProgressEvent('error'));
    creates.retry();
    http
      .expectOne('/api/c/company-3/payments')
      .flush({}, { status: 401, statusText: 'Unauthorized' });
    session.abandon();
    const fixture = TestBed.createComponent(LoginPage);
    http.expectOne('/api/auth/providers').flush({ devLogin: false, oidc: false });
    await fixture.whenStable();
    await signIn(fixture.componentInstance, 'user-1', http);
    const reopened = TestBed.runInInjectionContext(() => new CreateRequests());
    reopened.reset('company-3', 'invoice.invoice-3', ['payments'], () => {});
    expect(reopened.pending()?.request).toMatchObject({ key, ownerId: 'user-1', body, lost: true });
    reopened.retry();
    const retry = http.expectOne('/api/c/company-3/payments');
    expect(retry.request.headers.get('Idempotency-Key')).toBe(key);
    expect(retry.request.body).toEqual(body);
    retry.flush({ payment: { id: 'payment-3' } });
    expect(sessionStorage.getItem('bp.pending.company-3.payments.invoice.invoice-3')).toBeNull();
    http.verify();
  });

  it("removes every other user's and ownerless attempt when a different user signs in", async () => {
    const { http } = setup();
    const fixture = TestBed.createComponent(LoginPage);
    http.expectOne('/api/auth/providers').flush({ devLogin: false, oidc: false });
    await fixture.whenStable();
    await signIn(fixture.componentInstance, 'user-2', http);
    const ownKey = 'bp.pending.company-2.refunds.client.client-1';
    expect(storedEntries()).toEqual({ ...UNRELATED, [ownKey]: PENDING[ownKey] });
    expectUnrelatedStorage();
    http.verify();
  });

  it('still signs out when browser storage is unavailable', async () => {
    const { session, http } = setup();
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new Error('blocked');
    });
    const logout = session.logout();
    http.expectOne('/api/auth/logout').flush({});
    await expect(logout).resolves.toBeUndefined();
    http.verify();
  });
});

function setup() {
  TestBed.configureTestingModule({
    imports: [LoginPage],
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      provideTransloco({
        config: { availableLangs: ['en', 'el'], defaultLang: 'en', prodMode: true },
        loader: AppTranslocoLoader,
      }),
    ],
  });
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  return {
    session: TestBed.inject(SessionStore),
    http: TestBed.inject(HttpTestingController),
    navigate,
  };
}

function expectOnlyUnrelatedStorage(): void {
  expect(sessionStorage.length).toBe(Object.keys(UNRELATED).length);
  expectUnrelatedStorage();
}
function expectUnrelatedStorage(): void {
  for (const [key, value] of Object.entries(UNRELATED)) {
    expect(sessionStorage.getItem(key)).toBe(value);
  }
  expect(localStorage.length).toBe(Object.keys(PENDING).length + Object.keys(UNRELATED).length);
  for (const [key, value] of Object.entries({ ...PENDING, ...UNRELATED })) {
    expect(localStorage.getItem(key)).toBe(value);
  }
}

function me(id: string): MeResponse {
  return {
    user: {
      id,
      email: `${id}@example.test`,
      displayName: 'Demo user',
      locale: 'en',
      isPlatformOwner: false,
    },
    companies: [],
    session: { idleExpiresAt: '2026-10-29T00:00:00Z', absoluteExpiresAt: '2026-10-30T00:00:00Z' },
  };
}
async function signIn(page: LoginPage, id: string, http: HttpTestingController): Promise<void> {
  const signingIn = page.signIn(`${id}@example.test`);
  http.expectOne('/api/auth/dev/login').flush({});
  await Promise.resolve();
  http.expectOne('/api/me').flush(me(id));
  await signingIn;
  expect(page.failed()).toBe(false);
}

function storedEntries(): Record<string, string | null> {
  return Object.fromEntries(
    Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]),
  );
}
