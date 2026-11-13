import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { BehaviorSubject, firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanyContextStore } from '../core/company-context.store';
import type { Grant } from '../core/models';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import {
  InvoicingPage,
  type BankAccountView,
  type SeriesView,
  type TaxCodeView,
} from './invoicing-page';

describe('InvoicingPage', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('shows the lists without edit buttons for a viewer, and skips bank accounts without bank access', async () => {
    const { fixture, http } = await setup(['invoice.view', 'catalog.view', 'company.view']);
    flushLoad(http, { bank: false });
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('STD19');
    expect(textOf(fixture)).toContain('INV-0007');
    expect(textOf(fixture)).not.toContain('Bank accounts');
    expect(buttonLabels(fixture)).not.toContain('Edit');
    expect(buttonLabels(fixture)).not.toContain('Add tax code');
    http.verify();
  });

  it('sends only the unlocked fields for a tax code in use, and explains a refusal', async () => {
    const { fixture, http } = await setup(['invoice.view', 'catalog.view', 'tax.manage']);
    flushLoad(http, { bank: false });
    fixture.detectChanges();
    const page = fixture.componentInstance;
    page.editTax(taxCode({ inUse: true }));
    page.setTax('name', inputEvent('Standard 19 % (checked)'));
    page.setTax('ratePercent', inputEvent('21'));
    page.saveTax();
    const patch = http.expectOne('/api/c/company-1/tax-codes/tax-1');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ expectedVersion: 3, name: 'Standard 19 % (checked)' });
    patch.flush(
      {
        error: {
          code: 'tax_code_in_use',
          message: 'An invoice line uses this tax code.',
          correlationId: 'c-1',
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();
    expect(page.errorIn('tax')).toContain('Create a new code instead');
    http.verify();
  });

  it('reloads after a version conflict', async () => {
    const { fixture, http } = await setup([
      'invoice.view',
      'catalog.view',
      'invoice.series.manage',
    ]);
    flushLoad(http, { bank: false });
    const page = fixture.componentInstance;
    page.editSeries(series());
    page.setSeries('nextNumber', inputEvent('9'));
    page.saveSeries();
    const patch = http.expectOne('/api/c/company-1/invoice-series/series-1');
    expect(patch.request.body).toEqual({ expectedVersion: 2, nextNumber: 9 });
    patch.flush(
      { error: { code: 'conflict', message: 'version_conflict', correlationId: 'c-2' } },
      { status: 409, statusText: 'Conflict' },
    );
    expect(page.seriesForm()).toBeNull();
    expect(page.errorIn('series')).toContain('Someone else changed this');
    http
      .expectOne('/api/c/company-1/invoice-series')
      .flush({ series: [series({ nextNumber: 8, version: 3 })] });
    expect(page.series()[0]?.version).toBe(3);
    http.verify();
  });

  it('keeps unsaved terms when another section saves', async () => {
    const { fixture, http } = await setup([
      'invoice.view',
      'catalog.view',
      'tax.manage',
      'company.manage',
    ]);
    flushLoad(http, { bank: false });
    const page = fixture.componentInstance;
    page.setTerms('invoiceTermsEn', inputEvent('Typed but not saved'));
    page.editTax(taxCode());
    page.setTax('name', inputEvent('Renamed'));
    page.saveTax();
    http.expectOne('/api/c/company-1/tax-codes/tax-1').flush({ taxCode: taxCode() });
    http.expectOne('/api/c/company-1/tax-codes').flush({ taxCodes: [taxCode()] });
    expect(page.termsForm()?.invoiceTermsEn).toBe('Typed but not saved');
    http.verify();
  });

  it('does not open another row or accept typing while a save is pending', async () => {
    const { fixture, http } = await setup(['invoice.view', 'catalog.view', 'tax.manage']);
    flushLoad(http, { bank: false });
    fixture.detectChanges();
    const page = fixture.componentInstance;
    page.editTax(taxCode());
    page.setTax('name', inputEvent('Renamed'));
    page.saveTax();
    fixture.detectChanges();
    page.editTax(taxCode({ id: 'tax-2', code: 'RED9', name: 'Reduced 9 %' }));
    expect(page.taxForm()?.id).toBe('tax-1');
    const fieldset = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="tax-form"] fieldset',
    );
    expect(fieldset instanceof HTMLFieldSetElement && fieldset.disabled).toBe(true);
    http.expectOne('/api/c/company-1/tax-codes/tax-1').flush({ taxCode: taxCode() });
    // Still locked until the refreshed list, with the new version, arrives.
    expect(page.busy()).toBe(true);
    page.editTax(taxCode());
    expect(page.taxForm()).toBeNull();
    http.expectOne('/api/c/company-1/tax-codes').flush({ taxCodes: [taxCode({ version: 4 })] });
    expect(page.busy()).toBe(false);
    page.editTax(page.taxCodes()[0] ?? taxCode());
    expect(page.taxForm()?.version).toBe(4);
    http.verify();
  });

  it('closes an unchanged form without a request', async () => {
    const { fixture, http } = await setup(['invoice.view', 'catalog.view', 'tax.manage']);
    flushLoad(http, { bank: false });
    const page = fixture.componentInstance;
    page.editTax(taxCode());
    page.saveTax();
    expect(page.taxForm()).toBeNull();
    http.verify();
  });

  it('does not keep Save disabled after switching company during a save', async () => {
    const { fixture, http } = await setup(['invoice.view', 'catalog.view', 'tax.manage']);
    flushLoad(http, { bank: false });
    const page = fixture.componentInstance;
    page.editTax(taxCode());
    page.setTax('name', inputEvent('Renamed'));
    page.saveTax();
    expect(page.busy()).toBe(true);
    const pending = http.expectOne('/api/c/company-1/tax-codes/tax-1');
    page.open('company-2');
    expect(page.busy()).toBe(false);
    pending.flush({ taxCode: taxCode() });
    expect(page.busy()).toBe(false);
    http.match(() => true);
  });

  it('normalises the IBAN and BIC it sends', async () => {
    const { fixture, http } = await setup([
      'invoice.view',
      'catalog.view',
      'company.bank.view',
      'company.bank.manage',
    ]);
    flushLoad(http, { bank: true });
    const page = fixture.componentInstance;
    page.newBank();
    page.setBank('bankName', inputEvent('Fictional Bank'));
    page.setBank('accountHolder', inputEvent('Demo Company A Ltd (fictional)'));
    page.setBank('iban', inputEvent('gr16 0110 1250 0000 0001 2300 695'));
    page.setBank('bic', inputEvent(' abcdgr2a '));
    page.saveBank();
    const post = http.expectOne('/api/c/company-1/bank-accounts');
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({
      bankName: 'Fictional Bank',
      accountHolder: 'Demo Company A Ltd (fictional)',
      iban: 'GR1601101250000000012300695',
      bic: 'ABCDGR2A',
      shownOnInvoices: false,
    });
    post.flush({ bankAccount: bankAccount() });
    http.expectOne('/api/c/company-1/bank-accounts').flush({ bankAccounts: [bankAccount()] });
    http.verify();
  });

  it('clears a default series with null and leaves unchanged terms out', async () => {
    const { fixture, http } = await setup(['invoice.view', 'catalog.view', 'company.manage']);
    flushLoad(http, { bank: false, company: { defaultInvoiceSeriesId: 'series-1' } });
    const page = fixture.componentInstance;
    page.setTerms('defaultInvoiceSeriesId', inputEvent(''));
    page.setTerms('invoiceTermsEl', inputEvent('Πληρωμή εντός 30 ημερών.'));
    page.saveTerms();
    const patch = http.expectOne('/api/c/company-1/company');
    expect(patch.request.body).toEqual({
      expectedVersion: 4,
      defaultInvoiceSeriesId: null,
      invoiceTermsEl: 'Πληρωμή εντός 30 ημερών.',
    });
    patch.flush({
      company: company({ version: 5, invoiceTermsEl: 'Πληρωμή εντός 30 ημερών.' }),
    });
    expect(page.termsForm()).toEqual(
      expect.objectContaining({
        defaultInvoiceSeriesId: '',
        invoiceTermsEl: 'Πληρωμή εντός 30 ημερών.',
      }),
    );
    expect(page.busy()).toBe(false);
    http.verify();
  });

  it('keeps the terms locked after a conflict until the latest values arrive', async () => {
    const { fixture, http } = await setup(['invoice.view', 'catalog.view', 'company.manage']);
    flushLoad(http, { bank: false });
    const page = fixture.componentInstance;
    page.setTerms('invoiceTermsEn', inputEvent('Mine'));
    page.saveTerms();
    http
      .expectOne('/api/c/company-1/company')
      .flush(
        { error: { code: 'conflict', message: 'version_conflict', correlationId: 'c-3' } },
        { status: 409, statusText: 'Conflict' },
      );
    expect(page.busy()).toBe(true);
    http
      .expectOne('/api/c/company-1/context')
      .flush({ company: company({ version: 6, invoiceTermsEn: 'Theirs' }) });
    expect(page.busy()).toBe(false);
    expect(page.termsForm()?.invoiceTermsEn).toBe('Theirs');
    http.verify();
  });
});

