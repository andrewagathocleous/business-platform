import { provideZonelessChangeDetection } from '@angular/core';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { describe, expect, it } from 'vitest';
import { CompanyContextStore, type ContextLoad } from './company-context.store';
import { permissionGuard } from './guards';

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

describe('permissionGuard', () => {
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
});
