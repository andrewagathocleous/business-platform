import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { BehaviorSubject, firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanyContextStore } from '../core/company-context.store';
import type { CompanyContext, Grant } from '../core/models';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { CompanyPage } from './company-page';

describe('CompanyPage', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('hides save and disables the fields without company.manage', async () => {
    const { fixture, http } = await setup(['company.view']);
    flushCompany(http);
    fixture.detectChanges();
    const controls = [...element(fixture).querySelectorAll('input, select')];
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((control) => 'disabled' in control && control.disabled)).toBe(true);
    expect(buttonLabels(fixture)).not.toContain('Save');
    http.verify();
  });

  it('keeps a typed legal name on a version conflict and replaces it on reload', async () => {
    const { fixture, http } = await setup(['company.view', 'company.manage']);
    flushCompany(http, { legalName: 'Demo Company A Ltd (fictional)', version: 1 });
    fixture.detectChanges();
    fixture.componentInstance.legalName.set('Typed Name');
    fixture.detectChanges();
    expect(inputValue(fixture, 0)).toBe('Typed Name');
    fixture.componentInstance.save();
    const patch = http.expectOne('/api/c/company-1/company');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({
      expectedVersion: 1,
      legalName: 'Typed Name',
    });
    patch.flush(
      { error: { message: 'version_conflict', code: 'conflict', correlationId: 'corr-1' } },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();
    expect(fixture.componentInstance.legalName()).toBe('Typed Name');
    expect(inputValue(fixture, 0)).toBe('Typed Name');
    expect(textOf(fixture)).toContain(
      'Someone else saved these details. Reload before saving again.',
    );
    button(fixture, 'Reload').click();
    flushCompany(http, { legalName: 'Saved by someone else', version: 2 });
    fixture.detectChanges();
    expect(fixture.componentInstance.legalName()).toBe('Saved by someone else');
    expect(inputValue(fixture, 0)).toBe('Saved by someone else');
    expect(textOf(fixture)).not.toContain('Someone else saved these details');
    expect(controlsDisabled(fixture)).toBe(false);
    http.verify();
  });

  it('does not save company A into company B while B is still loading', async () => {
    const companies = new BehaviorSubject(convertToParamMap({ companyId: 'company-a' }));
    const { fixture, http } = await setup(['company.view', 'company.manage'], companies);
    http
      .expectOne('/api/c/company-a/context')
      .flush({ company: companyPayload({ id: 'company-a', legalName: 'Alpha Legal' }) });
    fixture.detectChanges();
    fixture.componentInstance.legalName.set('Alpha Edited');
    fixture.detectChanges();
    expect(inputValue(fixture, 0)).toBe('Alpha Edited');

    companies.next(convertToParamMap({ companyId: 'company-b' }));
    fixture.detectChanges();
    const pending = http.expectOne('/api/c/company-b/context');
    expect(fixture.componentInstance.loaded()).toBe(false);
    expect(fixture.componentInstance.legalName()).toBe('');
    expect(element(fixture).querySelector('form')).toBeNull();
    fixture.componentInstance.save();
    expect(http.match((request) => request.method === 'PATCH')).toEqual([]);

    pending.flush({ company: companyPayload({ id: 'company-b', legalName: 'Beta Legal' }) });
    fixture.detectChanges();
    expect(fixture.componentInstance.legalName()).toBe('Beta Legal');
    expect(inputValue(fixture, 0)).toBe('Beta Legal');
    http.verify();
  });

  it('drops the form when the context company changes before the route does', async () => {
    const { fixture, http } = await setup(['company.view', 'company.manage']);
    flushCompany(http, { legalName: 'Alpha Legal' });
    fixture.detectChanges();
    fixture.componentInstance.legalName.set('Alpha Edited');
    fixture.detectChanges();
    const store = TestBed.inject(CompanyContextStore);
    store.companyId.set('company-b');
    fixture.detectChanges();
    expect(fixture.componentInstance.loaded()).toBe(false);
    expect(fixture.componentInstance.legalName()).toBe('');
    fixture.componentInstance.save();
    expect(http.match((request) => request.method === 'PATCH')).toEqual([]);

    store.companyId.set('company-1');
    fixture.detectChanges();
    http
      .expectOne('/api/c/company-1/context')
      .flush({ company: companyPayload({ legalName: 'Alpha Legal' }) });
    fixture.detectChanges();
    expect(fixture.componentInstance.legalName()).toBe('Alpha Legal');
    http.verify();
  });

  it('sends null when the VAT number is emptied', async () => {
    const { fixture, http } = await setup(['company.view', 'company.manage']);
    flushCompany(http, { vatNumber: 'CY123' });
    fixture.detectChanges();
    await primeContext(http);
    fixture.componentInstance.vatNumber.set('');
    fixture.componentInstance.save();
    const patch = http.expectOne('/api/c/company-1/company');
    expect(patch.request.body).toEqual({ expectedVersion: 1, vatNumber: null });
    patch.flush({ company: companyPayload({ vatNumber: null, version: 2 }) });
    flushContextReload(http);
    http.verify();
  });

  it('omits an emptied address line 2 and postcode', async () => {
    const { fixture, http } = await setup(['company.view', 'company.manage']);
    flushCompany(http, {
      address: {
        line1: '1 Demo Street',
        line2: 'Suite 2',
        city: 'Nicosia',
        postcode: '1010',
        countryCode: 'CY',
      },
    });
    fixture.detectChanges();
    await primeContext(http);
    fixture.componentInstance.line2.set('');
    fixture.componentInstance.postcode.set('');
    fixture.componentInstance.save();
    const patch = http.expectOne('/api/c/company-1/company');
    expect(patch.request.body).toEqual({
      expectedVersion: 1,
      address: { line1: '1 Demo Street', city: 'Nicosia', countryCode: 'CY' },
    });
    patch.flush({
      company: companyPayload({
        version: 2,
        address: { line1: '1 Demo Street', city: 'Nicosia', countryCode: 'CY' },
      }),
    });
    flushContextReload(http);
    http.verify();
  });

  it('reloads the shared currency after a company save', async () => {
    const { fixture, http } = await setup(['company.view', 'company.manage']);
    flushCompany(http, { defaultCurrency: 'EUR' });
    fixture.detectChanges();
    const store = TestBed.inject(CompanyContextStore);
    const loaded = store.load('company-1');
    http.expectOne('/api/c/company-1/context').flush(storedContext('EUR'));
    await loaded;
    expect(store.currency()).toBe('EUR');

    fixture.componentInstance.currency.set('USD');
    fixture.detectChanges();
    fixture.componentInstance.save();
    const patch = http.expectOne('/api/c/company-1/company');
    expect(patch.request.body).toEqual({ expectedVersion: 1, defaultCurrency: 'USD' });
    patch.flush({ company: companyPayload({ defaultCurrency: 'USD', version: 2 }) });
    http.expectOne('/api/c/company-1/context').flush(storedContext('USD'));
    await fixture.whenStable();
    expect(store.currency()).toBe('USD');
    http.verify();
  });

  it('disables save when the trading name is emptied', async () => {
    const { fixture, http } = await setup(['company.view', 'company.manage']);
    flushCompany(http);
    fixture.detectChanges();
    const trading = labeledInput(fixture, 'Trading name');
    expect(trading.required).toBe(true);
    expect(trading.closest('label')?.textContent).toContain('Required');
    fixture.componentInstance.tradingName.set('');
    fixture.detectChanges();
    expect(fixture.componentInstance.dirty()).toBe(true);
    expect(fixture.componentInstance.canSave()).toBe(false);
    expect(button(fixture, 'Save').disabled).toBe(true);
    fixture.componentInstance.save();
    expect(http.match((request) => request.method === 'PATCH')).toEqual([]);
    http.verify();
  });

  it('disables the fields while a save is in flight', async () => {
    const { fixture, http } = await setup(['company.view', 'company.manage']);
    flushCompany(http);
    fixture.detectChanges();
    await primeContext(http);
    fixture.componentInstance.legalName.set('Pending Name');
    fixture.detectChanges();
    fixture.componentInstance.save();
    fixture.detectChanges();
    expect(controlsDisabled(fixture)).toBe(true);
    expect(button(fixture, 'Save').disabled).toBe(true);

    http
      .expectOne('/api/c/company-1/company')
      .flush(
        { error: { message: 'nope', code: 'bad_request' } },
        { status: 400, statusText: 'Bad Request' },
      );
    fixture.detectChanges();
    expect(controlsDisabled(fixture)).toBe(false);
    expect(http.match('/api/c/company-1/context')).toEqual([]);

    fixture.componentInstance.save();
    fixture.detectChanges();
    expect(controlsDisabled(fixture)).toBe(true);
    http
      .expectOne('/api/c/company-1/company')
      .flush(
        { error: { message: 'version_conflict', code: 'conflict', correlationId: 'corr-2' } },
        { status: 409, statusText: 'Conflict' },
      );
    fixture.detectChanges();
    expect(controlsDisabled(fixture)).toBe(false);
    expect(fixture.componentInstance.legalName()).toBe('Pending Name');

    fixture.componentInstance.save();
    fixture.detectChanges();
    expect(controlsDisabled(fixture)).toBe(true);
    http.expectOne('/api/c/company-1/company').flush({
      company: companyPayload({ legalName: 'Pending Name', version: 2 }),
    });
    flushContextReload(http);
    fixture.detectChanges();
    expect(controlsDisabled(fixture)).toBe(false);
    http.verify();
  });
});

