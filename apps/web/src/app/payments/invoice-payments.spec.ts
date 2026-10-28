import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { By } from '@angular/platform-browser';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyContextStore } from '../core/company-context.store';
import { SessionStore } from '../core/session.store';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { InvoicePayments } from './invoice-payments';
import { PendingRequest } from './pending-request';
import { MoneyRecordForm, type RecordFields } from './record-form';

const FIELDS: RecordFields & { apply: boolean } = {
  amount: '40.00',
  date: '2026-10-28',
  method: 'bank_transfer',
  reference: 'Demo receipt',
  notes: 'Ελήφθη\n  as typed ',
  apply: true,
};
beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('InvoicePayments', () => {
  it.each(['record', 'reverse'] as const)(
    'clears Saved before a new %s action and its refusal',
    async (action) => {
      const { component, fixture, http } = await setup();
      component.record({ ...FIELDS, apply: false });
      http.expectOne('/api/c/company-1/payments').flush({ payment: { id: 'p' } });
      fixture.detectChanges();
      expect(text(fixture)).toContain('Saved.');
      if (action === 'record') {
        component.recordAnother();
        component.record({ ...FIELDS, apply: false });
      } else {
        component.reasons.set({ a: 'Demo correction' });
        component.reverse('a');
      }
      fixture.detectChanges();
      expect(text(fixture)).not.toContain('Saved.');
      const url =
        action === 'record'
          ? '/api/c/company-1/payments'
          : '/api/c/company-1/allocations/a/reverse';
      http
        .expectOne(url)
        .flush({ error: { code: 'version_conflict' } }, { status: 409, statusText: 'Conflict' });
      fixture.detectChanges();
      expect(text(fixture)).toContain('Reload before trying again');
      expect(text(fixture)).not.toContain('Saved.');
      http.verify();
    },
  );

  it('uses the current company day for an open payment and a new form across midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T21:59:00Z'));
    const { component, fixture, http } = await setup();
    const form = fixture.debugElement
      .query(By.directive(MoneyRecordForm))
      .injector.get(MoneyRecordForm);
    expect(form.date()).toBe('2026-10-28');
    vi.setSystemTime(new Date('2026-10-28T22:01:00Z'));
    form.date.set('2026-10-29');
    form.apply.set(false);
    form.submit();
    const payment = http.expectOne('/api/c/company-1/payments');
    expect(payment.request.body).toMatchObject({ receivedOn: '2026-10-29' });
    payment.flush({ payment: { id: 'p' } });
    fixture.detectChanges();
    component.recordAnother();
    fixture.detectChanges();
    const reopened = fixture.debugElement
      .query(By.directive(MoneyRecordForm))
      .injector.get(MoneyRecordForm);
    expect(reopened.date()).toBe('2026-10-29');
    expect(root(fixture).querySelector('input[type=date]')?.getAttribute('max')).toBe('2026-10-29');
    http.verify();
  });

  it('keeps a lost payment after a 401 retry and offers Discard with a history warning', async () => {
    const { fixture, component, http } = await setup();
    component.record({ ...FIELDS, amount: '20.00', apply: false });
    const first = http.expectOne('/api/c/company-1/payments');
    const key = first.request.headers.get('Idempotency-Key');
    first.error(new ProgressEvent('error'));
    component.retry();
    http
      .expectOne('/api/c/company-1/payments')
      .flush({}, { status: 401, statusText: 'Unauthorized' });
    fixture.detectChanges();
    expect(component.creates.pending()?.request.key).toBe(key);
    expect(text(fixture)).toContain(
      'Check the payment history or the client account before discarding',
    );
    const discard = [...root(fixture).querySelectorAll('button')].find(
      (button) => button.textContent.trim() === 'Discard',
    );
    expect(discard).toBeDefined();
    component.record({ ...FIELDS, amount: '20.00', apply: false });
    http.expectNone('/api/c/company-1/payments');
    discard?.click();
    expect(component.creates.pending()).toBeNull();
    expect(sessionStorage.length).toBe(0);
    http.verify();
  });

  it.each([false, true])(
    'requires a new explicit action after success (apply: %s)',
    async (apply) => {
      const { fixture, component, http } = await setup();
      component.record({ ...FIELDS, apply });
      http.expectOne('/api/c/company-1/payments').flush({ payment: { id: 'p' } });
      component.record({ ...FIELDS, apply }); // A second click before Angular removes the form.
      http.expectNone('/api/c/company-1/payments');
      if (apply) http.expectOne('/api/c/company-1/allocations').flush({ allocation: { id: 'a' } });
      component.record({ ...FIELDS, apply });
      http.expectNone('/api/c/company-1/payments');
      fixture.detectChanges();
      expect(root(fixture).querySelector('bp-money-record-form')).toBeNull();
      const another = [...root(fixture).querySelectorAll('button')].find(
        (button) => button.textContent.trim() === 'Record another payment',
      );
      expect(another).toBeDefined();
      another?.click();
      fixture.detectChanges();
      expect(root(fixture).querySelector('bp-money-record-form')).not.toBeNull();
      component.record({ ...FIELDS, apply: false });
      http.expectOne('/api/c/company-1/payments').flush({ payment: { id: 'another' } });
      http.verify();
    },
  );

  it('retries only the allocation when its answer is lost after recording a payment', async () => {
    const { component, fixture, http, changed } = await setup();
    component.record(FIELDS);
    http.expectOne('/api/c/company-1/payments').flush({ payment: { id: 'p' } });
    const allocation = http.expectOne('/api/c/company-1/allocations');
    const key = allocation.request.headers.get('Idempotency-Key');
    allocation.error(new ProgressEvent('error'));
    expect(changed).toHaveBeenCalledOnce(); // Reload the balance even while its outcome is unknown.
    component.retry();
    fixture.detectChanges();
    expect(component.notice()).toBeNull();
    expect(text(fixture)).not.toContain("stays as the client's credit");
    const retry = http.expectOne('/api/c/company-1/allocations');
    expect(retry.request.headers.get('Idempotency-Key')).toBe(key);
    expect(retry.request.body).toEqual(allocation.request.body);
    http.expectNone('/api/c/company-1/payments');
    retry.flush({ allocation: { id: 'a' } });
    expect(sessionStorage.length).toBe(0);
    http.verify();
  });

  it('records a payment then allocates the smaller amount with separate keys', async () => {
    const { fixture, component, http, changed } = await setup();
    expect(text(fixture)).toContain('Unpaid');
    expect(text(fixture)).toContain('Recording a payment never moves money');
    component.record({ ...FIELDS, amount: '140.00' });
    const payment = http.expectOne('/api/c/company-1/payments');
    expect(payment.request.body).toEqual({
      clientId: 'client-1',
      amount: '140.00',
      receivedOn: FIELDS.date,
      method: FIELDS.method,
      reference: FIELDS.reference,
      notes: FIELDS.notes,
    });
    const key = payment.request.headers.get('Idempotency-Key');
    expect(key).toBeTruthy();
    fixture.detectChanges();
    expect(
      [
        ...root(fixture).querySelectorAll<
          HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        >('input, textarea, select'),
      ].every((field) => field.disabled),
    ).toBe(true);
    component.record(FIELDS);
    payment.flush({ payment: { id: 'payment-1' } });
    const allocation = http.expectOne('/api/c/company-1/allocations');
    expect(component.notice()).toBeNull();
    expect(allocation.request.body).toEqual({
      paymentId: 'payment-1',
      invoiceId: 'invoice-1',
      amount: '100.00',
    });
    expect(allocation.request.headers.get('Idempotency-Key')).not.toBe(key);
    expect(allocation.request.headers.get('Idempotency-Key')).toBeTruthy();
    allocation.flush({ allocation: { id: 'allocation-1' } });
    expect(changed).toHaveBeenCalledOnce();
    expect(sessionStorage.length).toBe(0);
    http.verify();
  });

  it('explains that a recorded payment remains client credit after an allocation refusal', async () => {
    const { fixture, component, http, changed } = await setup();
    component.record(FIELDS);
    http.expectOne('/api/c/company-1/payments').flush({ payment: { id: 'p' } });
    http
      .expectOne('/api/c/company-1/allocations')
      .flush(
        { error: { code: 'over_allocation', correlationId: 'corr-a' } },
        { status: 409, statusText: 'Conflict' },
      );
    fixture.detectChanges();
    expect(text(fixture)).toContain("stays as the client's credit");
    expect(text(fixture)).toContain('exceeds the available credit');
    expect(text(fixture)).toContain('corr-a');
    expect(changed).toHaveBeenCalledOnce();
    expect(component.creates.pending()).toBeNull();
    http.verify();
  });

  it('offers only the same request after a lost or unreadable answer, including after reload', async () => {
    const { fixture, component, http } = await setup();
    component.record({ ...FIELDS, apply: false });
    const original = http.expectOne('/api/c/company-1/payments');
    const key = original.request.headers.get('Idempotency-Key');
    const body: unknown = original.request.body;
    original.flush({}, { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();
    expect(text(fixture)).toContain('Send the same request again');
    component.record({ ...FIELDS, amount: '99.00' });
    expect(http.match('/api/c/company-1/payments')).toHaveLength(0);
    component.retry();
    const retry = http.expectOne('/api/c/company-1/payments');
    expect(retry.request.body).toEqual(body);
    expect(retry.request.headers.get('Idempotency-Key')).toBe(key);
    retry.flush({}); // Unreadable success keeps the key too.
    fixture.destroy();
    const reloaded = TestBed.createComponent(InvoicePayments);
    inputs(reloaded);
    reloaded.detectChanges();
    reloaded.componentInstance.retry();
    const recovered = http.expectOne('/api/c/company-1/payments');
    expect(recovered.request.headers.get('Idempotency-Key')).toBe(key);
    expect(recovered.request.body).toEqual(body);
    recovered.flush({ payment: { id: 'p' } });
    expect(sessionStorage.length).toBe(0);
    http.verify();
  });

  it('ignores a late response after changing document and preserves its pending attempt', async () => {
    const { fixture, component, http, changed } = await setup();
    component.record(FIELDS);
    const old = http.expectOne('/api/c/company-1/payments');
    fixture.componentRef.setInput('invoiceId', 'invoice-2');
    fixture.detectChanges();
    component.record({ ...FIELDS, apply: false });
    const newer = http.expectOne('/api/c/company-1/payments');
    old.flush({ payment: { id: 'old-payment' } });
    expect(changed).not.toHaveBeenCalled();
    expect(
      new PendingRequest('company-1', 'payments', 'invoice.invoice-1', () => 'user-1').read(),
    ).not.toBeNull();
    expect(component.creates.pending()?.request.key).toBe(
      newer.request.headers.get('Idempotency-Key'),
    );
    http.expectNone('/api/c/company-1/allocations');
    newer.flush({ payment: { id: 'new-payment' } });
    expect(changed).toHaveBeenCalledOnce();
    http.verify();
  });

  it('does not send when storing a key fails', async () => {
    const { fixture, component, http } = await setup();
    const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    component.record(FIELDS);
    fixture.detectChanges();
    expect(text(fixture)).toContain('browser could not save');
    http.expectNone('/api/c/company-1/payments');
    blocked.mockRestore();
    http.verify();
  });

  it('has no actions without payment.record and honours withheld MFA permission', async () => {
    const { fixture, component, http } = await setup(false);
    expect(text(fixture)).not.toContain('Record a payment');
    component.record(FIELDS);
    component.reverse('a');
    component.retry();
    http.verify();
    const context = TestBed.inject(CompanyContextStore);
    context.mfaStepUpRequired.set(true);
    context.withheldPermissions.set(['payment.record']);
    fixture.detectChanges();
    expect(text(fixture)).toContain('Record a payment');
  });

  it('shows sources and reversals, freezes reversal inputs and sends the typed reason', async () => {
    const { fixture, component, http, changed } = await setup();
    fixture.componentRef.setInput('allocations', [
      {
        id: 'a',
        amount: '20.00',
        effectiveOn: '2026-10-28',
        reversedOn: null,
        reversalReason: null,
        source: { type: 'payment', id: 'p', receivedOn: '2026-10-27', reference: 'Bank demo' },
      },
      {
        id: 'b',
        amount: '10.00',
        effectiveOn: '2026-10-27',
        reversedOn: '2026-10-28',
        reversalReason: 'Demo reversal',
        source: { type: 'credit_note', id: 'cn', number: 'CN-1' },
      },
    ]);
    fixture.detectChanges();
    expect(text(fixture)).toContain('Bank demo');
    expect(text(fixture)).toContain('Reversed on 28/10/2026: Demo reversal');
    expect(root(fixture).querySelector('a')?.getAttribute('href')).toBe('/c/company-1/invoices/cn');
    component.reasons.set({ a: '  Reassign\ncredit ' });
    component.reverse('a');
    fixture.detectChanges();
    expect(root(fixture).querySelector('input')?.disabled).toBe(true);
    const reverse = http.expectOne('/api/c/company-1/allocations/a/reverse');
    expect(reverse.request.body).toEqual({ reason: '  Reassign\ncredit ' });
    reverse.flush({ allocation: { id: 'a' } });
    expect(changed).toHaveBeenCalledOnce();
    http.verify();
  });
});