async function setup(
  permissions: string[],
): Promise<{ fixture: ComponentFixture<InvoicingPage>; http: HttpTestingController }> {
  const companyIds = new BehaviorSubject(convertToParamMap({ companyId: 'company-1' }));
  await TestBed.configureTestingModule({
    imports: [InvoicingPage],
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
      {
        provide: ActivatedRoute,
        useValue: {
          parent: { paramMap: companyIds.asObservable() },
          paramMap: of(convertToParamMap({})),
          snapshot: { paramMap: convertToParamMap({}) },
        },
      },
      { provide: Router, useValue: { navigate: vi.fn(() => Promise.resolve(true)) } },
    ],
  }).compileComponents();
  const transloco = TestBed.inject(TranslocoService);
  await firstValueFrom(transloco.load('en'));
  transloco.setActiveLang('en');
  TestBed.inject(CompanyContextStore).grants.set(permissions.map(grant));
  const fixture = TestBed.createComponent(InvoicingPage);
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController) };
}

function flushLoad(
  http: HttpTestingController,
  options: { bank: boolean; company?: Record<string, unknown> },
): void {
  http.expectOne('/api/c/company-1/tax-codes').flush({ taxCodes: [taxCode()] });
  http.expectOne('/api/c/company-1/invoice-series').flush({ series: [series()] });
  if (options.bank) {
    http.expectOne('/api/c/company-1/bank-accounts').flush({ bankAccounts: [bankAccount()] });
  }
  http.expectOne('/api/c/company-1/context').flush({ company: company(options.company) });
}

