import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../app.routes';
import { CompanyContextStore } from '../core/company-context.store';
import { permissionGuard } from '../core/guards';
import { visibleNav } from '../core/nav';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { ReportsPage } from './reports-page';
import type { AgeingReport, CollectedReport, InvoicedReport } from './report-view';

const period = { from: '2026-10-01', to: '2026-10-29' };
const basis = 'by issue date; credit notes subtracted';
const tax = { basis, net: '100.00', tax: '19.00', gross: '119.00' };
const invoiced: InvoicedReport = {
  ...period,
  currencies: [
    {
      currency: 'EUR',
      invoiced: { ...tax, count: 2 },
      credited: { ...tax, count: 1 },
      totals: tax,
      taxCodes: [
        {
          taxCodeId: 'tax-a',
          code: 'STD19',
          name: 'ΦΠΑ  Ελληνικά',
          invoiced: tax,
          credited: tax,
          totals: tax,
        },
      ],
    },
    {
      currency: 'USD',
      invoiced: { ...tax, count: 1 },
      credited: { ...tax, count: 0 },
      totals: { ...tax, gross: '99999999999999999.99' },
      taxCodes: [],
    },
  ],
};
const collectionBasis = 'by payment and refund date; voided payments and refunds are excluded';
const collection = {
  payments: { basis: collectionBasis, amount: '40.00', count: 1 },
  refunds: { basis: collectionBasis, amount: '10.00', count: 1 },
  total: { basis: collectionBasis, amount: '30.00' },
};
const collected: CollectedReport = {
  ...period,
  currencies: [{ currency: 'EUR', ...collection, methods: [{ method: 'cash', ...collection }] }],
};
const ageingBasis =
  'as of 2026-10-29, by due date; allocations and refunds counted by their effective dates';
const figure = (amount: string) => ({ amount, basis: ageingBasis });
const ageingTotals = {
  buckets: {
    current: figure('1.00'),
    days1To30: figure('2.00'),
    days31To60: figure('3.00'),
    days61To90: figure('4.00'),
    over90: figure('5.00'),
  },
  openTotal: figure('15.00'),
  creditTotal: figure('20.00'),
};
const ageing: AgeingReport = {
  asOf: period.to,
  currencies: [
    {
      currency: 'EUR',
      ...ageingTotals,
      clients: [
        {
          clientId: 'client-a',
          clientName: 'Πελάτης  Α',
          ...ageingTotals,
          credits: [],
          invoices: [
            {
              id: 'invoice-a',
              number: 'INV/1',
              issueDate: '2026-10-01',
              dueDate: '2026-10-28',
              bucket: 'days1To30',
              openBalance: figure('2.00'),
            },
          ],
        },
      ],
    },
  ],
};

afterEach(() => {
  vi.useRealTimers();
});