async function setup(record = true) {
  await TestBed.configureTestingModule({
    imports: [InvoicePayments],
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
  }).compileComponents();
  const transloco = TestBed.inject(TranslocoService);
  await firstValueFrom(transloco.load('en'));
  transloco.setActiveLang('en');
  TestBed.inject(CompanyContextStore).grants.set(
    record ? [{ permission: 'payment.record', scopeType: 'company', scopeId: null }] : [],
  );
  TestBed.inject(SessionStore).user.set({
    id: 'user-1',
    email: 'admin@example.test',
    displayName: 'Demo admin',
    locale: 'en',
    isPlatformOwner: false,
  });
  const fixture = TestBed.createComponent(InvoicePayments);
  inputs(fixture);
  fixture.detectChanges();
  const changed = vi.fn();
  fixture.componentInstance.changed.subscribe(changed);
  return {
    fixture,
    component: fixture.componentInstance,
    http: TestBed.inject(HttpTestingController),
    changed,
  };
}
function inputs(fixture: ComponentFixture<InvoicePayments>): void {
  for (const [key, value] of Object.entries({
    companyId: 'company-1',
    invoiceId: 'invoice-1',
    clientId: 'client-1',
    currency: 'EUR',
    openBalance: '100.00',
    paymentState: 'unpaid',
  }))
    fixture.componentRef.setInput(key, value);
}
function root(fixture: ComponentFixture<unknown>): HTMLElement {
  const value: unknown = fixture.nativeElement;
  if (!(value instanceof HTMLElement)) throw new Error('no root');
  return value;
}
function text(fixture: ComponentFixture<unknown>): string {
  return root(fixture).textContent.replace(/\s+/g, ' ');
}
