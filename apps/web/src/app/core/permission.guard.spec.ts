import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanyContextStore, type ContextLoad } from './company-context.store';
import { permissionGuard } from './guards';
import type { CompanyContext } from './models';

@Component({ selector: 'bp-orders-stub', template: 'Orders page' })
class OrdersStub {}

@Component({ selector: 'bp-invoices-stub', template: 'Invoices page' })
class InvoicesStub {}

@Component({ selector: 'bp-forbidden-stub', template: 'Forbidden page' })
class ForbiddenStub {}

class FulfilmentContext {
  load(): Promise<ContextLoad> {
    return Promise.resolve('ok');
  }

  has(permission: string): boolean {
    return permission === 'order.view';
  }
}

const companyA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const companyB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('permissionGuard', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('sends a user without invoice.view to /forbidden', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([
          { path: 'forbidden', component: ForbiddenStub },
          {
            path: 'c/:companyId/orders',
            component: OrdersStub,
            canActivate: [permissionGuard],
            data: { permission: 'order.view' },
          },
          {
            path: 'c/:companyId/invoices',
            component: InvoicesStub,
            canActivate: [permissionGuard],
            data: { permission: 'invoice.view' },
          },
        ]),
        { provide: CompanyContextStore, useValue: new FulfilmentContext() },
      ],
    });

    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/c/company-a/invoices');
    expect(TestBed.inject(Router).url).toBe('/forbidden');

    await harness.navigateByUrl('/c/company-a/orders');
    expect(TestBed.inject(Router).url).toBe('/c/company-a/orders');
    expect(harness.routeNativeElement?.textContent).toContain('Orders page');
  });

  it('uses the destination grants when a save reloads the previous company', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'forbidden', component: ForbiddenStub },
          {
            path: 'c/:companyId/invoices',
            component: InvoicesStub,
            canActivate: [permissionGuard],
            data: { permission: 'invoice.view' },
          },
        ]),
      ],
    });
    const store = TestBed.inject(CompanyContextStore);
    const http = TestBed.inject(HttpTestingController);
    const harness = await RouterTestingHarness.create();

    const loadA = store.load(companyA);
    http
      .expectOne(`/api/c/${companyA}/context`)
      .flush(guardContext(companyA, 'invoice.view', 'EUR'));
    await loadA;

    const navigation = harness.navigateByUrl(`/c/${companyB}/invoices`);
    const pendingB = await vi.waitFor(() => http.expectOne(`/api/c/${companyB}/context`));
    const reload = store.reload(companyA);
    expect(http.match(`/api/c/${companyA}/context`)).toEqual([]);

    pendingB.flush(guardContext(companyB, 'order.view', 'USD', 'Europe/Athens'));
    await navigation;
    await expect(reload).resolves.toBe('superseded');
    expect(TestBed.inject(Router).url).toBe('/forbidden');
    expect(harness.routeNativeElement?.textContent).toContain('Forbidden page');
    expect(store.companyId()).toBe(companyB);
    expect(store.currency()).toBe('USD');
    expect(store.timezone()).toBe('Europe/Athens');
    expect(store.grants().map((grant) => grant.permission)).toEqual(['order.view']);
    http.verify();
  });
});

function guardContext(
  id: string,
  permission: string,
  currency: string,
  timezone = 'Asia/Nicosia',
): CompanyContext {
  return {
    company: {
      id,
      legalName: 'Legal',
      tradingName: 'Trade',
      status: 'active',
      timezone,
      defaultCurrency: currency,
      countryCode: 'CY',
      documentLanguage: 'en',
    },
    grants: [{ permission, scopeType: 'company', scopeId: null }],
    switches: [],
    mfaStepUpRequired: false,
    withheldPermissions: [],
  };
}
