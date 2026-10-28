import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanyContextStore } from '../core/company-context.store';
import type { Grant } from '../core/models';
import { NAVIGATE_ON_DENIED } from '../core/navigate-on-denied';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { StoresPage } from './stores-page';

const BRAND = { id: 'brand-1', name: 'Nutbox (demo)', archivedAt: null };
const LOCATION = {
  id: 'loc-1',
  name: 'Demo Shop – Nicosia',
  address: { line1: '1 Demo Street', city: 'Nicosia', countryCode: 'CY' },
  timezone: 'Asia/Nicosia',
  archivedAt: null,
};
const STORE = {
  id: 'store-1',
  name: 'Nutbox Demo PrestaShop',
  platform: 'prestashop',
  brandId: 'brand-1',
  locationId: 'loc-1',
  brand: { id: 'brand-1', name: 'Nutbox (demo)' },
  location: { id: 'loc-1', name: 'Demo Shop – Nicosia' },
  domain: 'demo.example.test',
  invoiceAuthority: 'undecided',
  status: 'active',
  connections: [{ id: 'conn-1', mode: 'mock', status: 'active' }],
};

describe('StoresPage', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('hides brand, location and store actions without the manage permissions', async () => {
    const { fixture, http } = await setup(['store.view']);
    flushLists(http);
    fixture.detectChanges();
    expect(buttonLabels(fixture)).not.toContain('Add brand');
    expect(buttonLabels(fixture)).not.toContain('Add location');
    expect(buttonLabels(fixture)).not.toContain('Add store');
    expect(buttonLabels(fixture)).not.toContain('Archive');
    expect(buttonLabels(fixture)).not.toContain('Edit');
    http.verify();
  });

  it('shows brand and store actions only with store.manage', async () => {
    const { fixture, http } = await setup(['store.view', 'store.manage']);
    flushLists(http);
    fixture.detectChanges();
    const labels = buttonLabels(fixture);
    expect(labels).toContain('Add brand');
    expect(labels).toContain('Add store');
    expect(labels).not.toContain('Add location');
    http.verify();
  });

  it('shows location actions only with company.manage', async () => {
    const { fixture, http } = await setup(['store.view', 'company.manage']);
    flushLists(http);
    fixture.detectChanges();
    const labels = buttonLabels(fixture);
    expect(labels).toContain('Add location');
    expect(labels).not.toContain('Add brand');
    expect(labels).not.toContain('Add store');
    http.verify();
  });

  it('shows location_in_use when an archive is refused', async () => {
    const { fixture, http } = await setup(['store.view', 'company.manage']);
    flushLists(http);
    fixture.detectChanges();
    buttonIn(fixture, 'locations', 'Archive').click();
    const patch = http.expectOne('/api/c/company-1/locations/loc-1');
    expect(patch.request.body).toEqual({ archived: true });
    patch.flush(
      { error: { code: 'location_in_use', message: 'location_in_use' } },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();
    expect(textOf(fixture)).toContain(
      'This location still has an active store or a printer mapping.',
    );
    expect(textOf(section(fixture, 'locations'))).toContain('Demo Shop – Nicosia');
    http.verify();
  });

  it('keeps platform out of the edit form and the save body', async () => {
    const { fixture, http } = await setup(['store.view', 'store.manage']);
    flushLists(http);
    fixture.detectChanges();
    buttonIn(fixture, 'stores', 'Edit').click();
    fixture.detectChanges();
    const edit = section(fixture, 'stores').querySelector('[data-testid="store-edit"]');
    if (!(edit instanceof HTMLElement)) {
      throw new Error('missing store edit form');
    }
    expect(edit.querySelector('select[name="platform"], input[name="platform"]')).toBeNull();
    expect(edit.querySelector('[data-testid="store-platform"]')?.textContent).toContain(
      'PrestaShop',
    );
    fixture.componentInstance.editName.set('Renamed shop');
    fixture.componentInstance.saveStore();
    const patch = http.expectOne('/api/c/company-1/stores/store-1');
    expect(patch.request.body).toEqual({ name: 'Renamed shop' });
    expect(patch.request.body).not.toHaveProperty('platform');
    http.verify();
  });

  it('explains each invoice authority in the create and edit forms', async () => {
    const { fixture, http } = await setup(['store.view', 'store.manage']);
    flushLists(http);
    fixture.detectChanges();
    buttonIn(fixture, 'stores', 'Edit').click();
    const explanations = [
      [
        'undecided',
        "Undecided: not chosen yet. The platform does not invoice this store's orders.",
      ],
      [
        'store',
        "Store: the shop keeps issuing its own invoices or receipts. The platform does not invoice this store's orders.",
      ],
      [
        'platform',
        "Platform: the platform will issue invoices for this store's orders once order-to-invoice conversion is available. This choice cannot be undone once one is issued.",
      ],
    ] as const;
    for (const [value, explanation] of explanations) {
      fixture.componentInstance.storeAuthority.set(value);
      fixture.componentInstance.editAuthority.set(value);
      fixture.detectChanges();
      const help = [...section(fixture, 'stores').querySelectorAll('small')].map((item) =>
        item.textContent.trim(),
      );
      expect(help.filter((item) => item === explanation)).toHaveLength(2);
    }
    http.verify();
  });

  it('explains an authority_locked refusal and keeps the store unchanged', async () => {
    const { fixture, http } = await setup(['store.view', 'store.manage']);
    http.expectOne('/api/c/company-1/brands').flush({ brands: [BRAND] });
    http.expectOne('/api/c/company-1/locations').flush({ locations: [LOCATION] });
    http.expectOne('/api/c/company-1/stores').flush({
      stores: [{ ...STORE, invoiceAuthority: 'platform' }],
    });
    fixture.detectChanges();
    buttonIn(fixture, 'stores', 'Edit').click();
    fixture.componentInstance.editAuthority.set('store');
    fixture.componentInstance.saveStore();
    const patch = http.expectOne('/api/c/company-1/stores/store-1');
    expect(patch.request.body).toEqual({ invoiceAuthority: 'store' });
    patch.flush(
      { error: { code: 'authority_locked', message: 'authority_locked' } },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();
    expect(textOf(fixture)).toContain(
      "The platform has already issued an invoice for this store's orders. Invoice authority cannot be changed.",
    );
    expect(fixture.componentInstance.stores()[0]?.invoiceAuthority).toBe('platform');
    expect(fixture.componentInstance.busy()).toBe(false);
    expect(section(fixture, 'stores').querySelector('[data-testid="store-edit"]')).not.toBeNull();
    http.verify();
  });

  it('shows a store-scoped member their store and no brands section', async () => {
    const { fixture, http } = await setup([
      'company.view',
      'catalog.view',
      { permission: 'store.view', scopeType: 'store', scopeId: 'store-1' },
    ]);
    expect(http.match('/api/c/company-1/brands')).toEqual([]);
    http.expectOne('/api/c/company-1/locations').flush({ locations: [LOCATION] });
    http.expectOne('/api/c/company-1/stores').flush({ stores: [STORE] });
    fixture.detectChanges();
    expect(element(fixture).querySelector('[data-testid="brands"]')).toBeNull();
    const stores = textOf(section(fixture, 'stores'));
    expect(stores).toContain('Nutbox Demo PrestaShop');
    expect(stores).toContain('Nutbox (demo)');
    expect(stores).toContain('Demo Shop – Nicosia');
    http.verify();
  });

  it('keeps the other sections when one read is forbidden', async () => {
    const { fixture, http } = await setup(['store.view', 'company.view']);
    const brands = http.expectOne('/api/c/company-1/brands');
    const locations = http.expectOne('/api/c/company-1/locations');
    const stores = http.expectOne('/api/c/company-1/stores');
    expect(brands.request.context.get(NAVIGATE_ON_DENIED)).toBe(false);
    expect(locations.request.context.get(NAVIGATE_ON_DENIED)).toBe(false);
    expect(stores.request.context.get(NAVIGATE_ON_DENIED)).toBe(false);
    brands.flush(
      { error: { message: 'forbidden', code: 'forbidden' } },
      { status: 403, statusText: 'Forbidden' },
    );
    locations.flush({ locations: [LOCATION] });
    stores.flush({ stores: [STORE] });
    fixture.detectChanges();
    expect(textOf(section(fixture, 'brands'))).toContain('You do not have access to this section.');
    expect(textOf(section(fixture, 'stores'))).toContain('Nutbox Demo PrestaShop');
    expect(textOf(section(fixture, 'locations'))).toContain('Demo Shop – Nicosia');
    http.verify();
  });

  it('shows a renamed brand on the stores table', async () => {
    const { fixture, http } = await setup(['store.view', 'store.manage']);
    flushLists(http);
    fixture.detectChanges();
    expect(textOf(section(fixture, 'stores'))).toContain('Nutbox (demo)');
    buttonIn(fixture, 'brands', 'Rename').click();
    fixture.detectChanges();
    fixture.componentInstance.editingBrandName.set('New Brand');
    fixture.componentInstance.saveBrandName();
    const patch = http.expectOne('/api/c/company-1/brands/brand-1');
    expect(patch.request.body).toEqual({ name: 'New Brand' });
    patch.flush({ brand: { ...BRAND, name: 'New Brand' } });
    const brands = http.expectOne('/api/c/company-1/brands');
    const stores = http.expectOne('/api/c/company-1/stores');
    // Busy until the refresh lands, so a later edit cannot be overwritten by it.
    expect(fixture.componentInstance.busy()).toBe(true);
    brands.flush({ brands: [{ ...BRAND, name: 'New Brand' }] });
    stores.flush({
      stores: [{ ...STORE, brand: { id: 'brand-1', name: 'New Brand' } }],
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.busy()).toBe(false);
    const listed = textOf(section(fixture, 'stores'));
    expect(listed).toContain('New Brand');
    expect(listed).not.toContain('Nutbox (demo)');
    http.verify();
  });

  it('shows a renamed location on the stores table', async () => {
    const { fixture, http } = await setup(['store.view', 'company.manage']);
    flushLists(http);
    fixture.detectChanges();
    expect(textOf(section(fixture, 'stores'))).toContain('Demo Shop – Nicosia');
    buttonIn(fixture, 'locations', 'Edit').click();
    fixture.detectChanges();
    fixture.componentInstance.locationName.set('New Shop');
    fixture.componentInstance.submitLocation();
    const patch = http.expectOne('/api/c/company-1/locations/loc-1');
    expect(patch.request.body).toEqual({ name: 'New Shop' });
    patch.flush({
      location: { ...LOCATION, name: 'New Shop' },
    });
    const locations = http.expectOne('/api/c/company-1/locations');
    const stores = http.expectOne('/api/c/company-1/stores');
    locations.flush({ locations: [{ ...LOCATION, name: 'New Shop' }] });
    stores.flush({
      stores: [{ ...STORE, location: { id: 'loc-1', name: 'New Shop' } }],
    });
    fixture.detectChanges();
    const listed = textOf(section(fixture, 'stores'));
    expect(listed).toContain('New Shop');
    expect(listed).not.toContain('Demo Shop – Nicosia');
    http.verify();
  });
});

async function setup(permissions: readonly (string | Grant)[]): Promise<{
  fixture: ComponentFixture<StoresPage>;
  http: HttpTestingController;
}> {
  await TestBed.configureTestingModule({
    imports: [StoresPage],
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
          parent: { paramMap: of(convertToParamMap({ companyId: 'company-1' })) },
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
  TestBed.inject(CompanyContextStore).grants.set(permissions.map(asGrant));
  const fixture = TestBed.createComponent(StoresPage);
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController) };
}

function flushLists(http: HttpTestingController): void {
  http.expectOne('/api/c/company-1/brands').flush({ brands: [BRAND] });
  http.expectOne('/api/c/company-1/locations').flush({ locations: [LOCATION] });
  http.expectOne('/api/c/company-1/stores').flush({ stores: [STORE] });
}

function grant(permission: string): Grant {
  return { permission, scopeType: 'company', scopeId: null };
}

function asGrant(permission: string | Grant): Grant {
  return typeof permission === 'string' ? grant(permission) : permission;
}

function textOf(node: HTMLElement | ComponentFixture<unknown>): string {
  return (node instanceof HTMLElement ? node : element(node)).textContent;
}

function element(fixture: ComponentFixture<unknown>): HTMLElement {
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) {
    throw new Error('missing root');
  }
  return root;
}

function section(fixture: ComponentFixture<unknown>, testId: string): HTMLElement {
  const found = element(fixture).querySelector(`[data-testid="${testId}"]`);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`missing ${testId}`);
  }
  return found;
}

function buttonLabels(fixture: ComponentFixture<unknown>): string[] {
  return [...element(fixture).querySelectorAll('button')].map((item) => item.textContent.trim());
}

function buttonIn(
  fixture: ComponentFixture<unknown>,
  testId: string,
  name: string,
): HTMLButtonElement {
  const found = [...section(fixture, testId).querySelectorAll('button')].find((item) =>
    item.textContent.includes(name),
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`missing button ${name}`);
  }
  return found;
}