function taxCode(overrides: Partial<TaxCodeView> = {}): TaxCodeView {
  return {
    id: 'tax-1',
    code: 'STD19',
    name: 'Standard 19 %',
    ratePercent: '19.0000',
    kind: 'standard',
    noteEn: null,
    noteEl: null,
    deadlineRule: 'days_30',
    isExample: true,
    active: true,
    inUse: false,
    version: 3,
    ...overrides,
  };
}

function series(overrides: Partial<SeriesView> = {}): SeriesView {
  return {
    id: 'series-1',
    code: 'INV',
    documentType: 'invoice',
    prefix: 'INV-',
    nextNumber: 7,
    padding: 4,
    active: true,
    hasIssued: false,
    version: 2,
    ...overrides,
  };
}

function bankAccount(overrides: Partial<BankAccountView> = {}): BankAccountView {
  return {
    id: 'bank-1',
    bankName: 'Fictional Bank',
    accountHolder: 'Demo Company A Ltd (fictional)',
    iban: 'CY17002001280000001200527600',
    bic: null,
    shownOnInvoices: true,
    active: true,
    version: 0,
    ...overrides,
  };
}

function company(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'company-1',
    version: 4,
    invoiceTermsEn: null,
    invoiceTermsEl: null,
    defaultInvoiceSeriesId: null,
    defaultCreditNoteSeriesId: null,
    defaultQuoteSeriesId: null,
    ...overrides,
  };
}

function grant(permission: string): Grant {
  return { permission, scopeType: 'company', scopeId: null };
}

function inputEvent(value: string): Event {
  const input = document.createElement('input');
  input.value = value;
  return { target: input } as unknown as Event;
}

function textOf(fixture: ComponentFixture<unknown>): string {
  return (fixture.nativeElement as HTMLElement).textContent;
}

function buttonLabels(fixture: ComponentFixture<unknown>): string[] {
  return [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].map((button) =>
    button.textContent.trim(),
  );
}
