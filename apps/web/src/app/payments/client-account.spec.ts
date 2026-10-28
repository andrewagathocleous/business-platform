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
import { ClientAccount } from './client-account';
import type { AccountView, PaymentDetail } from './payment-view';
import { MoneyRecordForm } from './record-form';

const ACCOUNT: AccountView = {
  openInvoices: [
    {
      id: 'invoice-1',
      number: 'INV-1',
      issueDate: '2026-10-28',
      dueDate: '2026-11-28',
      total: '100.00',
      openBalance: '30.00',
    },
    {
      id: 'invoice-2',
      number: 'INV-2',
      issueDate: '2026-10-28',
      dueDate: null,
      total: '100.00',
      openBalance: '100.00',
    },
  ],
  credits: [
    {
      type: 'payment',
      id: 'payment-1',
      amount: '80.00',
      remaining: '80.00',
      receivedOn: '2026-10-28',
      reference: 'Demo bank',
    },
    {
      type: 'credit_note',
      id: 'credit-1',
      amount: '40.00',
      remaining: '40.00',
      issueDate: '2026-10-28',
      number: 'CN-1',
    },
  ],
  openTotal: '130.00',
  creditTotal: '120.00',
};
const PAYMENT: PaymentDetail = {
  id: 'payment-1',
  version: 2,
  status: 'recorded',
  receivedOn: '2026-10-28',
  reference: 'Demo bank',
  amount: '80.00',
  remaining: '80.00',
  refunds: [
    {
      id: 'refund-1',
      version: 3,
      status: 'recorded',
      amount: '10.00',
      refundedOn: '2026-10-28',
      voidReason: null,
    },
  ],
};
beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ClientAccount', () => {
  it.each(['apply', 'refund'] as const)(
    'clears earlier feedback when a new %s action starts',
    async (mode) => {
      const { component, fixture, http } = await setup();
      const credit = ACCOUNT.credits[1];
      if (!credit) throw new Error('credit missing');
      component.selectCredit(credit, mode);
      component.failure.set({
        key: 'payments.errors.payment_refunded',
        correlationId: 'old-refusal',
      });
      if (mode === 'apply') component.allocate();
      else
        component.refund({
          amount: '10.00',
          date: '2026-10-28',
          method: 'cash',
          reference: '',
          notes: '',
        });
      fixture.detectChanges();
      expect(root(fixture).querySelector('[role=alert]')).toBeNull();
      expect(text(fixture)).not.toContain('old-refusal');
      expect(text(fixture)).not.toContain('Saved.');
      const operation = mode === 'apply' ? 'allocations' : 'refunds';
      http
        .expectOne(`/api/c/company-1/${operation}`)
        .flush({ error: { code: 'over_allocation' } }, { status: 409, statusText: 'Conflict' });
      fixture.detectChanges();
      expect(text(fixture)).toContain('exceeds the available credit');
      expect(text(fixture)).not.toContain('Saved.');
      http.verify();
    },
  );

  it('uses the current company day for an open refund and a new form across midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T21:59:00Z'));
    const { component, fixture, http } = await setup();
    const credit = ACCOUNT.credits[1];
    if (!credit) throw new Error('credit missing');
    component.selectCredit(credit, 'refund');
    fixture.detectChanges();
    const form = fixture.debugElement
      .query(By.directive(MoneyRecordForm))
      .injector.get(MoneyRecordForm);
    expect(form.date()).toBe('2026-10-28');
    vi.setSystemTime(new Date('2026-10-28T22:01:00Z'));
    form.date.set('2026-10-29');
    form.submit();
    const refund = http.expectOne('/api/c/company-1/refunds');
    expect(refund.request.body).toMatchObject({ refundedOn: '2026-10-29' });
    refund.flush({ refund: { id: 'r' } });
    flushAccount(http);
    fixture.detectChanges();
    component.selectCredit(credit, 'refund');
    fixture.detectChanges();
    const reopened = fixture.debugElement
      .query(By.directive(MoneyRecordForm))
      .injector.get(MoneyRecordForm);
    expect(reopened.date()).toBe('2026-10-29');
    expect(root(fixture).querySelector('input[type=date]')?.getAttribute('max')).toBe('2026-10-29');
    http.verify();
  });

  it.each(['account first', 'detail first'])(
    'shows the payment a refund changed when responses arrive %s',
    async (order) => {
      const { component, fixture, http } = await setup();
      component.showPayment(PAYMENT.id);
      http.expectOne('/api/c/company-1/payments/payment-1').flush({ payment: PAYMENT });
      const credit = ACCOUNT.credits[0];
      if (!credit) throw new Error('credit missing');
      component.selectCredit({ ...credit, id: 'payment-2' }, 'refund');
      component.refund({
        amount: '10.00',
        date: '2026-10-28',
        method: 'cash',
        reference: '',
        notes: '',
      });
      http.expectOne('/api/c/company-1/refunds').flush({ refund: { id: 'new-refund' } });
      const changedPayment = {
        ...PAYMENT,
        id: 'payment-2',
        reference: 'Demo B',
        refunds: [{ ...PAYMENT.refunds[0], id: 'new-refund' }],
      };
      const detail = http.expectOne('/api/c/company-1/payments/payment-2');
      if (order === 'account first') flushAccount(http);
      detail.flush({ payment: changedPayment });
      if (order === 'detail first') flushAccount(http);
      fixture.detectChanges();
      expect(component.detail()).toEqual(changedPayment);
      expect(text(fixture)).toContain('Demo B');
      expect(text(fixture)).toContain('Void refund');
      http.expectNone('/api/c/company-1/payments/payment-1');
      http.verify();
    },
  );

  it.each(['success', 'error'])(
    'keeps a newer selection when an account refresh and old detail %s arrive later',
    async (outcome) => {
      const { component, http } = await setup();
      component.showPayment('payment-1');
      const oldDetail = http.expectOne('/api/c/company-1/payments/payment-1');
      component.reload();
      const refreshedDetail = http.expectOne('/api/c/company-1/payments/payment-1');
      component.showPayment('PAYMENT-2');
      const newer = { ...PAYMENT, id: 'payment-2', reference: 'Demo B' };
      http.expectOne('/api/c/company-1/payments/payment-2').flush({ payment: newer });
      flushAccount(http);
      if (outcome === 'success') {
        refreshedDetail.flush({ payment: PAYMENT });
        oldDetail.flush({ payment: PAYMENT });
      } else {
        refreshedDetail.error(new ProgressEvent('error'));
        oldDetail.error(new ProgressEvent('error'));
      }
      expect(component.detail()).toEqual(newer);
      expect(component.busy()).toBe(false);
      expect(component.failure()).toBeNull();
      http.verify();
    },
  );

  it('applies only the newest detail request for the same payment', async () => {
    const { component, http } = await setup();
    component.showPayment('PAYMENT-1');
    const oldDetail = http.expectOne('/api/c/company-1/payments/payment-1');
    component.showPayment('payment-1');
    const newest = { ...PAYMENT, version: 4 };
    http.expectOne('/api/c/company-1/payments/payment-1').flush({ payment: newest });
    oldDetail.flush({ payment: PAYMENT });
    expect(component.detail()).toEqual(newest);
    http.verify();
  });

  it.each(['apply', 'refund'] as const)(
    'closes the %s form after success until another credit action is selected',
    async (mode) => {
      const { component, fixture, http } = await setup();
      const credit = ACCOUNT.credits[1];
      if (!credit) throw new Error('credit missing');
      const fields = {
        amount: '10.00',
        date: '2026-10-28',
        method: 'cash',
        reference: '',
        notes: '',
      };
      const submit = () => {
        if (mode === 'apply') component.allocate();
        else component.refund(fields);
      };
      const operation = mode === 'apply' ? 'allocations' : 'refunds';
      const result = mode === 'apply' ? { allocation: { id: 'a' } } : { refund: { id: 'r' } };
      component.selectCredit(credit, mode);
      fixture.detectChanges();
      submit();
      http.expectOne(`/api/c/company-1/${operation}`).flush(result);
      submit();
      http.expectNone(`/api/c/company-1/${operation}`);
      flushAccount(http);
      submit();
      http.expectNone(`/api/c/company-1/${operation}`);
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-testid="credit-action"]')).toBeNull();
      component.selectCredit(credit, mode);
      submit();
      http.expectOne(`/api/c/company-1/${operation}`).flush(result);
      flushAccount(http);
      http.verify();
    },
  );

  it('uses the API method codes for the labelled refund options', async () => {
    const { component, fixture, http } = await setup();
    const credit = ACCOUNT.credits[1];
    if (!credit) throw new Error('credit missing');
    component.selectCredit(credit, 'refund');
    fixture.detectChanges();
    const select = root(fixture).querySelector<HTMLSelectElement>('bp-money-record-form select');
    if (!select) throw new Error('method select missing');
    expect([...select.options].map((option) => [option.textContent.trim(), option.value])).toEqual([
      ['Bank transfer', 'bank_transfer'],
      ['Card', 'card'],
      ['Cash', 'cash'],
      ['Store', 'store'],
      ['Other', 'other'],
    ]);
    select.value = 'cash';
    select.dispatchEvent(new Event('change'));
    const submit = [
      ...root(fixture).querySelectorAll<HTMLButtonElement>('[data-testid="credit-action"] button'),
    ].find((button) => button.textContent.trim() === 'Record a refund');
    if (!submit) throw new Error('refund button missing');
    submit.click();
    const refund = http.expectOne('/api/c/company-1/refunds');
    expect(refund.request.body).toMatchObject({ method: 'cash' });
    refund.flush({ refund: { id: 'r' } });
    flushAccount(http);
    http.verify();
  });

  it('lists open invoices and credits with exact totals and links', async () => {
    const { fixture, http } = await setup();
    expect(text(fixture)).toContain('Total money owing: 130.00 EUR');
    expect(text(fixture)).toContain('Total unused credit: 120.00 EUR');
    expect(root(fixture).querySelector('a')?.getAttribute('href')).toBe(
      '/c/company-1/invoices/invoice-1',
    );
    expect(text(fixture)).toContain('CN-1');
    http.verify();
  });

  it('allocates from either kind of credit and defaults to the smaller balance', async () => {
    const { component, fixture, http } = await setup();
    const credit = ACCOUNT.credits[1];
    if (!credit) throw new Error('credit missing');
    component.selectCredit(credit, 'apply');
    fixture.detectChanges();
    expect(component.amount()).toBe('30.00');
    component.chooseInvoice(event('invoice-2'));
    expect(component.amount()).toBe('40.00');
    component.amount.set('20,50');
    component.allocate();
    const allocation = http.expectOne('/api/c/company-1/allocations');
    expect(allocation.request.body).toEqual({
      creditNoteId: 'credit-1',
      invoiceId: 'invoice-2',
      amount: '20.50',
    });
    expect(allocation.request.headers.get('Idempotency-Key')).toBeTruthy();
    allocation.flush({ allocation: { id: 'allocation-1' } });
    flushAccount(http);
    http.verify();
  });

  it('freezes the form, retries a lost refund unchanged and refreshes the payment detail', async () => {
    const { component, fixture, http } = await setup();
    const credit = ACCOUNT.credits[0];
    if (!credit) throw new Error('credit missing');
    component.selectCredit(credit, 'refund');
    fixture.detectChanges();
    expect(text(fixture)).toContain('This does not send money');
    const fields = {
      amount: '10.00',
      date: '2026-10-28',
      method: 'cash',
      reference: 'demo',
      notes: 'Refund\n  as typed ',
    };
    component.refund(fields);
    fixture.detectChanges();
    const original = http.expectOne('/api/c/company-1/refunds');
    expect(original.request.body).toEqual({
      paymentId: 'payment-1',
      amount: fields.amount,
      refundedOn: fields.date,
      method: fields.method,
      reference: fields.reference,
      notes: fields.notes,
    });
    const key = original.request.headers.get('Idempotency-Key');
    original.error(new ProgressEvent('error'));
    fixture.detectChanges();
    expect(text(fixture)).toContain('Send the same request again');
    expect(
      root(fixture).querySelector('[data-testid="credit-action"] input')?.hasAttribute('disabled'),
    ).toBe(true);
    component.refund({ ...fields, amount: '30.00' });
    http.expectNone('/api/c/company-1/refunds');
    component.retry();
    const retry = http.expectOne('/api/c/company-1/refunds');
    expect(retry.request.headers.get('Idempotency-Key')).toBe(key);
    expect(retry.request.body).toEqual(original.request.body);
    retry.flush({ refund: { id: 'refund-1' } });
    http.expectOne('/api/c/company-1/payments/payment-1').flush({ payment: PAYMENT });
    flushAccount(http);
    fixture.detectChanges();
    expect(text(fixture)).toContain('Void refund');
    http.verify();
  });

  it('voids with versions from payment detail and explains conflicts and active refunds', async () => {
    const { component, fixture, http } = await setup();
    component.showPayment('payment-1');
    http.expectOne('/api/c/company-1/payments/payment-1').flush({ payment: PAYMENT });
    component.voidReason.set('Demo correction');
    component.voidPayment();
    fixture.detectChanges();
    expect(
      root(fixture).querySelector('[data-testid="payment-detail"] input')?.hasAttribute('disabled'),
    ).toBe(true);
    const refused = http.expectOne('/api/c/company-1/payments/payment-1/void');
    expect(refused.request.body).toEqual({ expectedVersion: 2, reason: 'Demo correction' });
    refused.flush(
      { error: { code: 'payment_refunded', correlationId: 'corr-r' } },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();
    expect(text(fixture)).toContain('Void its refunds first');
    expect(text(fixture)).toContain('corr-r');
    component.refundReasons.set({ 'refund-1': '  Demo\ncorrection ' });
    const refund = PAYMENT.refunds[0];
    if (!refund) throw new Error('refund missing');
    component.voidRefund(refund);
    const voided = http.expectOne('/api/c/company-1/refunds/refund-1/void');
    expect(voided.request.body).toEqual({ expectedVersion: 3, reason: '  Demo\ncorrection ' });
    voided.flush(
      { error: { code: 'version_conflict', correlationId: 'corr-v' } },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();
    expect(text(fixture)).toContain('Reload before trying again');
    component.reload();
    flushAccount(http);
    http
      .expectOne('/api/c/company-1/payments/payment-1')
      .flush({ payment: { ...PAYMENT, version: 4 } });
    component.voidReason.set('Reloaded');
    component.voidPayment();
    const afterReload = http.expectOne('/api/c/company-1/payments/payment-1/void');
    expect(afterReload.request.body).toEqual({ expectedVersion: 4, reason: 'Reloaded' });
    afterReload.flush({ payment: { id: 'payment-1' } });
    flushAccount(http);
    http
      .expectOne('/api/c/company-1/payments/payment-1')
      .flush({ payment: { ...PAYMENT, status: 'voided' } });
    http.verify();
  });

  it.each([
    ['over_allocation', 'exceeds the available credit'],
    ['not_allocatable', 'can no longer be allocated'],
    ['idempotency_key_reused', 'already used with different details'],
  ])('explains %s and clears a refused create', async (code, message) => {
    const { component, fixture, http } = await setup();
    const credit = ACCOUNT.credits[0];
    if (!credit) throw new Error('credit missing');
    component.selectCredit(credit, 'apply');
    component.allocate();
    http
      .expectOne('/api/c/company-1/allocations')
      .flush({ error: { code, correlationId: 'corr-1' } }, { status: 409, statusText: 'Conflict' });
    fixture.detectChanges();
    expect(text(fixture)).toContain(message);
    expect(text(fixture)).toContain('corr-1');
    expect(component.creates.pending()).toBeNull();
    expect(sessionStorage.length).toBe(0);
    http.verify();
  });

  it('shows no record actions without payment.record', async () => {
    const { component, fixture, http } = await setup(false);
    expect(text(fixture)).not.toContain('Apply to an invoice');
    expect(text(fixture)).not.toContain('Record a refund');
    expect(text(fixture)).not.toContain('Void payment');
    const credit = ACCOUNT.credits[0];
    if (!credit) throw new Error('credit missing');
    component.selectCredit(credit, 'refund');
    component.allocate();
    component.voidReason.set('Demo');
    component.voidPayment();
    expect(component.selected()).toBeNull();
    http.verify();
  });

  it('ignores an old account and a late create after the client changes', async () => {
    const { component, fixture, http } = await setup();
    const credit = ACCOUNT.credits[0];
    if (!credit) throw new Error('credit missing');
    component.selectCredit(credit, 'apply');
    component.allocate();
    const oldCreate = http.expectOne('/api/c/company-1/allocations');
    component.reload();
    const oldAccount = http.expectOne('/api/c/company-1/clients/client-1/account');
    const oldList = http.expectOne((request) => request.url === '/api/c/company-1/payments');
    fixture.componentRef.setInput('clientId', 'client-2');
    fixture.detectChanges();
    oldCreate.flush({ allocation: { id: 'old' } });
    oldAccount.flush(ACCOUNT);
    oldList.flush({ payments: [PAYMENT] });
    expect(component.account()).toBeNull();
    http
      .expectOne('/api/c/company-1/clients/client-2/account')
      .flush({ ...ACCOUNT, credits: [], openInvoices: [] });
    http
      .expectOne(
        (request) =>
          request.url === '/api/c/company-1/payments' &&
          request.params.get('clientId') === 'client-2',
      )
      .flush({ payments: [] });
    expect(component.account()?.credits).toEqual([]);
    expect(sessionStorage.length).toBe(1);
    http.verify();
  });
});

