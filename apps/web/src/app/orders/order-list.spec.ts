import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, ParamMap, Router } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { BehaviorSubject, firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { NAVIGATE_ON_DENIED } from '../core/navigate-on-denied';
import type { OrderSummary } from './models';
import { OrderListPage } from './order-list';
import { parseOrderQuery } from './order-query';

describe('OrderListPage', () => {
  it('keeps only the latest page of orders when an older request finishes last', async () => {
    const { fixture, http } = await setup();
    const component = fixture.componentInstance;
    component.load('company-1', parseOrderQuery(convertToParamMap({ q: 'first' })));
    component.load('company-1', parseOrderQuery(convertToParamMap({ q: 'second' })));
    http.expectOne('/api/c/company-1/order-filters').flush({ stores: [] });
    const requests = http.match((request) => request.url === '/api/c/company-1/orders');
    expect(requests).toHaveLength(2);
    const second = requests.find((request) => request.request.params.get('q') === 'second');
    const first = requests.find((request) => request.request.params.get('q') === 'first');
    if (!second || !first) {
      throw new Error('expected both order requests');
    }
    second.flush(page([summary('#SECOND')]));
    first.flush(page([summary('#FIRST')]));
    fixture.detectChanges();
    await fixture.whenStable();
    const text = textOf(fixture);
    expect(text).toContain('#SECOND');
    expect(text).not.toContain('#FIRST');
    http.verify();
  });

  it('shows status text and the review reason on a highlighted row', async () => {
    const { fixture, http } = await setup();
    fixture.componentInstance.load('company-1', parseOrderQuery(convertToParamMap({})));
    const filters = http.expectOne('/api/c/company-1/order-filters');
    expect(filters.request.context.get(NAVIGATE_ON_DENIED)).toBe(false);
    filters.flush({
      stores: [{ id: 'store-1', name: 'Nutbox Demo Shopify', platform: 'shopify' }],
    });
    const orders = http.expectOne((request) => request.url === '/api/c/company-1/orders');
    expect(orders.request.context.get(NAVIGATE_ON_DENIED)).toBe(true);
    orders.flush(
      page([
        summary('#1001', {
          paymentStatus: 'paid',
          fulfilmentStatus: 'review_required',
          integrationStatus: 'synced',
          reviewReason: 'unsupported_glyphs',
          attentionReasons: ['cancelled_at_source'],
        }),
      ]),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    const text = textOf(fixture);
    expect(text).toContain('Paid');
    expect(text).toContain('Review required');
    expect(text).toContain('Synced');
    expect(text).toContain('Characters the gift card cannot print');
    expect(text).toContain('Cancelled in the store');
    const root: unknown = fixture.nativeElement;
    if (!(root instanceof HTMLElement)) {
      throw new Error('missing root');
    }
    const row: unknown = root.querySelector('.order-table .review-row');
    expect(row).toBeInstanceOf(HTMLElement);
    expect(tagClass(root, 'payment-status')).toContain('p-tag-success');
    expect(tagClass(root, 'fulfilment-status')).toContain('p-tag-warn');
    expect(tagClass(root, 'integration-status')).toContain('p-tag-success');
    expect(root.querySelector('.order-table .pi-exclamation-triangle')).toBeInstanceOf(HTMLElement);
    const card = root.querySelector('.order-card');
    expect(card).toBeInstanceOf(HTMLElement);
    expect(card?.textContent).toContain('Delivery');
    expect(card?.textContent).toContain('Total');
    expect(card?.textContent).toContain('Assignee');
    expect(card?.querySelector('.card-label')).toBeInstanceOf(HTMLElement);
    http.verify();
  });

  it('replaces a non-canonical query before requesting orders', async () => {
    const { http, navigate } = await setup({
      companyId: 'company-1',
      query: {
        page: '02',
        pageSize: '10',
        sort: '-sourceUpdatedAt',
        fulfilmentStatus: ['new', 'nope', 'ready'],
      },
    });
    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        replaceUrl: true,
        queryParams: { fulfilmentStatus: ['new', 'ready'] },
      }),
    );
    http.expectNone((request) => request.url.includes('/orders'));
  });

  it('selects the store from the address once the store list loads', async () => {
    const { fixture, http } = await setup({ companyId: 'company-1', query: { storeId: 'store-b' } });
    const orders = http.expectOne((request) => request.url === '/api/c/company-1/orders');
    expect(orders.request.params.get('storeId')).toBe('store-b');
    orders.flush(page([]));
    fixture.detectChanges();
    http.expectOne('/api/c/company-1/order-filters').flush({
      stores: [
        { id: 'store-a', name: 'Alpha', platform: 'shopify' },
        { id: 'store-b', name: 'Beta Shop', platform: 'shopify' },
      ],
    });
    fixture.detectChanges();
    const root: unknown = fixture.nativeElement;
    if (!(root instanceof HTMLElement)) {
      throw new Error('missing root');
    }
    const select = [...root.querySelectorAll('select')].find((item) => item.textContent.includes('Beta Shop'));
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error('missing store select');
    }
    expect(select.value).toBe('store-b');
    expect(select.selectedOptions[0]?.textContent).toContain('Beta Shop');
    http.verify();
  });
});

