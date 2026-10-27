import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanyContextStore } from '../core/company-context.store';
import type { Grant } from '../core/models';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { HEALTH_REFRESH_MS, IntegrationHealthPanel, type HealthView } from './integration-health';

const NOW = '2026-10-24T12:00:00.000Z';
const HEALTH_URL = '/api/c/company-1/integrations/health';

describe('IntegrationHealthPanel', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('shows a plain sentence for each level', async () => {
    const { fixture, http } = await setup(['integration.view']);
    http.expectOne(HEALTH_URL).flush(view());
    fixture.detectChanges();
    const sentences = [...element(fixture).querySelectorAll('[data-testid="health-sentence"]')].map((node) =>
      node.textContent.trim(),
    );
    expect(sentences).toEqual([
      'Orders are arriving',
      'No sync yet',
      'Last sync 10 minutes ago',
      'Orders have stopped arriving: last sync 20 minutes ago',
      'The shop rejected the key',
      'Sync is paused',
      'The last check failed: timeout',
    ]);
    expect(element(fixture).textContent).toContain('Not connected');
    http.verify();
  });

  it('links counts only with the permissions their pages need', async () => {
    const plain = await setup(['integration.view']);
    plain.http.expectOne(HEALTH_URL).flush(view());
    plain.fixture.detectChanges();
    expect(element(plain.fixture).querySelector('a[data-testid="health-review"]')).toBeNull();
    expect(element(plain.fixture).querySelector('a[data-testid="health-imports"]')).toBeNull();
    expect(element(plain.fixture).querySelector('a[data-testid="health-failed-prints"]')).toBeNull();
    expect(element(plain.fixture).querySelector('[data-testid="health-printers-link"]')).toBeNull();
    expect(element(plain.fixture).textContent).toContain('2 orders need review');
    expect(element(plain.fixture).textContent).toContain('3 imports failed, 1 imports waiting');
    TestBed.resetTestingModule();

    const full = await setup(['integration.view', 'order.view', 'automation.view', 'printer.manage']);
    full.http.expectOne(HEALTH_URL).flush(view());
    full.fixture.detectChanges();
    const review = element(full.fixture).querySelector('a[data-testid="health-review"]');
    expect(review?.getAttribute('href')).toBe('/c/company-1/orders?fulfilmentStatus=review_required&storeId=store-ok');
    expect(element(full.fixture).querySelector('a[data-testid="health-imports"]')?.getAttribute('href')).toBe(
      '/c/company-1/admin/automation?jobStatus=failed',
    );
    expect(element(full.fixture).querySelector('a[data-testid="health-failed-prints"]')?.getAttribute('href')).toBe(
      '/c/company-1/admin/automation?printStatus=failed',
    );
    expect(element(full.fixture).querySelector('[data-testid="health-printers-link"]')).not.toBeNull();
  });

  it('labels mock printers as simulated and shows mappings', async () => {
    const { fixture, http } = await setup(['integration.view']);
    http.expectOne(HEALTH_URL).flush(view());
    fixture.detectChanges();
    const printers = element(fixture).querySelector('[data-testid="health-printers"]')?.textContent ?? '';
    expect(printers).toContain('Demo label printer');
    expect(printers).toContain('Simulated');
    expect(printers).toContain('Zebra demo');
    const mappings = element(fixture).querySelector('[data-testid="health-mappings"]')?.textContent ?? '';
    expect(mappings).toContain('Gift cards: Zebra demo (100x150, Online)');
    expect(mappings).toContain('Packing slips: Not mapped');
    expect(element(fixture).querySelector('[data-testid="health-printnode"]')?.textContent).toContain(
      'PrintNode key set',
    );
  });

  it('refreshes every minute only while the page is visible', async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const { fixture, http } = await setup(['integration.view']);
    http.expectOne(HEALTH_URL).flush(view());
    fixture.detectChanges();
    vi.advanceTimersByTime(HEALTH_REFRESH_MS);
    expect(http.match(HEALTH_URL)).toEqual([]);
    visibility.mockReturnValue('visible');
    vi.advanceTimersByTime(HEALTH_REFRESH_MS);
    http.expectOne(HEALTH_URL).flush(view());
    http.verify();
  });

  it('drops an answer for a company that is no longer shown', async () => {
    const { fixture, http } = await setup(['integration.view']);
    const first = http.expectOne(HEALTH_URL);
    fixture.componentRef.setInput('companyId', 'company-2');
    fixture.detectChanges();
    const second = http.expectOne('/api/c/company-2/integrations/health');
    first.flush(view());
    fixture.detectChanges();
    expect(fixture.componentInstance.health()).toBeNull();
    second.flush({ ...view(), prestashop: [] });
    fixture.detectChanges();
    expect(fixture.componentInstance.health()?.prestashop).toEqual([]);
    http.verify();
  });
});

