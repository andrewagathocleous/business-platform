import { HttpClient, HttpContext, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef, Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { MessageService } from 'primeng/api';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { apiInterceptor } from './api.interceptor';
import { CompanyContextStore } from './company-context.store';
import type { Grant } from './models';
import { NAVIGATE_ON_DENIED } from './navigate-on-denied';
import { SessionStore } from './session.store';

@Component({ selector: 'bp-page-stub', template: 'Page' })
class PageStub {}

describe('apiInterceptor denied navigation', () => {
  it('navigates to forbidden only when the request opts in', async () => {
    const { http, client, router, added } = await setup();
    await router.navigateByUrl('/orders');
    client
      .get('/api/c/company-1/orders', { context: new HttpContext().set(NAVIGATE_ON_DENIED, true) })
      .subscribe({ error: () => undefined });
    http.expectOne('/api/c/company-1/orders').flush(denied('Forbidden', 'corr-403'), {
      status: 403,
      statusText: 'Forbidden',
    });
    await settled();
    expect(router.url).toBe('/forbidden');
    expect(added.some((message) => message.detail?.includes('corr-403'))).toBe(true);

    client.get('/api/c/company-1/orders/order-1/activity').subscribe({ error: () => undefined });
    const activity = http.expectOne('/api/c/company-1/orders/order-1/activity');
    expect(activity.request.context.get(NAVIGATE_ON_DENIED)).toBe(false);
    activity.flush(denied('Missing', 'corr-404'), { status: 404, statusText: 'Not Found' });
    await settled();
    expect(router.url).toBe('/forbidden');
    expect(added.some((message) => message.detail?.includes('corr-404'))).toBe(true);
    http.verify();
  });

  it('navigates to not-found for a primary 404 and stays for a secondary 403', async () => {
    const { http, client, router } = await setup();
    await router.navigateByUrl('/orders');
    client.get('/api/c/company-1/orders/order-1/assignees').subscribe({ error: () => undefined });
    http.expectOne('/api/c/company-1/orders/order-1/assignees').flush(denied('Forbidden', 'corr-sec'), {
      status: 403,
      statusText: 'Forbidden',
    });
    await settled();
    expect(router.url).toBe('/orders');

    client
      .get('/api/c/company-1/orders/missing', { context: new HttpContext().set(NAVIGATE_ON_DENIED, true) })
      .subscribe({ error: () => undefined });
    http.expectOne('/api/c/company-1/orders/missing').flush(denied('Not found', 'corr-404'), {
      status: 404,
      statusText: 'Not Found',
    });
    await settled();
    expect(router.url).toBe('/not-found');
    http.verify();
  });

  it('ignores a 401 from a request that started before the current session', async () => {
    const { http, client, router, session, context } = await setup();
    await router.navigateByUrl('/orders');
    client.get('/api/c/company-1/orders').subscribe({ error: () => undefined });
    client.get('/api/c/company-1/orders/late').subscribe({ error: () => undefined });
    const first = http.expectOne('/api/c/company-1/orders');
    const late = http.expectOne('/api/c/company-1/orders/late');
    first.flush(denied('Expired', 'corr-401'), { status: 401, statusText: 'Unauthorized' });
    await settled();
    expect(router.url).toContain('/login');

    session.invalidate();
    context.grants.set([grant('order.view')]);
    await router.navigateByUrl('/orders');
    late.flush(denied('Expired', 'corr-late'), { status: 401, statusText: 'Unauthorized' });
    await settled();
    expect(router.url).toBe('/orders');
    expect(context.grants().map((item) => item.permission)).toEqual(['order.view']);
    http.verify();
  });

  it('does not let a stale denial replace the page a later navigation already showed', async () => {
    const { http, client, router } = await setup();
    await router.navigateByUrl('/orders');
    client
      .get('/api/c/company-a/context', { context: new HttpContext().set(NAVIGATE_ON_DENIED, true) })
      .subscribe({ error: () => undefined });
    const pending = http.expectOne('/api/c/company-a/context');

    await router.navigateByUrl('/clients');
    client
      .get('/api/c/company-b/context', { context: new HttpContext().set(NAVIGATE_ON_DENIED, true) })
      .subscribe({ error: () => undefined });
    http.expectOne('/api/c/company-b/context').flush({ ok: true });
    await settled();
    expect(router.url).toBe('/clients');

    pending.flush(denied('Forbidden', 'corr-stale'), { status: 403, statusText: 'Forbidden' });
    await settled();
    expect(router.url).toBe('/clients');

    client
      .get('/api/c/company-b/orders/missing', { context: new HttpContext().set(NAVIGATE_ON_DENIED, true) })
      .subscribe({ error: () => undefined });
    const current = http.expectOne('/api/c/company-b/orders/missing');
    await router.navigateByUrl('/orders');
    current.flush(denied('Missing', 'corr-old-404'), { status: 404, statusText: 'Not Found' });
    await settled();
    expect(router.url).toBe('/orders');
    http.verify();
  });
});

function grant(permission: string): Grant {
  return { permission, scopeType: 'company', scopeId: null };
}

function denied(message: string, correlationId: string): { error: { message: string; correlationId: string } } {
  return { error: { message, correlationId } };
}

async function settled(): Promise<void> {
  await TestBed.inject(ApplicationRef).whenStable();
}

async function setup(): Promise<{
  http: HttpTestingController;
  client: HttpClient;
  router: Router;
  added: { detail?: string }[];
  session: SessionStore;
  context: CompanyContextStore;
}> {
  const added: { detail?: string }[] = [];
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(withInterceptors([apiInterceptor])),
      provideHttpClientTesting(),
      provideRouter([
        { path: 'orders', component: PageStub },
        { path: 'clients', component: PageStub },
        { path: 'login', component: PageStub },
        { path: 'forbidden', component: PageStub },
        { path: 'not-found', component: PageStub },
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
  const transloco = TestBed.inject(TranslocoService);
  await firstValueFrom(transloco.load('en'));
  transloco.setActiveLang('en');
  const messages = TestBed.inject(MessageService);
  messages.add = (message) => {
    added.push(message);
    return message;
  };
  return {
    http: TestBed.inject(HttpTestingController),
    client: TestBed.inject(HttpClient),
    router: TestBed.inject(Router),
    added,
    session: TestBed.inject(SessionStore),
    context: TestBed.inject(CompanyContextStore),
  };
}
