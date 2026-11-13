import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { InvoiceListPage } from './invoice-list';

describe('InvoiceListPage filters', () => {
  it('requests money owing, renders issued invoice balances and preserves the filter in navigation', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const { fixture, http } = await setup({ payment: 'open' }, navigate);
    const list = http.expectOne((request) => request.url === '/api/c/company-1/invoices');
    expect(list.request.params.get('payment')).toBe('open');
    http.expectOne('/api/c/company-1/clients').flush({ clients: [] });
    const row = { id: 'i', documentType: 'invoice', status: 'issued', clientDisplayName: 'Demo client', currency: 'EUR', issueDate: '2026-10-28', dueDate: null, total: '100.00', openBalance: '60.00', paymentState: 'partially_paid' };
    list.flush({ invoices: [row, { ...row, id: 'draft', status: 'draft' }, { ...row, id: 'cn', documentType: 'credit_note' }] });
    fixture.detectChanges();
    const value: unknown = fixture.nativeElement;
    if (!(value instanceof HTMLElement)) throw new Error('no root');
    expect(value.textContent).toContain('Payment');
    expect(value.textContent.match(/Partly paid/g)).toHaveLength(1);
    expect(value.textContent).toContain('60.00 EUR');
    const select = document.createElement('select'); select.append(new Option('open', 'open')); select.value = 'open';
    fixture.componentInstance.setPayment({ target: select } as unknown as Event);
    expect(navigate).toHaveBeenCalledWith([], expect.objectContaining({ queryParams: { payment: 'open' } }));
    http.verify();
  });

  it('does not clear every filter when the list request is rejected', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const { http } = await setup({ status: 'issued' }, navigate);
    const list = http.expectOne((request) => request.url === '/api/c/company-1/invoices');
    const clients = http.expectOne((request) => request.url === '/api/c/company-1/clients');
    list.flush({ message: 'bad' }, { status: 400, statusText: 'Bad Request' });
    clients.flush({ clients: [] });
    expect(navigate).not.toHaveBeenCalledWith([], expect.objectContaining({ queryParams: {} }));
    http.verify();
  });
});

async function setup(
  query: Record<string, string>,
  navigate: () => Promise<boolean>,
): Promise<{ http: HttpTestingController; fixture: ComponentFixture<InvoiceListPage> }> {
  const queryMap = convertToParamMap(query);
  await TestBed.configureTestingModule({
    imports: [InvoiceListPage],
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTransloco({
        config: { availableLangs: ['en', 'el'], defaultLang: 'en', reRenderOnLangChange: true, prodMode: true },
        loader: AppTranslocoLoader,
      }),
      provideRouter([]),
      {
        provide: ActivatedRoute,
        useValue: {
          parent: { paramMap: of(convertToParamMap({ companyId: 'company-1' })) },
          paramMap: of(convertToParamMap({})),
          queryParamMap: of(queryMap),
          snapshot: { paramMap: convertToParamMap({}), queryParamMap: queryMap },
        },
      },
    ],
  }).compileComponents();
  const transloco = TestBed.inject(TranslocoService);
  await firstValueFrom(transloco.load('en'));
  transloco.setActiveLang('en');
  vi.spyOn(TestBed.inject(Router), 'navigate').mockImplementation(navigate);
  const fixture: ComponentFixture<InvoiceListPage> = TestBed.createComponent(InvoiceListPage);
  fixture.detectChanges();
  return { http: TestBed.inject(HttpTestingController), fixture };
}