function view(): HealthView {
  const minutesAgo = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
  const connection = (
    level: 'ok' | 'warning' | 'error' | 'paused',
    reason: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id: `connection-${reason}`,
    status: level === 'paused' ? 'paused' : reason === 'auth_failed' ? 'auth_failed' : 'active',
    keySet: true,
    lastSyncAt: minutesAgo(1),
    lastErrorClass: null,
    lastErrorAt: null,
    pollIntervalSeconds: 180,
    health: { level, reason },
    failedImports: 0,
    waitingImports: 0,
    reviewRequired: 0,
    ...extra,
  });
  return {
    now: NOW,
    prestashop: [
      {
        storeId: 'store-ok',
        storeName: 'Shop ok',
        connection: connection('ok', 'ok', { reviewRequired: 2, failedImports: 3, waitingImports: 1 }),
      },
      { storeId: 'store-new', storeName: 'Shop new', connection: connection('warning', 'no_sync_yet', { lastSyncAt: null }) },
      { storeId: 'store-late', storeName: 'Shop late', connection: connection('warning', 'sync_late', { lastSyncAt: minutesAgo(10) }) },
      { storeId: 'store-stale', storeName: 'Shop stale', connection: connection('error', 'sync_stale', { lastSyncAt: minutesAgo(20) }) },
      { storeId: 'store-auth', storeName: 'Shop auth', connection: connection('error', 'auth_failed') },
      { storeId: 'store-paused', storeName: 'Shop paused', connection: connection('paused', 'paused') },
      {
        storeId: 'store-failed',
        storeName: 'Shop failed',
        connection: connection('warning', 'last_run_failed', { lastErrorClass: 'timeout', lastErrorAt: minutesAgo(0) }),
      },
      { storeId: 'store-none', storeName: 'Shop none', connection: null },
    ],
    printing: {
      printNodeKeySet: true,
      printNodeKeySetAt: minutesAgo(60),
      printers: [
        {
          id: 'printer-mock',
          name: 'Demo label printer',
          provider: 'mock',
          status: 'online',
          lastSeenAt: null,
          locationName: 'Demo Shop',
        },
        {
          id: 'printer-zebra',
          name: 'Zebra demo',
          provider: 'printnode',
          status: 'online',
          lastSeenAt: minutesAgo(5),
          locationName: 'Demo Shop',
        },
      ],
      lastDiscoveryAt: minutesAgo(5),
      mappings: [
        {
          locationId: 'location-1',
          locationName: 'Demo Shop',
          giftMessage: { printerName: 'Zebra demo', paper: '100x150', printerStatus: 'online' },
          packingSlip: null,
        },
      ],
      failedLast24h: 2,
    },
  };
}

async function setup(
  permissions: string[],
): Promise<{ fixture: ComponentFixture<IntegrationHealthPanel>; http: HttpTestingController }> {
  await TestBed.configureTestingModule({
    imports: [IntegrationHealthPanel],
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
  const fixture = TestBed.createComponent(IntegrationHealthPanel);
  fixture.componentRef.setInput('companyId', 'company-1');
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController) };
}

function grant(permission: string): Grant {
  return { permission, scopeType: 'company', scopeId: null };
}

function element(fixture: ComponentFixture<unknown>): HTMLElement {
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) {
    throw new Error('missing root');
  }
  return root;
}
