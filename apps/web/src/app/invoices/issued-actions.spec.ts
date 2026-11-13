import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanyContextStore } from '../core/company-context.store';
import type { Grant } from '../core/models';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { IssuedActions } from './issued-actions';

const FULL = ['invoice.view', 'invoice.issue', 'print.submit', 'print.reprint'];
const INVOICE_KEY = 'bp.invoicePrint.company-1.invoice-1';

describe('IssuedActions', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('records a paper delivery only once the company copy is kept, then asks for a reload', async () => {
    const { fixture, http, component } = await setup(FULL);
    let changed = 0;
    component.changed.subscribe(() => {
      changed += 1;
    });
    expect(component.paper()).toBe(true);
    component.record();
    expect(http.match(() => true)).toHaveLength(0);
    component.setCopyKept(checkbox(true));
    component.setNote(textEvent('Handed to reception\n  second line '));
    component.record();
    const request = http.expectOne('/api/c/company-1/invoices/invoice-1/deliveries');
    expect(request.request.body).toEqual({
      method: 'handed_over',
      deliveredOn: component.deliveredOn(),
      paperCopyKept: true,
      note: 'Handed to reception\n  second line ',
    });
    request.flush({ invoice: {}, delivery: {}, warnings: ['delivered_after_deadline'] });
    fixture.detectChanges();
    expect(changed).toBe(1);
    expect(textOf(fixture)).toContain('Recorded after the delivery deadline');
    http.verify();
  });

  it('explains a refused e-mail delivery', async () => {
    const { fixture, http, component } = await setup(FULL);
    component.setMethod(selectEvent('emailed_outside_platform'));
    expect(component.paper()).toBe(false);
    component.record();
    http
      .expectOne('/api/c/company-1/invoices/invoice-1/deliveries')
      .flush(
        { error: { code: 'e_invoice_not_accepted', message: 'x', correlationId: 'corr-1' } },
        { status: 409, statusText: 'Conflict' },
      );
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('has not accepted electronic invoices');
    expect(textOf(fixture)).toContain('corr-1');
    http.verify();
  });

  it('prints once, then offers a reprint of the counted first print', async () => {
    const { fixture, http, component } = await setup(FULL);
    let changed = 0;
    component.changed.subscribe(() => {
      changed += 1;
    });
    expect(component.canFirstPrint()).toBe(true);
    expect(component.canReprint()).toBe(false);
    component.print(false);
    const first = http.expectOne('/api/c/company-1/print-requests');
    const sent = record(first.request.body);
    expect(sent).toMatchObject({
      documentType: 'invoice',
      sourceType: 'invoice',
      sourceId: 'invoice-1',
    });
    expect(sent['requestKey']).toMatch(/^[0-9a-f-]{36}$/);
    first.flush({ printJob: { copies: 2 } });
    expect(changed).toBe(1);
    expect(component.pending()).toBeNull();
    fixture.componentRef.setInput('printJobs', [job('job-1', 'done_reported', false)]);
    fixture.componentRef.setInput('firstPrintJobId', 'job-1');
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('2 copies');
    expect(component.canFirstPrint()).toBe(false);
    expect(component.canReprint()).toBe(true);
    component.print(true);
    expect(http.match(() => true)).toHaveLength(0);
    component.setReason(textEvent('Client lost it'));
    component.print(true);
    const reprint = http.expectOne('/api/c/company-1/print-requests');
    const again = record(reprint.request.body);
    expect(again).toMatchObject({
      reprint: { ofPrintJobId: 'job-1', reason: 'Client lost it' },
    });
    expect(again['requestKey']).not.toBe(sent['requestKey']);
    reprint.flush({ printJob: { copies: 1 } });
    expect(changed).toBe(2);
    expect(component.reason()).toBe('');
    http.verify();
  });

  it('lets a reprint-only user reprint the counted first print', async () => {
    const { fixture, http, component } = await setup(['invoice.view', 'print.reprint']);
    expect(component.canSeePrinting()).toBe(true);
    expect(component.canFirstPrint()).toBe(false);
    expect(component.canReprint()).toBe(false);
    fixture.componentRef.setInput('printJobs', [job('job-2', 'confirmed_printed', false)]);
    fixture.componentRef.setInput('firstPrintJobId', 'job-2');
    fixture.detectChanges();
    expect(component.canReprint()).toBe(true);
    expect(textOf(fixture)).toContain('Reprint');
    expect(textOf(fixture)).not.toContain('Print invoice');
    http.verify();
  });

  it('offers a first print again once the first one failed', async () => {
    const { http, component } = await setup(FULL, [job('job-3', 'failed', false)]);
    expect(component.canFirstPrint()).toBe(true);
    expect(component.reprintOf()).toBe('job-3');
    http.verify();
  });

  it('keeps a request with a lost answer and sends exactly the same one again', async () => {
    const { fixture, http, component } = await setup(
      FULL,
      [job('job-1', 'done_reported', false)],
      'job-1',
    );
    component.setReason(textEvent('Client lost it'));
    component.print(true);
    const lost = http.expectOne('/api/c/company-1/print-requests');
    const body: unknown = lost.request.body;
    lost.flush(null, { status: 503, statusText: 'Service Unavailable' });
    fixture.detectChanges();
    expect(component.pending()?.body).toEqual(body);
    expect(textOf(fixture)).toContain('Send the same request again');
    expect(component.canReprint()).toBe(false);
    component.print(true);
    expect(http.match(() => true)).toHaveLength(0);
    // A reply that cannot be read, even with status 200, is still unknown.
    component.retry();
    const unread = http.expectOne('/api/c/company-1/print-requests');
    expect(unread.request.body).toEqual(body);
    unread.error(new ProgressEvent('error'), { status: 200, statusText: 'OK' });
    expect(component.pending()?.body).toEqual(body);
    component.retry();
    const resent = http.expectOne('/api/c/company-1/print-requests');
    expect(resent.request.body).toEqual(body);
    resent.flush({ printJob: { copies: 1 } });
    expect(component.pending()).toBeNull();
    http.verify();
  });

  it('keeps a lost request when a retry is refused, and lets it go only by choice', async () => {
    const { fixture, http, component } = await setup(
      FULL,
      [job('job-1', 'done_reported', false)],
      'job-1',
    );
    component.setReason(textEvent('Client lost it'));
    component.print(true);
    http
      .expectOne('/api/c/company-1/print-requests')
      .error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
    expect(component.pending()?.lost).toBe(true);
    component.discard();
    expect(component.pending()).not.toBeNull();
    component.retry();
    http
      .expectOne('/api/c/company-1/print-requests')
      .flush(
        { error: { code: 'too_many_requests', message: 'slow down', correlationId: 'corr-4' } },
        { status: 429, statusText: 'Too Many Requests' },
      );
    fixture.detectChanges();
    expect(component.pending()?.lost).toBe(true);
    expect(component.retryRefused()).toBe(true);
    expect(textOf(fixture)).toContain('discard this request only if the print is not there');
    component.discard();
    expect(component.pending()).toBeNull();
    expect(sessionStorage.getItem('bp.invoicePrint.company-1.invoice-1')).toBeNull();
    expect(component.canReprint()).toBe(true);
    http.verify();
  });

  it('shows that a mock printer prints nothing for real', async () => {
    const { fixture, http, component } = await setup(FULL, [
      {
        ...job('job-5', 'done_reported', false),
        simulationLabel: 'Simulated — no physical printing',
      },
    ]);
    expect(textOf(fixture)).toContain('Simulated — no physical printing');
    fixture.componentRef.setInput('printJobs', []);
    component.print(false);
    http.expectOne('/api/c/company-1/print-requests').flush({
      printJob: { copies: 2, simulationLabel: 'Simulated — no physical printing' },
    });
    fixture.detectChanges();
    expect(textOf(fixture).replace(/\s+/g, ' ')).toContain(
      'Sent to the printer queue: 2 copies. (Simulated — no physical printing)',
    );
    http.verify();
  });

  it('lets a panel the user left never touch the request a newer panel saved', async () => {
    const { fixture, http, component } = await setup(
      FULL,
      [job('job-1', 'done_reported', false)],
      'job-1',
    );
    component.setReason(textEvent('Client lost it'));
    component.print(true);
    const left = http.expectOne('/api/c/company-1/print-requests');
    const firstKey = record(left.request.body)['requestKey'];
    fixture.destroy();
    expect(left.cancelled).toBe(true);

    const back = TestBed.createComponent(IssuedActions);
    back.componentRef.setInput('companyId', 'company-1');
    back.componentRef.setInput('invoiceId', 'invoice-1');
    back.componentRef.setInput('printJobs', [job('job-1', 'done_reported', false)]);
    back.componentRef.setInput('firstPrintJobId', 'job-1');
    back.detectChanges();
    const panel = back.componentInstance;
    expect(panel.pending()?.lost).toBe(true);
    panel.retry();
    http.expectOne('/api/c/company-1/print-requests').flush({ printJob: { copies: 1 } });
    expect(panel.pending()).toBeNull();
    panel.setReason(textEvent('Second copy for the file'));
    panel.print(true);
    const newer = http.expectOne('/api/c/company-1/print-requests');
    const newerKey = record(newer.request.body)['requestKey'];
    expect(newerKey).not.toBe(firstKey);
    const saved = sessionStorage.getItem('bp.invoicePrint.company-1.invoice-1') ?? '';
    expect(saved).toContain(String(newerKey));
    newer.flush({ printJob: { copies: 1 } });
    expect(sessionStorage.getItem('bp.invoicePrint.company-1.invoice-1')).toBeNull();
    http.verify();
  });

  it('sends nothing when the browser will not keep the request', async () => {
    const { fixture, http, component } = await setup(FULL);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      component.print(false);
    } finally {
      setItem.mockRestore();
    }
    fixture.detectChanges();
    expect(http.match(() => true)).toHaveLength(0);
    expect(component.pending()).toBeNull();
    expect(textOf(fixture)).toContain('Nothing was sent');
    http.verify();
  });

  it('restores a request with a lost answer after the page reloads', async () => {
    const body = {
      documentType: 'invoice',
      sourceType: 'invoice',
      sourceId: 'invoice-1',
      requestKey: '11111111-1111-4111-8111-111111111111',
      reprint: { ofPrintJobId: 'job-1', reason: 'Client lost it' },
    };
    sessionStorage.setItem('bp.invoicePrint.company-1.invoice-1', JSON.stringify({ body }));
    const { http, component } = await setup(FULL, [job('job-1', 'done_reported', false)], 'job-1');
    expect(component.pending()?.body).toEqual(body);
    component.retry();
    const resent = http.expectOne('/api/c/company-1/print-requests');
    expect(resent.request.body).toEqual(body);
    resent.flush({ printJob: { copies: 1 } });
    expect(sessionStorage.getItem('bp.invoicePrint.company-1.invoice-1')).toBeNull();
    http.verify();
  });

  it('asks for a location when several locations print invoices', async () => {
    const { fixture, http, component } = await setup(FULL);
    component.print(false);
    http
      .expectOne('/api/c/company-1/print-requests')
      .flush(
        { error: { code: 'location_required', message: 'x', correlationId: 'corr-3' } },
        { status: 422, statusText: 'Unprocessable Entity' },
      );
    http.expectOne('/api/c/company-1/locations').flush({
      locations: [
        { id: 'loc-1', name: 'Shop', archivedAt: null },
        { id: 'loc-2', name: 'Office', archivedAt: null },
        { id: 'loc-3', name: 'Old store', archivedAt: '2026-01-01T00:00:00Z' },
      ],
    });
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('Several locations print invoices');
    expect(component.locations().map((location) => location.name)).toEqual(['Shop', 'Office']);
    component.setLocation(selectEvent('loc-2'));
    component.print(false);
    const retry = http.expectOne('/api/c/company-1/print-requests');
    expect(retry.request.body).toMatchObject({ locationId: 'loc-2' });
    retry.flush({ printJob: { copies: 2 } });
    http.verify();
  });

  it('reloads when someone else printed first', async () => {
    const { fixture, http, component } = await setup(FULL);
    let changed = 0;
    component.changed.subscribe(() => {
      changed += 1;
    });
    component.print(false);
    http.expectOne('/api/c/company-1/print-requests').flush(
      {
        error: {
          code: 'already_printed',
          message: 'already_printed',
          correlationId: 'corr-2',
          printJobId: 'job-1',
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();
    expect(changed).toBe(1);
    expect(textOf(fixture)).toContain('already printed');
    http.verify();
  });

  it('offers neither action to someone who may only view invoices', async () => {
    const { fixture, http, component } = await setup(['invoice.view']);
    expect(component.canRecord()).toBe(false);
    expect(component.canSeePrinting()).toBe(false);
    expect(textOf(fixture)).not.toContain('Record delivery');
    expect(textOf(fixture)).not.toContain('Print invoice');
    component.record();
    component.print(false);
    expect(http.match(() => true)).toHaveLength(0);
    http.verify();
  });

  it('does not replace a saved reprint when a reload cannot read it', async () => {
    const { fixture, http, component } = await setup(
      FULL,
      [job('job-1', 'done_reported', false)],
      'job-1',
    );
    component.setReason(textEvent('Client lost it'));
    component.print(true);
    const lost = http.expectOne('/api/c/company-1/print-requests');
    const body = record(lost.request.body);
    lost.flush(null, { status: 503, statusText: 'Service Unavailable' });
    fixture.detectChanges();
    const saved = sessionStorage.getItem(INVOICE_KEY);
    expect(saved).toContain(String(body['requestKey']));
    fixture.destroy();

    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    const back = TestBed.createComponent(IssuedActions);
    try {
      mountIssued(back, [job('job-1', 'done_reported', false)], 'job-1');
      const panel = back.componentInstance;
      expect(panel.cannotCheck()).toBe(true);
      expect(panel.pending()).toBeNull();
      expect(panel.canReprint()).toBe(false);
      expect(panel.canFirstPrint()).toBe(false);
      expect(textOf(back)).toContain('Look at the print history');
      expect(exactButton(back, 'Check again')).toBeInstanceOf(HTMLButtonElement);
      expect(textOf(back)).not.toContain('Print invoice');
      expect(textOf(back)).not.toContain('Reprint');
    } finally {
      getItem.mockRestore();
    }

    const panel = back.componentInstance;
    panel.setReason(textEvent('Client lost it'));
    panel.print(true);
    panel.print(false);
    expect(http.match('/api/c/company-1/print-requests')).toHaveLength(0);
    expect(sessionStorage.getItem(INVOICE_KEY)).toBe(saved);
    const check = exactButton(back, 'Check again');
    expect(check).toBeInstanceOf(HTMLButtonElement);
    check?.click();
    back.detectChanges();
    expect(panel.cannotCheck()).toBe(false);
    expect(panel.pending()?.lost).toBe(true);
    expect(panel.pending()?.body).toEqual(body);
    expect(sessionStorage.getItem(INVOICE_KEY)).toBe(saved);
    const retry = exactButton(back, 'Send the same request again');
    expect(retry).toBeInstanceOf(HTMLButtonElement);
    retry?.click();
    const again = http.expectOne('/api/c/company-1/print-requests');
    expect(record(again.request.body)).toEqual(body);
    again.flush({ printJob: { copies: 1 } });
    expect(sessionStorage.getItem(INVOICE_KEY)).toBeNull();
    http.verify();
  });

  it('does not replace a saved request that cannot be parsed', async () => {
    const { fixture, http } = await setup(FULL);
    fixture.destroy();
    sessionStorage.setItem(INVOICE_KEY, '{');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const back = TestBed.createComponent(IssuedActions);
    mountIssued(back);
    const panel = back.componentInstance;
    expect(panel.cannotCheck()).toBe(true);
    expect(panel.canFirstPrint()).toBe(false);
    expect(textOf(back)).toContain('Look at the print history');
    expect(textOf(back)).not.toContain('Print invoice');
    panel.print(false);
    expect(http.match(() => true)).toHaveLength(0);
    expect(setItem).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(INVOICE_KEY)).toBe('{');
    const body = {
      documentType: 'invoice',
      sourceType: 'invoice',
      sourceId: 'invoice-1',
      requestKey: '11111111-1111-4111-8111-111111111111',
    };
    const repaired = JSON.stringify({ body });
    sessionStorage.setItem(INVOICE_KEY, repaired);
    exactButton(back, 'Check again')?.click();
    back.detectChanges();
    expect(panel.cannotCheck()).toBe(false);
    expect(panel.pending()?.body).toEqual(body);
    expect(panel.pending()?.lost).toBe(true);
    expect(sessionStorage.getItem(INVOICE_KEY)).toBe(repaired);
    http.verify();
  });

  it('shows the storage error and sends nothing when site storage is blocked', async () => {
    const { fixture, http, component } = await setup(FULL);
    const restore = blockSiteStorage();
    try {
      component.print(false);
      fixture.detectChanges();
      expect(http.match(() => true)).toHaveLength(0);
      expect(component.pending()).toBeNull();
      expect(component.cannotCheck()).toBe(false);
      expect(textOf(fixture)).toContain('Nothing was sent');
      expect(textOf(fixture)).not.toContain('Cannot check an earlier print request');
    } finally {
      restore();
    }
    http.verify();
  });
});

