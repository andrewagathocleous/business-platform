import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { CompanyContextStore } from '../core/company-context.store';
import type { Grant } from '../core/models';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { type CreditNoteDetail, CreditNoteView } from './credit-note-view';

const DRAFT: CreditNoteDetail = {
  id: 'credit-1',
  status: 'draft',
  number: null,
  version: 3,
  currency: 'EUR',
  creditReason: 'One box damaged',
  creditedInvoice: { id: 'invoice-1', number: 'INV-0007', issueDate: '2026-10-20' },
  netTotal: '10.00',
  taxTotal: '1.90',
  total: '11.90',
  lines: [
    {
      id: 'line-a',
      position: 1,
      description: 'Gift box (demo)',
      quantity: '1.0000',
      unit: 'pc',
      unitPrice: '10.0000',
      discountPercent: '0.00',
      taxCode: 'STD19',
      lineNet: '10.00',
    },
  ],
  taxSummary: [{ taxCode: 'STD19', net: '10.00', tax: '1.90', gross: '11.90' }],
};

describe('CreditNoteView', () => {
  it('saves only what changed, and waits for the save before issuing', async () => {
    const { fixture, http, component, events } = await setup(['invoice.credit'], DRAFT);
    const text = textOf(fixture);
    expect(text).toContain('Credit note (draft)');
    expect(text).toContain('Credits invoice INV-0007 (20/10/2026)');
    expect(text).toContain('11.90 EUR');
    expect(component.dirty()).toBe(false);

    component.setQuantity('line-a', textEvent('0,5'));
    fixture.detectChanges();
    expect(component.dirty()).toBe(true);
    expect(textOf(fixture)).toContain('Save the draft first');
    component.startIssue();
    expect(component.confirming()).toBe(false);

    component.save();
    const save = http.expectOne('/api/c/company-1/credit-notes/credit-1');
    expect(save.request.method).toBe('PATCH');
    expect(save.request.body).toEqual({
      expectedVersion: 3,
      lines: [{ id: 'line-a', quantity: '0.5' }],
    });
    // Nothing can be typed while the save is out: the reload after it would drop it.
    fixture.detectChanges();
    expect(rootOf(fixture).querySelector('textarea')?.disabled).toBe(true);
    save.flush({ creditNote: { id: 'credit-1', version: 4 } });
    expect(events.changed).toBe(1);
    expect(events.saved).toEqual([{ id: 'credit-1', version: 4 }]);
    // The editor loads the saved document again; until then nothing else is sent.
    component.save();
    http.verify();
  });

  it('keeps the reason as typed and refuses a blank one', async () => {
    const { http, component } = await setup(['invoice.credit'], DRAFT);
    component.setReason(textEvent('  \n '));
    component.save();
    expect(component.problem()).toBe('invoices.credit.rules.reason');
    component.setReason(textEvent('Two boxes damaged,\n  one card bent '));
    component.save();
    const save = http.expectOne('/api/c/company-1/credit-notes/credit-1');
    expect(save.request.body).toEqual({
      expectedVersion: 3,
      reason: 'Two boxes damaged,\n  one card bent ',
    });
    save.flush(
      { error: { code: 'conflict', message: 'version conflict', correlationId: 'corr-3' } },
      { status: 409, statusText: 'Conflict' },
    );
    http.verify();
  });

  it('takes no edit, save or issue while the editor reloads the document', async () => {
    const { fixture, http, component } = await setup(['invoice.credit'], DRAFT);
    component.setReason(textEvent('Changed'));
    fixture.componentRef.setInput('frozen', true);
    fixture.detectChanges();
    expect(rootOf(fixture).querySelector('textarea')?.disabled).toBe(true);
    component.save();
    component.startIssue();
    expect(component.confirming()).toBe(false);
    expect(http.match(() => true)).toHaveLength(0);
    http.verify();
  });

  it('passes a stale save to the editor as a conflict', async () => {
    const { http, component, events } = await setup(['invoice.credit'], DRAFT);
    component.setQuantity('line-a', textEvent('2'));
    component.save();
    http
      .expectOne('/api/c/company-1/credit-notes/credit-1')
      .flush(
        { error: { code: 'conflict', message: 'version conflict', correlationId: 'corr-4' } },
        { status: 409, statusText: 'Conflict' },
      );
    expect(events.conflicts).toEqual(['corr-4']);
    expect(component.busy()).toBe(false);
    http.verify();
  });

  it('issues after confirmation and explains a refusal', async () => {
    const { fixture, http, component, events } = await setup(['invoice.credit'], DRAFT);
    component.startIssue();
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('number in the credit-note series');
    component.confirmIssue();
    const refused = http.expectOne('/api/c/company-1/credit-notes/credit-1/issue');
    expect(refused.request.body).toEqual({ expectedVersion: 3 });
    expect(component.editable()).toBe(false);
    refused.flush(
      { error: { code: 'over_credit', message: 'x', correlationId: 'corr-5' } },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('would now credit too much');
    expect(component.editable()).toBe(true);

    component.startIssue();
    component.confirmIssue();
    http.expectOne('/api/c/company-1/credit-notes/credit-1/issue').flush(
      {
        error: {
          code: 'invoice_incomplete',
          message: 'x',
          correlationId: 'corr-6',
          fields: ['series.missing', 'seller.vatNumber', 'lines.1.legalNote'],
        },
      },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    fixture.detectChanges();
    const text = textOf(fixture);
    expect(text).toContain('Choose a default credit-note series');
    expect(text).toContain("The company's VAT number is missing");
    expect(text).toContain('Line 1: its tax code needs the legal note');

    component.startIssue();
    component.confirmIssue();
    http.expectOne('/api/c/company-1/credit-notes/credit-1/issue').flush({ creditNote: {} });
    expect(events.changed).toBe(1);
    http.verify();
  });

  it('shows an issued credit note, or a draft to someone without invoice.credit, as it is', async () => {
    const issued = await setup(['invoice.credit'], {
      ...DRAFT,
      status: 'issued',
      number: 'CN-0002',
      creditReason: 'Line one\nline two',
    });
    expect(textOf(issued.fixture)).toContain('Credit note CN-0002');
    expect(issued.component.editable()).toBe(false);
    expect(issued.component.canIssue()).toBe(false);
    expect(rootOf(issued.fixture).querySelector('[data-testid="credit-reason"]')?.textContent).toBe(
      'Line one\nline two',
    );
    expect(rootOf(issued.fixture).querySelector('textarea')).toBeNull();
    TestBed.resetTestingModule();

    const reader = await setup(['invoice.view'], DRAFT);
    expect(reader.component.editable()).toBe(false);
    expect(textOf(reader.fixture)).not.toContain('Issue credit note');
  });
});

async function setup(
  permissions: string[],
  note: CreditNoteDetail,
): Promise<{
  fixture: ComponentFixture<CreditNoteView>;
  http: HttpTestingController;
  component: CreditNoteView;
  events: { changed: number; saved: unknown[]; conflicts: (string | null)[] };
}> {
  await TestBed.configureTestingModule({
    imports: [CreditNoteView],
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
  const fixture = TestBed.createComponent(CreditNoteView);
  fixture.componentRef.setInput('companyId', 'company-1');
  fixture.componentRef.setInput('note', note);
  fixture.detectChanges();
  const component = fixture.componentInstance;
  const events = { changed: 0, saved: [] as unknown[], conflicts: [] as (string | null)[] };
  component.changed.subscribe((saved) => {
    events.changed += 1;
    events.saved.push(saved);
  });
  component.conflicted.subscribe((correlationId) => {
    events.conflicts.push(correlationId);
  });
  return { fixture, http: TestBed.inject(HttpTestingController), component, events };
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