describe('ReportsPage', () => {
  it('requests the current company month and renders exact money, currencies, Greek and basis texts', async () => {
    const { fixture, component, http } = await setup();
    const request = http.expectOne((req) => req.url.endsWith('/reports/invoiced'));
    expect(request.request.method).toBe('GET');
    expect(request.request.params.keys().sort()).toEqual(['from', 'to']);
    expect(request.request.params.get('from')).toBe('2026-10-01');
    expect(request.request.params.get('to')).toBe('2026-10-29');
    request.flush(invoiced);
    fixture.detectChanges();
    expect(component.invoiced()).toEqual(invoiced);
    expect(text(fixture)).toContain('99999999999999999.99');
    expect(text(fixture)).toContain('ΦΠΑ Ελληνικά');
    expect(text(fixture)).toContain('EUR');
    expect(text(fixture)).toContain('USD');
    expect(text(fixture)).toContain(basis);
    expect(root(fixture).querySelectorAll('[data-testid=tax-code-totals] tbody tr')).toHaveLength(
      3,
    );
    http.verify();
  });

  it('sends edited dates for collected and shows method figures and their basis', async () => {
    const { fixture, component, http } = await setup();
    http
      .expectOne((req) => req.url.endsWith('/reports/invoiced'))
      .flush({ ...period, currencies: [] });
    component.open('collected');
    http.expectOne((req) => req.url.endsWith('/reports/collected')).flush(collected);
    component.from.set('2026-09-01');
    component.to.set('2026-09-30');
    component.load();
    const request = http.expectOne((req) => req.url.endsWith('/reports/collected'));
    expect(request.request.params.get('from')).toBe('2026-09-01');
    expect(request.request.params.get('to')).toBe('2026-09-30');
    request.flush(collected);
    fixture.detectChanges();
    expect(text(fixture)).toContain('Cash');
    expect(text(fixture)).toContain('40.00');
    expect(text(fixture)).toContain('10.00');
    expect(text(fixture)).toContain('30.00');
    expect(text(fixture)).toContain(collectionBasis);
    http.verify();
  });

  it('requests asOf and shows all five buckets, separate credit, grand totals and object links', async () => {
    const { fixture, component, http } = await setup();
    http
      .expectOne((req) => req.url.endsWith('/reports/invoiced'))
      .flush({ ...period, currencies: [] });
    component.open('ageing');
    const request = http.expectOne((req) => req.url.endsWith('/reports/ageing'));
    expect(request.request.params.keys()).toEqual(['asOf']);
    expect(request.request.params.get('asOf')).toBe('2026-10-29');
    request.flush(ageing);
    fixture.detectChanges();
    const table = root(fixture).querySelector('[data-testid=ageing-totals]');
    for (const value of [
      '1.00',
      '2.00',
      '3.00',
      '4.00',
      '5.00',
      '15.00',
      '20.00',
      'Client credit (separate)',
      ageingBasis,
    ])
      expect(table?.textContent).toContain(value);
    expect(table?.querySelector('tfoot')?.textContent).toContain('15.00');
    expect(table?.querySelector('tfoot')?.textContent).toContain('20.00');
    expect(
      root(fixture).querySelector('a[href="/c/company-1/clients/client-a"]')?.textContent,
    ).toBe('Πελάτης  Α');
    expect(
      root(fixture).querySelector('a[href="/c/company-1/invoices/invoice-a"]')?.textContent,
    ).toBe('INV/1');
    http.verify();
  });

  it.each([
    ['2026-10-30', '2026-10-01', 'From must be on or before To'],
    ['2025-10-01', '2026-10-29', 'at most 366 days'],
    ['2026-02-30', '2026-10-29', 'Enter valid dates'],
  ])('refuses %s to %s before sending', async (from, to, message) => {
    const { fixture, component, http } = await setup();
    http.expectOne((req) => req.url.endsWith('/reports/invoiced')).flush(invoiced);
    component.from.set(from);
    component.to.set(to);
    component.load();
    fixture.detectChanges();
    expect(text(fixture)).toContain(message);
    expect(component.invoiced()).toBeNull();
    http.verify();
  });

  it('refuses future asOf locally and explains API invalid_date with its correlation', async () => {
    const { fixture, component, http } = await setup();
    http.expectOne((req) => req.url.endsWith('/reports/invoiced')).flush(invoiced);
    component.open('ageing');
    http
      .expectOne((req) => req.url.endsWith('/reports/ageing'))
      .flush(
        { error: { code: 'invalid_date', correlationId: 'corr-date' } },
        { status: 422, statusText: 'Invalid' },
      );
    fixture.detectChanges();
    expect(text(fixture)).toContain('no later than today');
    expect(text(fixture)).toContain('corr-date');
    component.asOf.set('2026-10-30');
    component.load();
    fixture.detectChanges();
    expect(text(fixture)).toContain('must not be after today');
    http.verify();
  });

  it('ignores an older answer and older failure, even after local date validation', async () => {
    const { component, http } = await setup();
    const old = http.expectOne((req) => req.url.endsWith('/reports/invoiced'));
    component.load();
    const newer = http.expectOne((req) => req.url.endsWith('/reports/invoiced'));
    newer.flush(invoiced);
    old.flush({ ...period, currencies: [] });
    expect(component.invoiced()).toEqual(invoiced);
    component.load();
    const pending = http.expectOne((req) => req.url.endsWith('/reports/invoiced'));
    component.from.set('');
    component.load();
    pending.flush({}, { status: 500, statusText: 'Failed' });
    expect(component.failure()?.key).toBe('reports.errors.date');
    expect(component.loading()).toBe(false);
    http.verify();
  });

  it('invalidates replies across view and company changes and cancels on close', async () => {
    const { component, fixture, company, http } = await setup();
    const old = http.expectOne((req) => req.url.endsWith('/reports/invoiced'));
    component.open('collected');
    const previousCompany = http.expectOne((req) => req.url.endsWith('/reports/collected'));
    company.next(convertToParamMap({ companyId: 'company-2' }));
    const current = http.expectOne((req) => req.url === '/api/c/company-2/reports/collected');
    old.flush(invoiced);
    previousCompany.flush(collected);
    expect(component.invoiced()).toBeNull();
    expect(component.collected()).toBeNull();
    fixture.destroy();
    expect(current.cancelled).toBe(true);
    http.verify();
  });

  it('recomputes today and the month when a view opens across company midnight', async () => {
    const { component, http } = await setup('2026-10-31T21:59:00Z');
    http.expectOne((req) => req.url.endsWith('/reports/invoiced')).flush(invoiced);
    vi.setSystemTime(new Date('2026-10-31T22:01:00Z'));
    component.open('collected');
    const collectedRequest = http.expectOne((req) => req.url.endsWith('/reports/collected'));
    expect(collectedRequest.request.params.get('from')).toBe('2026-11-01');
    expect(collectedRequest.request.params.get('to')).toBe('2026-11-01');
    collectedRequest.flush({ from: '2026-11-01', to: '2026-11-01', currencies: [] });
    component.open('ageing');
    const request = http.expectOne((req) => req.url.endsWith('/reports/ageing'));
    expect(request.request.params.get('asOf')).toBe('2026-11-01');
    request.flush({ asOf: '2026-11-01', currencies: [] });
    http.verify();
  });

  it('adds Reports to the main navigation only with report.finance.view and guards its route', () => {
    expect(
      visibleNav([{ permission: 'invoice.view' }]).some((item) => item.path === 'reports'),
    ).toBe(false);
    expect(visibleNav([{ permission: 'report.finance.view' }])).toContainEqual({
      path: 'reports',
      permission: 'report.finance.view',
      labelKey: 'nav.reports',
      admin: false,
    });
    const route = routes
      .find((item) => item.path === 'c/:companyId')
      ?.children?.find((item) => item.path === 'reports');
    expect(route?.canActivate).toContain(permissionGuard);
    expect(route?.data).toEqual({ permission: 'report.finance.view' });
  });
});

async function setup(now = '2026-10-29T10:00:00Z') {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  const company = new BehaviorSubject(convertToParamMap({ companyId: 'company-1' }));
  await TestBed.configureTestingModule({
    imports: [ReportsPage],
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { parent: { paramMap: company } } },
      provideTransloco({
        config: { availableLangs: ['en', 'el'], defaultLang: 'en', prodMode: true },
        loader: AppTranslocoLoader,
      }),
    ],
  }).compileComponents();
  const transloco = TestBed.inject(TranslocoService);
  await firstValueFrom(transloco.load('en'));
  transloco.setActiveLang('en');
  TestBed.inject(CompanyContextStore).timezone.set('Asia/Nicosia');
  const fixture = TestBed.createComponent(ReportsPage);
  fixture.detectChanges();
  return {
    fixture,
    component: fixture.componentInstance,
    company,
    http: TestBed.inject(HttpTestingController),
  };
}
function root(fixture: ComponentFixture<unknown>): HTMLElement {
  const value: unknown = fixture.nativeElement;
  if (!(value instanceof HTMLElement)) throw new Error('no root');
  return value;
}
function text(fixture: ComponentFixture<unknown>): string {
  return root(fixture).textContent.replace(/\s+/g, ' ');
}