async function setup(
  permissions: string[],
  companyIds = new BehaviorSubject(convertToParamMap({ companyId: 'company-1' })),
): Promise<{
  fixture: ComponentFixture<CompanyPage>;
  http: HttpTestingController;
}> {
  await TestBed.configureTestingModule({
    imports: [CompanyPage],
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
  const fixture = TestBed.createComponent(CompanyPage);
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController) };
}

function flushCompany(http: HttpTestingController, company: Record<string, unknown> = {}): void {
  http.expectOne('/api/c/company-1/context').flush({ company: companyPayload(company) });
}

function flushContextReload(http: HttpTestingController, currency = 'EUR'): void {
  http.expectOne('/api/c/company-1/context').flush(storedContext(currency));
}

async function primeContext(http: HttpTestingController): Promise<void> {
  const pending = TestBed.inject(CompanyContextStore).load('company-1');
  http.expectOne('/api/c/company-1/context').flush(storedContext('EUR'));
  await pending;
}

function companyPayload(company: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'company-1',
    version: 1,
    legalName: 'Demo Company A Ltd (fictional)',
    tradingName: 'Nutbox (demo data)',
    registrationNumber: null,
    vatNumber: null,
    taxOffice: null,
    address: {
      line1: '1 Demo Street',
      city: 'Nicosia',
      countryCode: 'CY',
      note: 'fictional address',
    },
    timezone: 'Asia/Nicosia',
    defaultCurrency: 'EUR',
    defaultLocale: 'en',
    documentLanguage: 'en',
    paymentTermsDays: 30,
    countryCode: 'CY',
    status: 'active',
    ...company,
  };
}