async function setup(options?: {
  companyId?: string;
  query?: Record<string, string | string[]>;
}): Promise<{
  fixture: ComponentFixture<OrderListPage>;
  http: HttpTestingController;
  navigate: ReturnType<typeof vi.fn>;
}> {
  const initial = convertToParamMap(options?.query ?? {});
  const query = new BehaviorSubject<ParamMap>(initial);
  const navigate = vi.fn(() => Promise.resolve(true));
  const company = convertToParamMap(options?.companyId ? { companyId: options.companyId } : {});
  await TestBed.configureTestingModule({
    imports: [OrderListPage],
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTransloco({
        config: { availableLangs: ['en', 'el'], defaultLang: 'en', reRenderOnLangChange: true, prodMode: true },
        loader: AppTranslocoLoader,
      }),
      {
        provide: ActivatedRoute,
        useValue: {
          parent: options?.companyId ? { paramMap: of(company), snapshot: { paramMap: company } } : null,
          queryParamMap: query.asObservable(),
          paramMap: query.asObservable(),
          snapshot: { queryParamMap: initial, paramMap: convertToParamMap({}) },
        },
      },
      { provide: Router, useValue: { navigate } },
    ],
  }).compileComponents();
  const transloco = TestBed.inject(TranslocoService);
  await firstValueFrom(transloco.load('en'));
  transloco.setActiveLang('en');
  const fixture = TestBed.createComponent(OrderListPage);
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController), navigate };
}

function summary(externalNumber: string, extra: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: externalNumber,
    storeId: 'store-1',
    externalNumber,
    sourceCreatedAt: '2026-03-29T00:30:00Z',
    paymentStatus: 'paid',
    fulfilmentStatus: 'new',
    integrationStatus: 'synced',
    reviewReason: null,
    attentionReasons: [],
    deliveryMethod: 'courier_cy',
    currency: 'EUR',
    total: '12.50',
    assignedToUserId: null,
    assignedTo: null,
    version: 1,
    customer: { displayName: 'Maria', email: null, phone: null },
    ...extra,
  };
}

function page(orders: OrderSummary[]) {
  return { orders, page: 1, pageSize: 50, total: orders.length };
}

function textOf(fixture: ComponentFixture<OrderListPage>): string {
  const element: unknown = fixture.nativeElement;
  return element instanceof HTMLElement ? element.textContent : '';
}

function tagClass(root: HTMLElement, testId: string): string {
  const tag = root.querySelector(`.order-table [data-testid="${testId}"]`);
  return tag instanceof HTMLElement ? tag.className : '';
}