function mountIssued(
  fixture: ComponentFixture<IssuedActions>,
  printJobs: ReturnType<typeof job>[] = [],
  firstPrintJobId: string | null = null,
): void {
  fixture.componentRef.setInput('companyId', 'company-1');
  fixture.componentRef.setInput('invoiceId', 'invoice-1');
  fixture.componentRef.setInput('deliveries', []);
  fixture.componentRef.setInput('printJobs', printJobs);
  fixture.componentRef.setInput('firstPrintJobId', firstPrintJobId);
  fixture.detectChanges();
}

function exactButton(
  fixture: ComponentFixture<IssuedActions>,
  name: string,
): HTMLButtonElement | undefined {
  const element = fixture.nativeElement as HTMLElement;
  return [...element.querySelectorAll('button')].find((item) => item.textContent.trim() === name);
}

/** Site storage blocked: reading the storage object itself throws. */
function blockSiteStorage(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  if (!descriptor) {
    throw new Error('sessionStorage cannot be blocked in this environment');
  }
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
  return () => {
    Object.defineProperty(globalThis, 'sessionStorage', descriptor);
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('expected an object');
  }
  return value as Record<string, unknown>;
}

function job(
  id: string,
  status: string,
  isReprint: boolean,
): {
  id: string;
  status: string;
  isReprint: boolean;
  copies: number;
  createdAt: string;
  simulationLabel?: string | null;
} {
  return { id, status, isReprint, copies: isReprint ? 1 : 2, createdAt: '2026-10-28T08:00:00Z' };
}