function storedContext(currency: string): CompanyContext {
  return {
    company: {
      id: 'company-1',
      legalName: 'Demo Company A Ltd (fictional)',
      tradingName: 'Nutbox (demo data)',
      status: 'active',
      timezone: 'Asia/Nicosia',
      defaultCurrency: currency,
      countryCode: 'CY',
      documentLanguage: 'en',
    },
    grants: [
      { permission: 'company.view', scopeType: 'company', scopeId: null },
      { permission: 'company.manage', scopeType: 'company', scopeId: null },
    ],
    switches: [],
    mfaStepUpRequired: false,
    withheldPermissions: [],
  };
}

function grant(permission: string): Grant {
  return { permission, scopeType: 'company', scopeId: null };
}

function textOf(fixture: ComponentFixture<unknown>): string {
  return element(fixture).textContent;
}

function element(fixture: ComponentFixture<unknown>): HTMLElement {
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) {
    throw new Error('missing root');
  }
  return root;
}

function buttonLabels(fixture: ComponentFixture<unknown>): string[] {
  return [...element(fixture).querySelectorAll('button')].map((item) => item.textContent.trim());
}

function button(fixture: ComponentFixture<unknown>, name: string): HTMLButtonElement {
  const found = [...element(fixture).querySelectorAll('button')].find((item) =>
    item.textContent.includes(name),
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`missing button ${name}`);
  }
  return found;
}

function controlsDisabled(fixture: ComponentFixture<unknown>): boolean {
  const controls = [...element(fixture).querySelectorAll('input, select')];
  return (
    controls.length > 0 && controls.every((control) => 'disabled' in control && control.disabled)
  );
}

function labeledInput(fixture: ComponentFixture<unknown>, name: string): HTMLInputElement {
  const label = [...element(fixture).querySelectorAll('label')].find((item) =>
    item.textContent.includes(name),
  );
  const input = label?.querySelector('input');
  if (!(label instanceof HTMLLabelElement) || !(input instanceof HTMLInputElement)) {
    throw new Error(`missing input ${name}`);
  }
  return input;
}

function inputValue(fixture: ComponentFixture<unknown>, index: number): string {
  const input = element(fixture).querySelectorAll('input')[index];
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('missing input');
  }
  return input.value;
}
