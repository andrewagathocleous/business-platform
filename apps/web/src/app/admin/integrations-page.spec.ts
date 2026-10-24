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
import { IntegrationsPage } from './integrations-page';

const KEY = 'FictionalShopKey000000000000W9qZ';

describe('IntegrationsPage', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('hides writes for a viewer and does not load PrintNode', async () => {
    const { fixture, http } = await setup(['integration.view']);
    flushStores(http);
    fixture.detectChanges();
    fixture.componentInstance.chooseStore('store-1');
    flushConnection(http);
    fixture.detectChanges();
    const controls = [
      ...element(fixture).querySelectorAll(
        'form input, form select, [data-testid="maps"] input, [data-testid="maps"] select',
      ),
    ];
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((control) => 'disabled' in control && control.disabled)).toBe(true);
    expect(buttonLabels(fixture)).not.toContain('Save');
    expect(buttonLabels(fixture)).not.toContain('Start sync');
    expect(element(fixture).querySelector('[data-testid="printnode"]')).toBeNull();
    expect(element(fixture).querySelector('input[type="password"]')).toBeNull();
    expect(http.match((request) => request.url.includes('printnode'))).toEqual([]);
    http.verify();
  });

  it('keeps the key field empty and clears it after save', async () => {
    const { fixture, http } = await setup(['integration.view', 'integration.manage']);
    flushStores(http);
    fixture.detectChanges();
    fixture.componentInstance.chooseStore('store-1');
    flushConnection(http, { keySet: true, keySetAt: '2026-10-24T08:00:00.000Z' });
    fixture.detectChanges();
    expect(element(fixture).querySelector('[data-testid="prestashop-key"]')).toBeNull();
    expect(textOf(fixture)).toContain('Key set on');
    button(fixture, 'Replace key').click();
    fixture.detectChanges();
    const input = keyInput(fixture);
    expect(input.value).toBe('');
    input.value = KEY;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    fixture.componentInstance.save();
    const put = http.expectOne('/api/c/company-1/stores/store-1/prestashop-connection');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toMatchObject({ key: KEY });
    put.flush({
      connection: connectionPayload({ keySet: true, keySetAt: '2026-10-24T09:00:00.000Z' }),
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.key()).toBe('');
    expect(element(fixture).querySelector('[data-testid="prestashop-key"]')).toBeNull();
    expect(textOf(fixture)).not.toContain(KEY);
    http.verify();
  });

  it('clears a typed key when the store changes and does not send it', async () => {
    const { fixture, http } = await setup(['integration.view', 'integration.manage']);
    flushStores(http, [
      { id: 'store-1', name: 'Shop A', platform: 'prestashop', status: 'active' },
      { id: 'store-2', name: 'Shop B', platform: 'prestashop', status: 'active' },
    ]);
    fixture.detectChanges();
    fixture.componentInstance.chooseStore('store-1');
    flushConnection(http, { keySet: false, keySetAt: null });
    fixture.detectChanges();
    fixture.componentInstance.key.set(KEY);
    fixture.detectChanges();
    expect(keyInput(fixture).value).toBe(KEY);

    fixture.componentInstance.chooseStore('store-2');
    fixture.detectChanges();
    expect(fixture.componentInstance.key()).toBe('');
    expect(fixture.componentInstance.loaded()).toBe(false);
    fixture.componentInstance.save();
    expect(http.match((request) => request.method === 'PUT')).toEqual([]);

    http.expectOne('/api/c/company-1/stores/store-2/prestashop-connection').flush({
      connection: connectionPayload({
        settings: {
          baseUrl: 'https://other.example.test',
          timezone: 'Asia/Nicosia',
          firstImportFrom: '2026-01-01 00:00:00',
          pollIntervalSeconds: 180,
        },
      }),
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.key()).toBe('');
    fixture.componentInstance.save();
    const put = http.expectOne('/api/c/company-1/stores/store-2/prestashop-connection');
    expect(put.request.body).not.toHaveProperty('key');
    expect(JSON.stringify(put.request.body)).not.toContain(KEY);
    put.flush({ connection: connectionPayload() });
    http.verify();
  });

  it('disables start sync until the last test passed', async () => {
    const { fixture, http } = await setup(['integration.view', 'integration.manage']);
    flushStores(http);
    fixture.detectChanges();
    fixture.componentInstance.chooseStore('store-1');
    flushConnection(http, { lastTestResult: null, status: 'paused' });
    fixture.detectChanges();
    expect(button(fixture, 'Start sync').disabled).toBe(true);
    http.verify();
  });

  it('shows the auth_failed message', async () => {
    const { fixture, http } = await setup(['integration.view', 'integration.manage']);
    flushStores(http);
    fixture.detectChanges();
    fixture.componentInstance.chooseStore('store-1');
    flushConnection(http, { status: 'auth_failed', lastTestResult: 'auth_failed' });
    fixture.detectChanges();
    expect(textOf(fixture)).toContain(
      'The shop rejected the key. Replace it, test, then start sync again.',
    );
    http.verify();
  });

  it('locks the first import field', async () => {
    const { fixture, http } = await setup(['integration.view', 'integration.manage']);
    flushStores(http);
    fixture.detectChanges();
    fixture.componentInstance.chooseStore('store-1');
    flushConnection(http, { firstImportLocked: true });
    fixture.detectChanges();
    const input = element(fixture).querySelector('[data-testid="first-import"]');
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect((input as HTMLInputElement).disabled).toBe(true);
    expect(textOf(fixture)).toContain('The first import time is locked');
    http.verify();
  });

  it('shows PrintNode for operations and keeps PrestaShop read-only', async () => {
    const { fixture, http } = await setup(['integration.view', 'printer.manage']);
    flushStores(http);
    http.expectOne('/api/c/company-1/print-accounts/printnode').flush({
      keySet: true,
      keySetAt: '2026-10-24T08:00:00.000Z',
    });
    fixture.detectChanges();
    fixture.componentInstance.chooseStore('store-1');
    flushConnection(http);
    fixture.detectChanges();
    expect(element(fixture).querySelector('[data-testid="printnode"]')).not.toBeNull();
    expect(buttonLabels(fixture)).not.toContain('Start sync');
    expect(buttonLabels(fixture)).toContain('Test PrintNode');
    const printKey = element(fixture).querySelector('[data-testid="printnode-key"]');
    expect(printKey).toBeInstanceOf(HTMLInputElement);
    expect((printKey as HTMLInputElement).value).toBe('');
    http.verify();
  });

  it('finishes a PrintNode save when a store is chosen meanwhile', async () => {
    const { fixture, http } = await setup(['integration.view', 'printer.manage']);
    flushStores(http);
    http.expectOne('/api/c/company-1/print-accounts/printnode').flush({ keySet: false, keySetAt: null });
    fixture.detectChanges();
    fixture.componentInstance.printKey.set('FictionalPrintNodeKey000000K3mP');
    fixture.componentInstance.savePrint();
    const put = http.expectOne('/api/c/company-1/print-accounts/printnode');
    fixture.componentInstance.chooseStore('store-1');
    put.flush({ keySet: true, keySetAt: '2026-10-24T09:00:00.000Z' });
    flushConnection(http);
    fixture.detectChanges();
    expect(fixture.componentInstance.printKey()).toBe('');
    expect(fixture.componentInstance.printBusy()).toBe(false);
    expect(fixture.componentInstance.printKeySet()).toBe(true);
    http.verify();
  });

  it('loads PrintNode when a store is chosen before its first read returns', async () => {
    const { fixture, http } = await setup(['integration.view', 'printer.manage']);
    flushStores(http);
    const read = http.expectOne('/api/c/company-1/print-accounts/printnode');
    fixture.componentInstance.chooseStore('store-1');
    read.flush({ keySet: true, keySetAt: '2026-10-24T08:00:00.000Z' });
    flushConnection(http);
    fixture.detectChanges();
    expect(fixture.componentInstance.printLoaded()).toBe(true);
    expect(fixture.componentInstance.printKeySet()).toBe(true);
    http.verify();
  });

  it('shows a section message on 403 and does not navigate', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const { fixture, http } = await setup(['integration.view', 'printer.manage'], undefined, navigate);
    http.expectOne('/api/c/company-1/stores').flush(
      { error: { code: 'forbidden', message: 'Forbidden', correlationId: 'corr-1' } },
      { status: 403, statusText: 'Forbidden' },
    );
    http.expectOne('/api/c/company-1/print-accounts/printnode').flush(
      { error: { code: 'forbidden', message: 'Forbidden', correlationId: 'corr-2' } },
      { status: 403, statusText: 'Forbidden' },
    );
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('You do not have permission to see this.');
    expect(navigate).not.toHaveBeenCalled();
    http.verify();
  });
});

