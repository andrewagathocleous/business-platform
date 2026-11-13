import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { CompanyContextStore } from '../core/company-context.store';
import type { Grant } from '../core/models';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { type CreditNoteLink, type CreditableLine, CreditPanel } from './credit-panel';

const LINES: CreditableLine[] = [
  {
    id: 'line-1',
    position: 1,
    description: 'Gift box (demo)',
    quantity: '2.0000',
    unit: 'pc',
    creditedQuantity: '0.5000',
  },
  {
    id: 'line-2',
    position: 2,
    description: 'Card (demo)',
    quantity: '1.0000',
    unit: 'pc',
    creditedQuantity: '1.0000',
  },
];

const NOTES: CreditNoteLink[] = [
  { id: 'credit-1', number: 'CN-0001', status: 'issued', total: '5.95', issueDate: '2026-10-28' },
  { id: 'credit-2', number: null, status: 'draft', total: '11.90', issueDate: null },
];

describe('CreditPanel', () => {
  it('lists the credit notes and drafts a credit of everything not yet credited', async () => {
    const { fixture, http, component, navigate } = await setup(['invoice.credit']);
    const text = textOf(fixture);
    expect(text).toContain('CN-0001');
    expect(text).toContain('Draft');
    expect(text).toContain('11.90 EUR');
    component.start();
    component.create();
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('Give a reason.');
    expect(http.match(() => true)).toHaveLength(0);

    component.setReason(textEvent('Order cancelled\nby phone'));
    component.create();
    const request = http.expectOne('/api/c/company-1/invoices/invoice-1/credit-notes');
    expect(request.request.body).toEqual({ reason: 'Order cancelled\nby phone', full: true });
    request.flush({ creditNote: { id: 'credit-3' } });
    expect(navigate).toHaveBeenCalledWith(['/c', 'company-1', 'invoices', 'credit-3']);
    http.verify();
  });

  it('sends chosen quantities, checked against what is left on each line', async () => {
    const { fixture, http, component } = await setup(['invoice.credit']);
    component.start();
    component.setReason(textEvent('One box damaged'));
    component.setMode('lines');
    fixture.detectChanges();
    // The card is fully credited, so its quantity cannot be typed.
    const inputs = [...rootOf(fixture).querySelectorAll<HTMLInputElement>('table input')];
    expect(inputs.map((input) => input.disabled)).toEqual([false, true]);
    expect(textOf(fixture)).toContain('Credited so far');

    component.create();
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('Enter a quantity on at least one line.');
    component.setQuantity('line-1', textEvent('1,6'));
    component.create();
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('more than is left to credit');
    component.setQuantity('line-1', textEvent('-1'));
    component.create();
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('numbers above zero');
    expect(http.match(() => true)).toHaveLength(0);

    component.setQuantity('line-1', textEvent('1,5'));
    component.create();
    const request = http.expectOne('/api/c/company-1/invoices/invoice-1/credit-notes');
    // The draft is made from what was sent, so nothing can be typed until the answer.
    fixture.detectChanges();
    expect(rootOf(fixture).querySelector('textarea')?.disabled).toBe(true);
    expect(
      [...rootOf(fixture).querySelectorAll<HTMLInputElement>('input')].every(
        (input) => input.disabled,
      ),
    ).toBe(true);
    expect(request.request.body).toEqual({
      reason: 'One box damaged',
      lines: [{ invoiceLineId: 'line-1', quantity: '1.5' }],
    });
    request.flush(
      { error: { code: 'over_credit', message: 'x', correlationId: 'corr-7' } },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('credits more than the invoice shows');
    expect(textOf(fixture)).toContain('corr-7');
    expect(component.busy()).toBe(false);
    http.verify();
  });

  it('links the new draft instead of opening it while another navigation runs', async () => {
    const { fixture, http, component, navigate } = await setup(['invoice.credit']);
    component.start();
    component.setReason(textEvent('Order cancelled'));
    component.create();
    // A company switch starts and waits on its guard.
    Object.defineProperty(TestBed.inject(Router), 'currentNavigation', { value: () => ({}) });
    http
      .expectOne('/api/c/company-1/invoices/invoice-1/credit-notes')
      .flush({ creditNote: { id: 'credit-3' } });
    fixture.detectChanges();
    expect(navigate).not.toHaveBeenCalled();
    expect(component.created()).toBe('credit-3');
    expect(textOf(fixture)).toContain('The draft credit note was created. Open it');
    http.verify();
  });

  it('offers no new credit note without invoice.credit, or once everything is credited', async () => {
    const reader = await setup(['invoice.view']);
    expect(textOf(reader.fixture)).toContain('CN-0001');
    expect(textOf(reader.fixture)).not.toContain('Create a credit note');
    TestBed.resetTestingModule();

    const done = await setup(
      ['invoice.credit'],
      [
        {
          ...LINES[1],
          id: 'line-9',
          quantity: '3.0000',
          creditedQuantity: '3.0000',
        } as CreditableLine,
      ],
    );
    expect(textOf(done.fixture)).toContain('Everything on this invoice has been credited.');
    expect(textOf(done.fixture)).not.toContain('Create a credit note');
  });
});

async function setup(
  permissions: string[],
  lines: CreditableLine[] = LINES,
): Promise<{
  fixture: ComponentFixture<CreditPanel>;
  http: HttpTestingController;
  component: CreditPanel;
  navigate: ReturnType<typeof vi.fn>;
}> {
  await TestBed.configureTestingModule({
    imports: [CreditPanel],
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
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
  TestBed.inject(CompanyContextStore).grants.set(permissions.map(grant));
  const navigate = vi.fn(() => Promise.resolve(true));
  vi.spyOn(TestBed.inject(Router), 'navigate').mockImplementation(navigate);
  const fixture = TestBed.createComponent(CreditPanel);
  fixture.componentRef.setInput('companyId', 'company-1');
  fixture.componentRef.setInput('invoiceId', 'invoice-1');
  fixture.componentRef.setInput('currency', 'EUR');
  fixture.componentRef.setInput('lines', lines);
  fixture.componentRef.setInput('creditNotes', NOTES);
  fixture.detectChanges();
  return {
    fixture,
    http: TestBed.inject(HttpTestingController),
    component: fixture.componentInstance,
    navigate,
  };
}

function grant(permission: string): Grant {
  return { permission, scopeType: 'company', scopeId: null };
}

function textEvent(value: string): Event {
  const input = document.createElement('textarea');
  input.value = value;
  return { target: input } as unknown as Event;
}

function rootOf(fixture: ComponentFixture<unknown>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) {
    throw new Error('no root element');
  }
  return element;
}

function textOf(fixture: ComponentFixture<unknown>): string {
  return rootOf(fixture).textContent.replace(/\s+/g, ' ');
}