async function setup(record = true) {
  await TestBed.configureTestingModule({
    imports: [ClientAccount],
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
    ['invoice.view', ...(record ? ['payment.record'] : [])].map((permission) => ({
      permission,
      scopeType: 'company',
      scopeId: null,
    })),
  );
  TestBed.inject(SessionStore).user.set({
    id: 'user-1',
    email: 'admin@example.test',
    displayName: 'Demo admin',
    locale: 'en',
    isPlatformOwner: false,
  });
  const fixture = TestBed.createComponent(ClientAccount);
  fixture.componentRef.setInput('companyId', 'company-1');
  fixture.componentRef.setInput('clientId', 'client-1');
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  flushAccount(http);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, http };
}
function flushAccount(http: HttpTestingController): void {
  http.expectOne('/api/c/company-1/clients/client-1/account').flush(ACCOUNT);
  http
    .expectOne(
      (request) =>
        request.url === '/api/c/company-1/payments' &&
        request.params.get('clientId') === 'client-1',
    )
    .flush({ payments: [PAYMENT] });
}
function root(fixture: ComponentFixture<unknown>): HTMLElement {
  const value: unknown = fixture.nativeElement;
  if (!(value instanceof HTMLElement)) throw new Error('no root');
  return value;
}
function text(fixture: ComponentFixture<unknown>): string {
  return root(fixture).textContent.replace(/\s+/g, ' ');
}
function event(value: string): Event {
  const input = document.createElement('select');
  input.append(new Option(value, value));
  input.value = value;
  return { target: input } as unknown as Event;
}
