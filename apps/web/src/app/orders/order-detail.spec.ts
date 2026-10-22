import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { of, firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { CompanyContextStore } from '../core/company-context.store';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { NAVIGATE_ON_DENIED } from '../core/navigate-on-denied';
import type { ActivityEvent, OrderCan, OrderDetail, TransitionDecision } from './models';
import { OrderDetailPage } from './order-detail';

describe('OrderDetailPage', () => {
  it('renders allowed and disabled transitions, sends one request for a double click, and keeps the page on a version conflict', async () => {
    const { fixture, http } = await setup();
    const component = fixture.componentInstance;
    component.open('company-1', 'order-1');
    flushDetail(http, 'order-1', detail());
    fixture.detectChanges();
    await fixture.whenStable();
    const text = () => textOf(fixture);
    expect(text()).toContain('Mark as Preparing');
    expect(text()).toContain('Not available: Ready — Payment is not settled');
    expect(buttonNames(fixture)).not.toContain('Mark as Ready');
    const preparing = button(fixture, 'Mark as Preparing');
    preparing.click();
    preparing.click();
    const posts = http.match('/api/c/company-1/orders/order-1/transitions');
    expect(posts).toHaveLength(1);
    const post = posts[0];
    if (!post) {
      throw new Error('missing transition');
    }
    expect(post.request.body).toEqual({ to: 'preparing', expectedVersion: 3 });
    post.flush(
      { error: { code: 'conflict', message: 'version_conflict', correlationId: 'corr-409' } },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(text()).toContain('This order was changed by someone else');
    expect(text()).toContain('corr-409');
    expect(tagText(fixture, 'fulfilment-status')).toBe('New');

    button(fixture, 'Reload').click();
    flushDetail(
      http,
      'order-1',
      detail({
        fulfilmentStatus: 'preparing',
        version: 4,
        allowedTransitions: [{ from: 'preparing', to: 'ready', allowed: true }],
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(tagText(fixture, 'fulfilment-status')).toBe('Preparing');
    http.verify();
  });

  it('ignores a detail response that arrives after the page has moved to another order', async () => {
    const { fixture, http } = await setup();
    const component = fixture.componentInstance;
    component.open('company-1', 'order-a');
    component.open('company-1', 'order-b');
    flushDetail(http, 'order-b', detail({ id: 'order-b', externalNumber: '#SECOND' }));
    flushDetail(http, 'order-a', detail({ id: 'order-a', externalNumber: '#FIRST' }));
    fixture.detectChanges();
    await fixture.whenStable();
    const text = textOf(fixture);
    expect(text).toContain('#SECOND');
    expect(text).not.toContain('#FIRST');
    http.verify();
  });

  it('clears the previous order when the next order fails to load', async () => {
    const { fixture, http } = await setup();
    const component = fixture.componentInstance;
    component.open('company-1', 'order-x');
    flushDetail(http, 'order-x', detail({ id: 'order-x', externalNumber: '#X', version: 3 }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(textOf(fixture)).toContain('#X');
    expect(button(fixture, 'Mark as Preparing').disabled).toBe(false);

    component.open('company-1', 'order-y');
    fixture.detectChanges();
    expect(textOf(fixture)).not.toContain('#X');
    expect(textOf(fixture)).not.toContain('Mark as Preparing');

    const prefix = '/api/c/company-1/orders/order-y';
    const detailRequest = http.expectOne(prefix);
    const activityRequest = http.expectOne(`${prefix}/activity`);
    detailRequest.flush('nope', { status: 500, statusText: 'Server error' });
    if (!activityRequest.cancelled) {
      activityRequest.flush('nope', { status: 500, statusText: 'Server error' });
    }
    const filters = http.match('/api/c/company-1/order-filters');
    for (const request of filters) {
      if (!request.cancelled) {
        request.flush({ stores: [] });
      }
    }
    fixture.detectChanges();
    await fixture.whenStable();
    const text = textOf(fixture);
    expect(text).not.toContain('#X');
    expect(text).not.toContain('Maria');
    expect(text).not.toContain('Mark as Preparing');
    const root: unknown = fixture.nativeElement;
    if (!(root instanceof HTMLElement)) {
      throw new Error('missing root');
    }
    expect(root.querySelector('button.danger, button')).toBeNull();
    http.verify();
  });

  it('hides order actions when can is false even if company grants include them', async () => {
    const { fixture, http } = await setup();
    const context = TestBed.inject(CompanyContextStore);
    context.grants.set([
      { permission: 'order.edit', scopeType: 'company', scopeId: null },
      { permission: 'order.claim', scopeType: 'company', scopeId: null },
      { permission: 'order.assign', scopeType: 'company', scopeId: null },
      { permission: 'order.cancel', scopeType: 'company', scopeId: null },
      { permission: 'document.download', scopeType: 'company', scopeId: null },
      { permission: 'print.submit', scopeType: 'company', scopeId: null },
      { permission: 'print.reprint', scopeType: 'company', scopeId: null },
      { permission: 'print.confirm', scopeType: 'company', scopeId: null },
    ]);
    expect(context.has('order.claim')).toBe(true);
    expect(context.has('order.assign')).toBe(true);
    expect(context.has('print.submit')).toBe(true);
    expect(context.has('order.edit')).toBe(true);
    fixture.componentInstance.open('company-1', 'order-1');
    const denied: OrderCan = {
      edit: false,
      claim: false,
      assign: false,
      cancel: false,
      downloadDocuments: false,
      printSubmit: false,
      printReprint: false,
      printConfirm: false,
    };
    const flushed = flushDetail(
      http,
      'order-1',
      detail({
        giftMessage: 'A gift',
        can: denied,
        allowedTransitions: [
          { from: 'new', to: 'preparing', allowed: true },
          { from: 'new', to: 'cancelled', allowed: true },
        ],
      }),
    );
    expect(flushed).toBe(0);
    fixture.detectChanges();
    await fixture.whenStable();
    const names = buttonNames(fixture);
    expect(names).toContain('Mark as Preparing');
    expect(names.some((name) => name === 'Claim')).toBe(false);
    expect(names.some((name) => name === 'Assign')).toBe(false);
    expect(names.some((name) => name === 'Unassign')).toBe(false);
    expect(names.some((name) => name === 'Add note')).toBe(false);
    expect(names.some((name) => name === 'Print')).toBe(false);
    expect(names.some((name) => name.includes('Cancel'))).toBe(false);
    expect(textOf(fixture)).not.toContain('Preview');
    http.verify();
  });

  it('shows a transition as from and to, and an assignee name only when it is known', async () => {
    const { fixture, http } = await setup();
    const component = fixture.componentInstance;
    component.open('company-1', 'order-1');
    flushDetail(
      http,
      'order-1',
      detail({
        assignedToUserId: 'user-known',
        assignedTo: { userId: 'user-known', displayName: 'Known Person' },
      }),
      [
        {
          id: 'event-transition',
          occurredAt: '2026-03-29T00:30:00Z',
          actorLabel: 'Admin A (fictional)',
          actorType: 'user',
          action: 'order.transition',
          outcome: 'success',
          details: { from: 'new', to: 'preparing', reason: 'Packed' },
        },
        {
          id: 'event-assigned',
          occurredAt: '2026-03-29T00:31:00Z',
          actorLabel: 'Admin A (fictional)',
          actorType: 'user',
          action: 'order.assigned',
          outcome: 'success',
          details: { userId: 'user-known' },
        },
        {
          id: 'event-unknown',
          occurredAt: '2026-03-29T00:32:00Z',
          actorLabel: 'Admin A (fictional)',
          actorType: 'user',
          action: 'order.assigned',
          outcome: 'success',
          details: { userId: 'user-unknown' },
        },
      ],
    );
    fixture.detectChanges();
    await fixture.whenStable();
    const activity = activityText(fixture);
    expect(activity).toContain('New → Preparing');
    expect(activity).toContain('Packed');
    expect(activity).toContain('Known Person');
    expect(activity).not.toContain('user-unknown');
    http.verify();
  });

  it('applies a saved note when a print refresh reloads the same order', async () => {
    const { fixture, http } = await setup();
    const component = fixture.componentInstance;
    component.open('company-1', 'order-1');
    flushDetail(http, 'order-1', detail());
    fixture.detectChanges();
    await fixture.whenStable();

    component.draft.set('Packed with care');
    component.addNote();
    const note = http.expectOne('/api/c/company-1/orders/order-1/notes');
    expect(note.request.body).toEqual({ body: 'Packed with care' });

    component.reload();
    flushDetail(http, 'order-1', detail({ version: 4 }));
    fixture.detectChanges();
    expect(component.draft()).toBe('Packed with care');
    expect(component.mutating()).toBe(true);

    note.flush({});
    flushDetail(
      http,
      'order-1',
      detail({
        version: 5,
        notes: [
          {
            id: 'note-1',
            body: 'Packed with care',
            authorUserId: 'user-1',
            authorDisplayName: 'Admin A',
            createdAt: '2026-03-29T01:00:00Z',
          },
        ],
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component.draft()).toBe('');
    expect(component.mutating()).toBe(false);
    expect(textOf(fixture)).toContain('Packed with care');
    http.verify();
  });
});

async function setup(): Promise<{ fixture: ComponentFixture<OrderDetailPage>; http: HttpTestingController }> {
  await TestBed.configureTestingModule({
    imports: [OrderDetailPage],
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
          parent: null,
          paramMap: of(convertToParamMap({})),
          queryParamMap: of(convertToParamMap({})),
          snapshot: { paramMap: convertToParamMap({}), queryParamMap: convertToParamMap({}) },
        },
      },
      { provide: Router, useValue: { navigate: () => Promise.resolve(true), navigateByUrl: () => Promise.resolve(true) } },
    ],
  }).compileComponents();
  const transloco = TestBed.inject(TranslocoService);
  await firstValueFrom(transloco.load('en'));
  transloco.setActiveLang('en');
  TestBed.inject(CompanyContextStore).grants.set([]);
  const fixture = TestBed.createComponent(OrderDetailPage);
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController) };
}

function flushDetail(
  http: HttpTestingController,
  orderId: string,
  order: OrderDetail,
  events?: ActivityEvent[],
): number {
  const prefix = `/api/c/company-1/orders/${orderId}`;
  const filters = http.match('/api/c/company-1/order-filters');
  for (const request of filters) {
    if (!request.cancelled) {
      expect(request.request.context.get(NAVIGATE_ON_DENIED)).toBe(false);
      request.flush({ stores: [{ id: 'store-1', name: 'Nutbox Demo Shopify', platform: 'shopify' }] });
    }
  }
  const detailRequest = http.expectOne(prefix);
  expect(detailRequest.request.context.get(NAVIGATE_ON_DENIED)).toBe(true);
  detailRequest.flush({ order });
  const activityRequest = http.expectOne(`${prefix}/activity`);
  expect(activityRequest.request.context.get(NAVIGATE_ON_DENIED)).toBe(false);
    activityRequest.flush({
    events: events ?? [
      {
        id: 'event-1',
        occurredAt: '2026-03-29T00:30:00Z',
        actorLabel: 'Admin A (fictional)',
        actorType: 'user',
        action: 'order.imported',
        outcome: 'success',
      },
    ],
  });
  const assignees = http.match(`${prefix}/assignees`);
  for (const request of assignees) {
    if (!request.cancelled) {
      request.flush({ users: [] });
    }
  }
  return assignees.length;
}

function detail(extra: Partial<OrderDetail> = {}): OrderDetail {
  const transitions: TransitionDecision[] = [
    { from: 'new', to: 'preparing', allowed: true },
    { from: 'new', to: 'ready', allowed: false, error: 'payment_not_settled' },
  ];
  return {
    id: 'order-1',
    storeId: 'store-1',
    externalNumber: '#1001',
    sourceCreatedAt: '2026-03-29T00:30:00Z',
    paymentStatus: 'paid',
    fulfilmentStatus: 'new',
    integrationStatus: 'synced',
    reviewReason: null,
    attentionReasons: [],
    deliveryMethod: 'courier_cy',
    currency: 'EUR',
    total: '24.00',
    subtotal: '20.00',
    shippingTotal: '4.00',
    taxTotal: '0.00',
    assignedToUserId: null,
    assignedTo: null,
    version: 3,
    customer: { displayName: 'Maria' },
    recipient: { firstName: 'Maria', lastName: 'Demo', city: 'Nicosia' },
    billingAddress: null,
    giftMessage: null,
    customerNote: null,
    lines: [],
    notes: [],
    allowedTransitions: transitions,
    printJobs: { packing_slip: null, gift_message: null },
    firstPrintAvailable: {
      invoice: true,
      packing_slip: true,
      gift_message: true,
      shipping_label: true,
    },
    can: {
      edit: true,
      claim: true,
      assign: true,
      cancel: true,
      downloadDocuments: true,
      printSubmit: true,
      printReprint: true,
      printConfirm: true,
    },
    ...extra,
  };
}

function buttonNames(fixture: ComponentFixture<OrderDetailPage>): string[] {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) {
    return [];
  }
  return [...element.querySelectorAll('button')].map((item) => item.textContent.trim());
}

function button(fixture: ComponentFixture<OrderDetailPage>, name: string): HTMLButtonElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) {
    throw new Error('missing root');
  }
  const found = [...element.querySelectorAll('button')].find((item) => item.textContent.includes(name));
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`missing button ${name}`);
  }
  return found;
}

function tagText(fixture: ComponentFixture<OrderDetailPage>, testId: string): string {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) {
    throw new Error('missing root');
  }
  const tag = element.querySelector(`[data-testid="${testId}"]`);
  return tag instanceof HTMLElement ? tag.textContent.trim() : '';
}

function textOf(fixture: ComponentFixture<OrderDetailPage>): string {
  const element: unknown = fixture.nativeElement;
  return element instanceof HTMLElement ? element.textContent : '';
}

function activityText(fixture: ComponentFixture<OrderDetailPage>): string {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) {
    return '';
  }
  return element.querySelector('.activity')?.textContent ?? '';
}