async function setup(
  permissions: string[],
  companyIds = new BehaviorSubject(convertToParamMap({ companyId: 'company-1' })),
  navigate: (url: string) => Promise<boolean> = vi.fn(() => Promise.resolve(true)),
): Promise<{ fixture: ComponentFixture<IntegrationsPage>; http: HttpTestingController }> {
  await TestBed.configureTestingModule({
    imports: [IntegrationsPage],
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
      { provide: Router, useValue: { navigate } },
    ],
  }).compileComponents();
  const transloco = TestBed.inject(TranslocoService);
  await firstValueFrom(transloco.load('en'));
  transloco.setActiveLang('en');
  TestBed.inject(CompanyContextStore).grants.set(permissions.map(grant));
  const fixture = TestBed.createComponent(IntegrationsPage);
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController) };
}

function flushStores(
  http: HttpTestingController,
  stores: { id: string; name: string; platform: string; status: string }[] = [
    { id: 'store-1', name: 'Demo shop', platform: 'prestashop', status: 'active' },
    { id: 'store-shopify', name: 'Other', platform: 'shopify', status: 'active' },
    { id: 'store-archived', name: 'Old', platform: 'prestashop', status: 'archived' },
  ],
): void {
  http.expectOne('/api/c/company-1/stores').flush({ stores });
}

function flushConnection(
  http: HttpTestingController,
  connection: Record<string, unknown> = {},
): void {
  http.expectOne('/api/c/company-1/stores/store-1/prestashop-connection').flush({
    connection: connectionPayload(connection),
  });
}

function connectionPayload(connection: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'connection-1',
    status: 'paused',
    settings: {
      baseUrl: 'https://shop.example.test',
      timezone: 'Asia/Nicosia',
      firstImportFrom: '2026-01-01 00:00:00',
      pollIntervalSeconds: 180,
    },
    stateMap: {},
    carrierMap: {},
    keySet: true,
    keySetAt: '2026-10-24T08:00:00.000Z',
    lastTestAt: null,
    lastTestResult: null,
    lastSyncAt: null,
    lastErrorClass: null,
    lastErrorAt: null,
    firstImportLocked: false,
    ...connection,
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

function keyInput(fixture: ComponentFixture<unknown>): HTMLInputElement {
  const input = element(fixture).querySelector('[data-testid="prestashop-key"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('missing key input');
  }
  return input;
}