async function setup(
  permissions: string[],
  printJobs: ReturnType<typeof job>[] = [],
  firstPrintJobId: string | null = null,
): Promise<{
  fixture: ComponentFixture<IssuedActions>;
  http: HttpTestingController;
  component: IssuedActions;
}> {
  await TestBed.configureTestingModule({
    imports: [IssuedActions],
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
  }).compileComponents();
  const transloco = TestBed.inject(TranslocoService);
  await firstValueFrom(transloco.load('en'));
  transloco.setActiveLang('en');
  TestBed.inject(CompanyContextStore).grants.set(
    permissions.map((permission): Grant => ({ permission, scopeType: 'company', scopeId: null })),
  );
  const fixture = TestBed.createComponent(IssuedActions);
  fixture.componentRef.setInput('companyId', 'company-1');
  fixture.componentRef.setInput('invoiceId', 'invoice-1');
  fixture.componentRef.setInput('deliveries', []);
  fixture.componentRef.setInput('printJobs', printJobs);
  fixture.componentRef.setInput('firstPrintJobId', firstPrintJobId);
  fixture.detectChanges();
  return {
    fixture,
    http: TestBed.inject(HttpTestingController),
    component: fixture.componentInstance,
  };
}

function checkbox(checked: boolean): Event {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  return { target: input } as unknown as Event;
}

function textEvent(value: string): Event {
  const input = document.createElement('textarea');
  input.value = value;
  return { target: input } as unknown as Event;
}

function selectEvent(value: string): Event {
  const select = document.createElement('select');
  const option = document.createElement('option');
  option.value = value;
  select.append(option);
  select.value = value;
  return { target: select } as unknown as Event;
}

function textOf(fixture: ComponentFixture<unknown>): string {
  const element: unknown = fixture.nativeElement;
  return element instanceof HTMLElement ? element.textContent : '';
}
