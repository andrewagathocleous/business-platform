import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { MessageService } from 'primeng/api';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { LoginPage } from '../pages/login';
import { apiInterceptor } from './api.interceptor';
import { CompanyContextStore } from './company-context.store';
import type { MeResponse } from './models';
import { SessionStore } from './session.store';

@Component({ selector: 'bp-orders-stub', template: 'Orders' })
class OrdersStub {}

function localeOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('locale' in body)) {
    return null;
  }
  const locale = (body as Record<string, unknown>)['locale'];
  return typeof locale === 'string' ? locale : null;
}

function me(locale: 'en' | 'el' = 'en', id = 'user-1'): MeResponse {
  return {
    user: {
      id,
      email: 'admin.a@example.test',
      displayName: 'Admin A',
      locale,
      isPlatformOwner: false,
    },
    companies: [
      {
        id: 'company-1',
        legalName: 'Demo',
        tradingName: 'Nutbox (demo data)',
        status: 'active',
      },
    ],
    session: {
      idleExpiresAt: '2026-10-22T00:00:00.000Z',
      absoluteExpiresAt: '2026-10-29T00:00:00.000Z',
    },
  };
}

async function transloco(): Promise<void> {
  const service = TestBed.inject(TranslocoService);
  await firstValueFrom(service.load('en'));
  service.setActiveLang('en');
}

function setupStore(): { store: SessionStore; http: HttpTestingController } {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTransloco({
        config: {
          availableLangs: ['en', 'el'],
          defaultLang: 'en',
          reRenderOnLangChange: true,
          prodMode: true,
        },
        loader: AppTranslocoLoader,
      }),
    ],
  });
  return { store: TestBed.inject(SessionStore), http: TestBed.inject(HttpTestingController) };
}

async function signedIn(store: SessionStore, http: HttpTestingController): Promise<void> {
  const pending = store.load();
  http.expectOne('/api/me').flush(me());
  await pending;
}

async function localeRequests(http: HttpTestingController, count: number) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const found = http.match((request) => request.method === 'PATCH' && request.url === '/api/me');
    if (found.length >= count) {
      return found;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error(`expected ${String(count)} locale updates`);
}

describe('SessionStore', () => {
  it('does not cache a transient startup failure as signed out', async () => {
    const { store, http } = setupStore();
    await transloco();
    const first = store.load();
    http.expectOne('/api/me').flush(
      { error: { message: 'unavailable', correlationId: 'corr-503' } },
      { status: 503, statusText: 'Unavailable' },
    );
    await expect(first).resolves.toBe('error');
    expect(store.user()).toBeNull();
    expect(store.bootstrapError()).toBe('corr-503');

    const second = store.load();
    http.expectOne('/api/me').flush(me());
    await expect(second).resolves.toBe('ready');
    expect(store.user()?.id).toBe('user-1');
    http.verify();
  });

  it('ignores a locale response that arrives after logout', async () => {
    const { store, http } = setupStore();
    await transloco();
    await signedIn(store, http);
    const change = store.setLocale('el');
    const [patch] = await localeRequests(http, 1);
    if (!patch) {
      throw new Error('missing locale update');
    }
    const logout = store.logout();
    http.expectOne('/api/auth/logout').flush({});
    await logout;
    expect(store.user()).toBeNull();
    patch.flush(me('el'));
    await change;
    expect(store.user()).toBeNull();
    http.verify();
  });

  it('ignores a locale response from before the next login', async () => {
    const { store, http } = setupStore();
    await transloco();
    await signedIn(store, http);
    const change = store.setLocale('el');
    const [patch] = await localeRequests(http, 1);
    if (!patch) {
      throw new Error('missing locale update');
    }
    store.invalidate();
    const next = store.load();
    http.expectOne('/api/me').flush(me('en', 'user-2'));
    await next;
    patch.flush(me('el', 'user-1'));
    await change;
    expect(store.user()?.id).toBe('user-2');
    expect(store.user()?.locale).toBe('en');
    http.verify();
  });

  it('keeps the later language when an earlier response arrives last', async () => {
    const { store, http } = setupStore();
    await transloco();
    await signedIn(store, http);
    const greek = store.setLocale('el');
    const english = store.setLocale('en');
    const requests = await localeRequests(http, 2);
    const toEnglish = requests.find((request) => localeOf(request.request.body) === 'en');
    const toGreek = requests.find((request) => localeOf(request.request.body) === 'el');
    if (!toEnglish || !toGreek) {
      throw new Error('missing overlapping locale updates');
    }
    toEnglish.flush(me('en'));
    await english;
    toGreek.flush(me('el'));
    await greek;
    expect(store.user()?.locale).toBe('en');
    expect(store.localeSaving()).toBe(false);
    http.verify();
  });

  it('clears the session before a 401 sends the user to login', async () => {
    TestBed.configureTestingModule({
      imports: [LoginPage],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([apiInterceptor])),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'login', component: LoginPage },
          { path: 'c/:companyId/orders', component: OrdersStub },
          { path: 'not-found', component: OrdersStub },
        ]),
        provideTransloco({
          config: {
            availableLangs: ['en', 'el'],
            defaultLang: 'en',
            reRenderOnLangChange: true,
            prodMode: true,
          },
          loader: AppTranslocoLoader,
        }),
        MessageService,
      ],
    });
    await transloco();
    const store = TestBed.inject(SessionStore);
    const http = TestBed.inject(HttpTestingController);
    const router = TestBed.inject(Router);
    const context = TestBed.inject(CompanyContextStore);
    await signedIn(store, http);
    context.companyId.set('company-1');
    await router.navigateByUrl('/c/company-1/orders');
    const change = store.setLocale('el');
    const [patch] = await localeRequests(http, 1);
    if (!patch) {
      throw new Error('missing locale update');
    }
    patch.flush(
      { error: { message: 'Authentication failed', correlationId: 'corr-401' } },
      { status: 401, statusText: 'Unauthorized' },
    );
    await change.catch(() => undefined);
    for (let attempt = 0; attempt < 20 && !router.url.startsWith('/login'); attempt += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    for (const request of http.match('/api/auth/providers')) {
      request.flush({ devLogin: false, oidc: false });
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(store.user()).toBeNull();
    expect(context.companyId()).toBeNull();
    expect(router.url.startsWith('/login')).toBe(true);
    http.verify();
  });
});
