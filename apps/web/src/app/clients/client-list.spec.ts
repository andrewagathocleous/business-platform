import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { ClientListPage } from './client-list';

describe('ClientListPage filters', () => {
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
