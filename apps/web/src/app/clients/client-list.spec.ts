import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { CompanyContextStore } from '../core/company-context.store';
import { ClientCsvPanel } from './client-csv-panel';
import { ClientListPage } from './client-list';

describe('ClientListPage filters', () => {
  it('restores the URL preview, keeps it while filtering, and refreshes the list after confirm', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const queryMap = convertToParamMap({ q: 'Demo', importId: id });
    const navigate = vi.fn(() => Promise.resolve(true));
    await TestBed.configureTestingModule({
      imports: [ClientListPage],
      providers: [
        provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting(),
        provideTransloco({
          config: { availableLangs: ['en', 'el'], defaultLang: 'en', prodMode: true },
          loader: AppTranslocoLoader,
        }),
        { provide: ActivatedRoute, useValue: {
          parent: { paramMap: of(convertToParamMap({ companyId: 'company-1' })) },
          queryParamMap: of(queryMap),
        } },
        { provide: Router, useValue: { navigate } },
      ],
    }).compileComponents();
    const transloco = TestBed.inject(TranslocoService);
    await firstValueFrom(transloco.load('en'));
    transloco.setActiveLang('en');
    TestBed.inject(CompanyContextStore).grants.set([{ permission: 'client.import', scopeType: 'company', scopeId: null }]);
    const fixture = TestBed.createComponent(ClientListPage);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne((request) => request.url.endsWith('/clients')).flush({ clients: [] });
    http.expectOne(`/api/c/company-1/clients/imports/${id}`).flush({ import: {
      id, status: 'previewed', fileName: 'demo.csv', sha256: 'a'.repeat(64),
      counts: { new: 1, duplicate: 0, error: 0 }, rows: [], rowCount: 1,
      createdAt: new Date().toISOString(), appliedAt: null, appliedCount: null,
    } });
    expect(navigate).not.toHaveBeenCalled();
    const checkbox = fixture.debugElement.query(By.css('input[type=checkbox]')).nativeElement as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(navigate).toHaveBeenLastCalledWith([], expect.objectContaining({ queryParams: { q: 'Demo', includeArchived: 'true', importId: id } }));
    fixture.debugElement.query(By.directive(ClientCsvPanel)).injector.get(ClientCsvPanel).confirm();
    http.expectOne(`/api/c/company-1/clients/imports/${id}/confirm`).flush({ appliedCount: 1, counts: { new: 1, duplicate: 0, error: 0 } });
    expect(navigate).toHaveBeenLastCalledWith([], expect.objectContaining({ queryParams: { q: 'Demo' } }));
    const refresh = http.expectOne((request) => request.url.endsWith('/clients'));
    expect(refresh.request.params.get('q')).toBe('Demo');
    fixture.destroy();
    expect(refresh.cancelled).toBe(true);
    http.verify();
  });

  it('does not clear every filter when the list request is rejected', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const queryMap = convertToParamMap({ includeArchived: 'true' });
    await TestBed.configureTestingModule({
      imports: [ClientListPage],
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
            parent: { paramMap: of(convertToParamMap({ companyId: 'company-1' })) },
            paramMap: of(convertToParamMap({})),
            queryParamMap: of(queryMap),
            snapshot: { paramMap: convertToParamMap({}), queryParamMap: queryMap },
          },
        },
        { provide: Router, useValue: { navigate } },
      ],
    }).compileComponents();
    const transloco = TestBed.inject(TranslocoService);
    await firstValueFrom(transloco.load('en'));
    transloco.setActiveLang('en');
    const fixture = TestBed.createComponent(ClientListPage);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    const list = http.expectOne((request) => request.url === '/api/c/company-1/clients');
    expect(list.request.params.get('includeArchived')).toBe('true');
    list.flush({ message: 'bad' }, { status: 400, statusText: 'Bad Request' });
    expect(navigate).not.toHaveBeenCalledWith([], expect.objectContaining({ queryParams: {} }));
    http.verify();
  });
});
