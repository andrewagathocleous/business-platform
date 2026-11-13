import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { Observable, catchError, forkJoin, of, throwError } from 'rxjs';
import { readApiError } from '../core/api-error';
import { CompanyContextStore } from '../core/company-context.store';
import { fieldValue } from '../orders/field-value';

type BrandRow = { id: string; name: string; archivedAt: string | null };
type LocationRow = {
  id: string;
  name: string;
  address: unknown;
  timezone: string | null;
  archivedAt: string | null;
};
type NamedRef = { id: string; name: string };
type StoreRow = {
  id: string;
  name: string;
  platform: string;
  brandId: string;
  locationId: string;
  brand: NamedRef;
  location: NamedRef;
  domain: string | null;
  invoiceAuthority: string;
  status: string;
  connections: { id: string; mode: string; status: string }[];
};
type AddressFields = {
  line1: string;
  line2: string;
  city: string;
  postcode: string;
  countryCode: string;
};
type Authority = 'undecided' | 'store' | 'platform';
type Platform = 'prestashop' | 'shopify' | 'manual';

@Component({
  selector: 'bp-stores-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, Button],
  template: `
    <section class="screen">
      <h1>{{ 'storesAdmin.title' | transloco }}</h1>
      @if (loading()) {
        <p role="status">{{ 'storesAdmin.loading' | transloco }}</p>
      }
      @if (loadError()) {
        <p role="alert">{{ 'storesAdmin.error' | transloco }}</p>
      }
      @if (loaded()) {
        @if (companyWideStoreView()) {
          <section data-testid="brands">
            <h2>{{ 'storesAdmin.brands' | transloco }}</h2>
            @if (brandError()) {
              <p role="alert">{{ brandError() }}</p>
            }
            <div class="table-scroll">
              <table class="items">
                <thead>
                  <tr>
                    <th>{{ 'storesAdmin.fields.name' | transloco }}</th>
                    <th>{{ 'storesAdmin.fields.status' | transloco }}</th>
                    @if (canManageStores()) {
                      <th></th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (row of brands(); track row.id) {
                    <tr>
                      <td>
                        @if (editingBrandId() === row.id) {
                          <input
                            [value]="editingBrandName()"
                            (input)="editingBrandName.set(field($event))"
                          />
                        } @else {
                          {{ row.name }}
                        }
                      </td>
                      <td>{{ statusLabel(row.archivedAt !== null) }}</td>
                      @if (canManageStores()) {
                        <td class="row-actions">
                          @if (editingBrandId() === row.id) {
                            <p-button
                              type="button"
                              [label]="'storesAdmin.saveBrand' | transloco"
                              [disabled]="busy()"
                              (onClick)="saveBrandName()"
                            />
                          } @else {
                            <p-button
                              type="button"
                              [label]="'storesAdmin.rename' | transloco"
                              [disabled]="busy()"
                              (onClick)="beginRename(row)"
                            />
                          }
                          <p-button
                            type="button"
                            [label]="archiveLabel(row.archivedAt !== null)"
                            [ariaLabel]="archiveNamed(row.archivedAt !== null, row.name)"
                            [disabled]="busy()"
                            (onClick)="setBrandArchived(row)"
                          />
                        </td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (canManageStores()) {
              <form class="form-grid" (submit)="$event.preventDefault()">
                <label>
                  {{ 'storesAdmin.fields.brandName' | transloco }}
                  <input [value]="brandName()" (input)="brandName.set(field($event))" />
                </label>
                <div class="form-actions">
                  <p-button
                    type="button"
                    [label]="'storesAdmin.addBrand' | transloco"
                    [disabled]="busy() || brandName().trim().length === 0"
                    (onClick)="addBrand()"
                  />
                </div>
              </form>
            }
          </section>
        }

        <section data-testid="locations">
          <h2>{{ 'storesAdmin.locations' | transloco }}</h2>
          @if (locationError()) {
            <p role="alert">{{ locationError() }}</p>
          }
          <div class="table-scroll">
            <table class="items">
              <thead>
                <tr>
                  <th>{{ 'storesAdmin.fields.name' | transloco }}</th>
                  <th>{{ 'storesAdmin.fields.city' | transloco }}</th>
                  <th>{{ 'storesAdmin.fields.timezone' | transloco }}</th>
                  <th>{{ 'storesAdmin.fields.status' | transloco }}</th>
                  @if (canManageLocations()) {
                    <th></th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (row of locations(); track row.id) {
                  <tr>
                    <td>{{ row.name }}</td>
                    <td>{{ cityOf(row.address) }}</td>
                    <td>{{ row.timezone }}</td>
                    <td>{{ statusLabel(row.archivedAt !== null) }}</td>
                    @if (canManageLocations()) {
                      <td class="row-actions">
                        <p-button
                          type="button"
                          [label]="'storesAdmin.edit' | transloco"
                          [ariaLabel]="'storesAdmin.editNamed' | transloco: { name: row.name }"
                          [disabled]="busy()"
                          (onClick)="beginEditLocation(row)"
                        />
                        <p-button
                          type="button"
                          [label]="archiveLabel(row.archivedAt !== null)"
                          [ariaLabel]="archiveNamed(row.archivedAt !== null, row.name)"
                          [disabled]="busy()"
                          (onClick)="setLocationArchived(row)"
                        />
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (canManageLocations()) {
            <form class="form-grid" (submit)="$event.preventDefault()">
              <h3 class="span-all">
                {{
                  (editingLocation() ? 'storesAdmin.editLocation' : 'storesAdmin.addLocation')
                    | transloco
                }}
              </h3>
              <label>
                {{ 'storesAdmin.fields.locationName' | transloco }}
                <input [value]="locationName()" (input)="locationName.set(field($event))" />
              </label>
              <label>
                {{ 'storesAdmin.fields.line1' | transloco }}
                <input [value]="locationLine1()" (input)="locationLine1.set(field($event))" />
              </label>
              <label>
                {{ 'storesAdmin.fields.line2' | transloco }}
                <input [value]="locationLine2()" (input)="locationLine2.set(field($event))" />
              </label>
              <label>
                {{ 'storesAdmin.fields.city' | transloco }}
                <input [value]="locationCity()" (input)="locationCity.set(field($event))" />
              </label>
              <label>
                {{ 'storesAdmin.fields.postcode' | transloco }}
                <input [value]="locationPostcode()" (input)="locationPostcode.set(field($event))" />
              </label>
              <label>
                {{ 'storesAdmin.fields.countryCode' | transloco }}
                <input [value]="locationCountry()" (input)="locationCountry.set(field($event))" />
              </label>
              <label>
                {{ 'storesAdmin.fields.timezone' | transloco }}
                <input [value]="locationTimezone()" (input)="locationTimezone.set(field($event))" />
              </label>
              <div class="form-actions">
                <p-button
                  type="button"
                  [label]="
                    (editingLocation() ? 'storesAdmin.saveLocation' : 'storesAdmin.addLocation')
                      | transloco
                  "
                  [disabled]="busy() || !locationReady()"
                  (onClick)="submitLocation()"
                />
                @if (editingLocation()) {
                  <p-button
                    type="button"
                    severity="secondary"
                    [label]="'storesAdmin.cancel' | transloco"
                    [disabled]="busy()"
                    (onClick)="cancelLocation()"
                  />
                }
              </div>
            </form>
          }
        </section>

        <section data-testid="stores">
          <h2>{{ 'storesAdmin.stores' | transloco }}</h2>
          @if (storeError()) {
            <p role="alert">{{ storeError() }}</p>
          }
          <div class="table-scroll">
            <table class="items">
              <thead>
                <tr>
                  <th>{{ 'storesAdmin.fields.name' | transloco }}</th>
                  <th>{{ 'storesAdmin.fields.platform' | transloco }}</th>
                  <th>{{ 'storesAdmin.fields.brand' | transloco }}</th>
                  <th>{{ 'storesAdmin.fields.location' | transloco }}</th>
                  <th>{{ 'storesAdmin.fields.status' | transloco }}</th>
                  @if (canManageStores()) {
                    <th></th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (row of stores(); track row.id) {
                  <tr>
                    <td>{{ row.name }}</td>
                    <td>{{ platformLabel(row.platform) }}</td>
                    <td>{{ row.brand.name }}</td>
                    <td>{{ row.location.name }}</td>
                    <td>{{ statusLabel(row.status === 'archived') }}</td>
                    @if (canManageStores()) {
                      <td class="row-actions">
                        <p-button
                          type="button"
                          [label]="'storesAdmin.edit' | transloco"
                          [ariaLabel]="'storesAdmin.editNamed' | transloco: { name: row.name }"
                          [disabled]="busy()"
                          (onClick)="beginEditStore(row)"
                        />
                        <p-button
                          type="button"
                          [label]="archiveLabel(row.status === 'archived')"
                          [ariaLabel]="archiveNamed(row.status === 'archived', row.name)"
                          [disabled]="busy()"
                          (onClick)="setStoreArchived(row)"
                        />
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (canManageStores()) {
            <form class="form-grid" (submit)="$event.preventDefault()">
              <h3 class="span-all">{{ 'storesAdmin.addStore' | transloco }}</h3>
              <label>
                {{ 'storesAdmin.fields.storeName' | transloco }}
                <input [value]="storeName()" (input)="storeName.set(field($event))" />
              </label>
              <label>
                {{ 'storesAdmin.fields.platform' | transloco }}
                <select name="platform" (change)="storePlatform.set(platformOf(field($event)))">
                  @for (item of platforms; track item) {
                    <option [value]="item" [selected]="item === storePlatform()">
                      {{ platformLabel(item) }}
                    </option>
                  }
                </select>
              </label>
              <label>
                {{ 'storesAdmin.fields.brand' | transloco }}
                <select (change)="storeBrandId.set(field($event))">
                  <option value="" [selected]="storeBrandId() === ''">
                    {{ 'storesAdmin.choose' | transloco }}
                  </option>
                  @for (brand of activeBrands(); track brand.id) {
                    <option [value]="brand.id" [selected]="brand.id === storeBrandId()">
                      {{ brand.name }}
                    </option>
                  }
                </select>
              </label>
              <label>
                {{ 'storesAdmin.fields.location' | transloco }}
                <select (change)="storeLocationId.set(field($event))">
                  <option value="" [selected]="storeLocationId() === ''">
                    {{ 'storesAdmin.choose' | transloco }}
                  </option>
                  @for (location of activeLocations(); track location.id) {
                    <option [value]="location.id" [selected]="location.id === storeLocationId()">
                      {{ location.name }}
                    </option>
                  }
                </select>
              </label>
              <label>
                {{ 'storesAdmin.fields.domain' | transloco }}
                <input [value]="storeDomain()" (input)="storeDomain.set(field($event))" />
              </label>
              <label>
                {{ 'storesAdmin.fields.invoiceAuthority' | transloco }}
                <select (change)="storeAuthority.set(authorityOf(field($event)))">
                  @for (item of authorities; track item) {
                    <option [value]="item" [selected]="item === storeAuthority()">
                      {{ authorityLabel(item) }}
                    </option>
                  }
                </select>
                <small>{{ 'storesAdmin.authorityHelp.' + storeAuthority() | transloco }}</small>
              </label>
              <div class="form-actions">
                <p-button
                  type="button"
                  [label]="'storesAdmin.addStore' | transloco"
                  [disabled]="busy() || !storeReady()"
                  (onClick)="addStore()"
                />
              </div>
            </form>
          }
          @if (canManageStores() && editingStore(); as current) {
            <form class="form-grid" data-testid="store-edit" (submit)="$event.preventDefault()">
              <h3 class="span-all">{{ 'storesAdmin.editStore' | transloco }}</h3>
              <p data-testid="store-platform">{{ platformLabel(current.platform) }}</p>
              <label>
                {{ 'storesAdmin.fields.storeName' | transloco }}
                <input [value]="editName()" (input)="editName.set(field($event))" />
              </label>
              <label>
                {{ 'storesAdmin.fields.brand' | transloco }}
                <select (change)="editBrandId.set(field($event))">
                  @for (brand of brands(); track brand.id) {
                    <option [value]="brand.id" [selected]="brand.id === editBrandId()">
                      {{ brand.name }}
                    </option>
                  }
                </select>
              </label>
              <label>
                {{ 'storesAdmin.fields.location' | transloco }}
                <select (change)="editLocationId.set(field($event))">
                  @for (location of locations(); track location.id) {
                    <option [value]="location.id" [selected]="location.id === editLocationId()">
                      {{ location.name }}
                    </option>
                  }
                </select>
              </label>
              <label>
                {{ 'storesAdmin.fields.domain' | transloco }}
                <input [value]="editDomain()" (input)="editDomain.set(field($event))" />
              </label>
              <label>
                {{ 'storesAdmin.fields.invoiceAuthority' | transloco }}
                <select (change)="editAuthority.set(authorityOf(field($event)))">
                  @for (item of authorities; track item) {
                    <option [value]="item" [selected]="item === editAuthority()">
                      {{ authorityLabel(item) }}
                    </option>
                  }
                </select>
                <small>{{ 'storesAdmin.authorityHelp.' + editAuthority() | transloco }}</small>
              </label>
              <div class="form-actions">
                <p-button
                  type="button"
                  [label]="'storesAdmin.saveStore' | transloco"
                  [disabled]="busy()"
                  (onClick)="saveStore()"
                />
                <p-button
                  type="button"
                  severity="secondary"
                  [label]="'storesAdmin.cancel' | transloco"
                  [disabled]="busy()"
                  (onClick)="cancelStore()"
                />
              </div>
            </form>
          }
        </section>
      }
    </section>
  `,
})
export class StoresPage {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly context = inject(CompanyContextStore);
  private readonly transloco = inject(TranslocoService);

  readonly field = fieldValue;
  readonly platforms: readonly Platform[] = ['prestashop', 'shopify', 'manual'];
  readonly authorities: readonly Authority[] = ['undecided', 'store', 'platform'];
  readonly canManageStores = computed(() => this.context.has('store.manage'));
  readonly companyWideStoreView = computed(() =>
    this.context
      .grants()
      .some((grant) => grant.permission === 'store.view' && grant.scopeType === 'company'),
  );
  readonly canManageLocations = computed(() => this.context.has('company.manage'));
  readonly activeBrands = computed(() => this.brands().filter((row) => row.archivedAt === null));
  readonly activeLocations = computed(() =>
    this.locations().filter((row) => row.archivedAt === null),
  );
  readonly companyId = signal('');
  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly loadError = signal(false);
  readonly busy = signal(false);
  readonly brandError = signal('');
  readonly locationError = signal('');
  readonly storeError = signal('');
  readonly brands = signal<BrandRow[]>([]);
  readonly locations = signal<LocationRow[]>([]);
  readonly stores = signal<StoreRow[]>([]);
  readonly brandName = signal('');
  readonly editingBrandId = signal('');
  readonly editingBrandName = signal('');
  readonly editingLocation = signal<LocationRow | null>(null);
  readonly locationName = signal('');
  readonly locationLine1 = signal('');
  readonly locationLine2 = signal('');
  readonly locationCity = signal('');
  readonly locationPostcode = signal('');
  readonly locationCountry = signal('');
  readonly locationTimezone = signal('Asia/Nicosia');
  readonly storeName = signal('');
  readonly storePlatform = signal<Platform>('prestashop');
  readonly storeBrandId = signal('');
  readonly storeLocationId = signal('');
  readonly storeDomain = signal('');
  readonly storeAuthority = signal<Authority>('undecided');
  readonly editingStore = signal<StoreRow | null>(null);
  readonly editName = signal('');
  readonly editBrandId = signal('');
  readonly editLocationId = signal('');
  readonly editDomain = signal('');
  readonly editAuthority = signal<Authority>('undecided');
  private generation = 0;

  constructor() {
    const companyId$ = this.route.parent?.paramMap ?? of(emptyParams());
    companyId$.pipe(takeUntilDestroyed()).subscribe((params) => {
      this.open(params.get('companyId') ?? '');
    });
  }

  open(companyId: string): void {
    this.generation += 1;
    this.companyId.set(companyId);
    this.busy.set(false);
    this.brandError.set('');
    this.locationError.set('');
    this.storeError.set('');
    this.editingBrandId.set('');
    this.editingLocation.set(null);
    this.editingStore.set(null);
    this.load(this.generation);
  }

  addBrand(): void {
    const name = this.brandName().trim();
    if (!this.canManageStores() || this.busy() || name.length === 0) {
      return;
    }
    this.brandError.set('');
    this.send(
      this.http.post<{ brand: BrandRow }>(this.url('brands'), { name }),
      (response) => {
        this.brandName.set('');
        this.brands.set(byName([...this.brands(), response.brand]));
      },
      this.brandError,
    );
  }

  beginRename(row: BrandRow): void {
    this.editingBrandId.set(row.id);
    this.editingBrandName.set(row.name);
  }

  saveBrandName(): void {
    const id = this.editingBrandId();
    const name = this.editingBrandName().trim();
    if (!this.canManageStores() || this.busy() || id.length === 0 || name.length === 0) {
      return;
    }
    this.brandError.set('');
    this.send(
      this.http.patch<{ brand: BrandRow }>(this.url(`brands/${id}`), { name }),
      () => {
        this.editingBrandId.set('');
        this.refreshListedNames('brand');
      },
      this.brandError,
    );
  }

  setBrandArchived(row: BrandRow): void {
    if (!this.canManageStores() || this.busy()) {
      return;
    }
    this.brandError.set('');
    this.send(
      this.http.patch<{ brand: BrandRow }>(this.url(`brands/${row.id}`), {
        archived: row.archivedAt === null,
      }),
      () => {
        this.refreshListedNames('brand');
      },
      this.brandError,
    );
  }

  beginEditLocation(row: LocationRow): void {
    const address = readAddress(row.address);
    this.editingLocation.set(row);
    this.locationName.set(row.name);
    this.locationLine1.set(address.line1);
    this.locationLine2.set(address.line2);
    this.locationCity.set(address.city);
    this.locationPostcode.set(address.postcode);
    this.locationCountry.set(address.countryCode);
    this.locationTimezone.set(row.timezone ?? '');
    this.locationError.set('');
  }

  cancelLocation(): void {
    this.editingLocation.set(null);
    this.resetLocationForm();
  }

  submitLocation(): void {
    const editing = this.editingLocation();
    if (editing) {
      this.patchLocation(editing);
      return;
    }
    this.addLocation();
  }

  setLocationArchived(row: LocationRow): void {
    if (!this.canManageLocations() || this.busy()) {
      return;
    }
    this.locationError.set('');
    this.send(
      this.http.patch<{ location: LocationRow }>(this.url(`locations/${row.id}`), {
        archived: row.archivedAt === null,
      }),
      () => {
        this.refreshListedNames('location');
      },
      this.locationError,
    );
  }

  addStore(): void {
    if (!this.canManageStores() || this.busy() || !this.storeReady()) {
      return;
    }
    const body: Record<string, unknown> = {
      name: this.storeName().trim(),
      platform: this.storePlatform(),
      brandId: this.storeBrandId(),
      locationId: this.storeLocationId(),
    };
    const domain = this.storeDomain().trim();
    if (domain.length > 0) {
      body['domain'] = domain;
    }
    if (this.storeAuthority() !== 'undecided') {
      body['invoiceAuthority'] = this.storeAuthority();
    }
    this.storeError.set('');
    this.send(
      this.http.post<{ store: StoreRow }>(this.url('stores'), body),
      (response) => {
        this.storeName.set('');
        this.storeDomain.set('');
        this.storeBrandId.set('');
        this.storeLocationId.set('');
        this.stores.set(byName([...this.stores(), response.store]));
      },
      this.storeError,
    );
  }

  beginEditStore(row: StoreRow): void {
    this.editingStore.set(row);
    this.editName.set(row.name);
    this.editBrandId.set(row.brandId);
    this.editLocationId.set(row.locationId);
    this.editDomain.set(row.domain ?? '');
    this.editAuthority.set(authority(row.invoiceAuthority));
    this.storeError.set('');
  }

  cancelStore(): void {
    this.editingStore.set(null);
  }

  saveStore(): void {
    const current = this.editingStore();
    if (!current || !this.canManageStores() || this.busy()) {
      return;
    }
    const name = this.editName().trim();
    if (name.length === 0) {
      this.storeError.set(this.transloco.translate('storesAdmin.nameRequired'));
      return;
    }
    const body: Record<string, unknown> = {};
    if (name !== current.name) {
      body['name'] = name;
    }
    if (this.editBrandId() !== current.brandId) {
      body['brandId'] = this.editBrandId();
    }
    if (this.editLocationId() !== current.locationId) {
      body['locationId'] = this.editLocationId();
    }
    const domain = this.editDomain().trim();
    if (domain !== (current.domain ?? '')) {
      body['domain'] = domain.length === 0 ? null : domain;
    }
    if (this.editAuthority() !== authority(current.invoiceAuthority)) {
      body['invoiceAuthority'] = this.editAuthority();
    }
    if (Object.keys(body).length === 0) {
      return;
    }
    this.storeError.set('');
    this.send(
      this.http.patch<{ store: StoreRow }>(this.url(`stores/${current.id}`), body),
      (response) => {
        this.editingStore.set(null);
        this.replaceStore(response.store);
      },
      this.storeError,
    );
  }

  setStoreArchived(row: StoreRow): void {
    if (!this.canManageStores() || this.busy()) {
      return;
    }
    this.storeError.set('');
    this.send(
      this.http.patch<{ store: StoreRow }>(this.url(`stores/${row.id}`), {
        archived: row.status !== 'archived',
      }),
      (response) => {
        this.replaceStore(response.store);
      },
      this.storeError,
    );
  }

  platformOf(value: string): Platform {
    return platform(value);
  }

  authorityOf(value: string): Authority {
    return authority(value);
  }

  locationReady(): boolean {
    return (
      this.locationName().trim().length > 0 &&
      this.locationLine1().trim().length > 0 &&
      this.locationCity().trim().length > 0 &&
      this.locationCountry().trim().length > 0
    );
  }

  storeReady(): boolean {
    return (
      this.storeName().trim().length > 0 &&
      this.storeBrandId().length > 0 &&
      this.storeLocationId().length > 0
    );
  }

  cityOf(address: unknown): string {
    return readAddress(address).city;
  }

  platformLabel(platform: string): string {
    return this.transloco.translate(`storesAdmin.platform.${platform}`);
  }

  authorityLabel(value: string): string {
    return this.transloco.translate(`storesAdmin.authority.${value}`);
  }

  statusLabel(archived: boolean): string {
    return this.transloco.translate(archived ? 'storesAdmin.archived' : 'storesAdmin.active');
  }

  archiveLabel(archived: boolean): string {
    return this.transloco.translate(archived ? 'storesAdmin.restore' : 'storesAdmin.archive');
  }

  archiveNamed(archived: boolean, name: string): string {
    const key = archived ? 'storesAdmin.restoreNamed' : 'storesAdmin.archiveNamed';
    return this.transloco.translate(key, { name });
  }

  private load(generation: number): void {
    const companyId = this.companyId();
    if (!companyId) {
      return;
    }
    this.loading.set(true);
    this.loadError.set(false);
    this.brandError.set('');
    this.locationError.set('');
    this.storeError.set('');
    const brands = this.companyWideStoreView()
      ? this.readSection(
          this.http.get<{ brands: BrandRow[] }>(`/api/c/${companyId}/brands`),
          this.brandError,
        )
      : of<{ brands: BrandRow[] } | null>(null);
    forkJoin({
      brandBody: brands,
      locationBody: this.readSection(
        this.http.get<{ locations: LocationRow[] }>(`/api/c/${companyId}/locations`),
        this.locationError,
      ),
      storeBody: this.readSection(
        this.http.get<{ stores: StoreRow[] }>(`/api/c/${companyId}/stores`),
        this.storeError,
      ),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation !== this.generation) {
            return;
          }
          this.loading.set(false);
          this.brands.set(response.brandBody?.brands ?? []);
          this.locations.set(response.locationBody?.locations ?? []);
          this.stores.set(response.storeBody?.stores ?? []);
          this.loaded.set(true);
        },
        error: () => {
          if (generation !== this.generation) {
            return;
          }
          this.loading.set(false);
          this.loadError.set(true);
        },
      });
  }

  private readSection<T>(
    request: Observable<T>,
    error: { set: (value: string) => void },
  ): Observable<T | null> {
    return request.pipe(
      catchError((cause: unknown) => {
        if (cause instanceof HttpErrorResponse && cause.status === 403) {
          error.set(this.transloco.translate('storesAdmin.forbidden'));
          return of(null);
        }
        return throwError(() => cause);
      }),
    );
  }

  private addLocation(): void {
    const address = this.addressBody();
    if (!this.canManageLocations() || this.busy() || !address || !this.locationReady()) {
      return;
    }
    const body: Record<string, unknown> = { name: this.locationName().trim(), address };
    const timezone = this.locationTimezone().trim();
    if (timezone.length > 0) {
      body['timezone'] = timezone;
    }
    this.locationError.set('');
    this.send(
      this.http.post<{ location: LocationRow }>(this.url('locations'), body),
      (response) => {
        this.resetLocationForm();
        this.locations.set(byName([...this.locations(), response.location]));
      },
      this.locationError,
    );
  }

  private patchLocation(current: LocationRow): void {
    const address = this.addressBody();
    if (!this.canManageLocations() || this.busy() || !address) {
      return;
    }
    const previous = readAddress(current.address);
    const body: Record<string, unknown> = {};
    const name = this.locationName().trim();
    if (name !== current.name) {
      body['name'] = name;
    }
    if (JSON.stringify(addressFields(previous)) !== JSON.stringify(address)) {
      body['address'] = address;
    }
    const timezone = this.locationTimezone().trim();
    if (timezone !== (current.timezone ?? '')) {
      body['timezone'] = timezone.length === 0 ? null : timezone;
    }
    if (Object.keys(body).length === 0) {
      return;
    }
    this.locationError.set('');
    this.send(
      this.http.patch<{ location: LocationRow }>(this.url(`locations/${current.id}`), body),
      () => {
        this.editingLocation.set(null);
        this.resetLocationForm();
        this.refreshListedNames('location');
      },
      this.locationError,
    );
  }

  private addressBody(): Record<string, string> | null {
    return addressFields({
      line1: this.locationLine1(),
      line2: this.locationLine2(),
      city: this.locationCity(),
      postcode: this.locationPostcode(),
      countryCode: this.locationCountry(),
    });
  }

  private resetLocationForm(): void {
    this.locationName.set('');
    this.locationLine1.set('');
    this.locationLine2.set('');
    this.locationCity.set('');
    this.locationPostcode.set('');
    this.locationCountry.set('');
    this.locationTimezone.set('Asia/Nicosia');
  }

  private refreshListedNames(kind: 'brand' | 'location'): void {
    const generation = this.generation;
    const companyId = this.companyId();
    if (!companyId) {
      return;
    }
    // Busy until the lists land, so a later edit cannot be overwritten by this refresh.
    this.busy.set(true);
    const brandBody =
      kind === 'brand' && this.companyWideStoreView()
        ? this.readSection(
            this.http.get<{ brands: BrandRow[] }>(`/api/c/${companyId}/brands`),
            this.brandError,
          )
        : of<{ brands: BrandRow[] } | null>(null);
    const locationBody =
      kind === 'location'
        ? this.readSection(
            this.http.get<{ locations: LocationRow[] }>(`/api/c/${companyId}/locations`),
            this.locationError,
          )
        : of<{ locations: LocationRow[] } | null>(null);
    forkJoin({
      brandBody,
      locationBody,
      storeBody: this.readSection(
        this.http.get<{ stores: StoreRow[] }>(`/api/c/${companyId}/stores`),
        this.storeError,
      ),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          if (response.brandBody) {
            this.brands.set(response.brandBody.brands);
          }
          if (response.locationBody) {
            this.locations.set(response.locationBody.locations);
          }
          if (response.storeBody) {
            this.stores.set(response.storeBody.stores);
          }
        },
        error: () => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          const message = this.transloco.translate('storesAdmin.error');
          if (kind === 'brand') {
            this.brandError.set(message);
          } else {
            this.locationError.set(message);
          }
        },
      });
  }

  private replaceStore(store: StoreRow): void {
    this.stores.set(byName(this.stores().map((row) => (row.id === store.id ? store : row))));
  }

  private url(path: string): string {
    return `/api/c/${this.companyId()}/${path}`;
  }

  private send<T>(
    request: Observable<T>,
    apply: (value: T) => void,
    error: { set: (value: string) => void },
  ): void {
    const generation = this.generation;
    this.busy.set(true);
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (value) => {
        if (generation !== this.generation) {
          return;
        }
        // Cleared before apply, so a list refresh that apply starts keeps the page busy.
        this.busy.set(false);
        apply(value);
      },
      error: (cause: unknown) => {
        if (generation !== this.generation) {
          return;
        }
        this.busy.set(false);
        error.set(this.explain(cause));
      },
    });
  }

  private explain(error: unknown): string {
    if (!(error instanceof HttpErrorResponse)) {
      return this.transloco.translate('storesAdmin.error');
    }
    const body = readApiError(error);
    if (body.code === 'location_in_use') {
      return this.transloco.translate('storesAdmin.locationInUse');
    }
    if (body.code === 'authority_locked') {
      return this.transloco.translate('storesAdmin.authorityLocked');
    }
    if (body.code === 'name_taken') {
      return this.transloco.translate('storesAdmin.nameTaken');
    }
    if (body.code === 'brand_archived') {
      return this.transloco.translate('storesAdmin.brandArchived');
    }
    if (body.code === 'location_archived') {
      return this.transloco.translate('storesAdmin.locationArchived');
    }
    return body.message.length > 0 ? body.message : this.transloco.translate('storesAdmin.error');
  }
}

function byName<T extends { name: string; id: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
}

function addressFields(fields: AddressFields): Record<string, string> | null {
  const line1 = fields.line1.trim();
  const city = fields.city.trim();
  const countryCode = fields.countryCode.trim().toUpperCase();
  if (line1.length === 0 || city.length === 0 || countryCode.length === 0) {
    return null;
  }
  const address: Record<string, string> = { line1, city, countryCode };
  const line2 = fields.line2.trim();
  const postcode = fields.postcode.trim();
  if (line2.length > 0) {
    address['line2'] = line2;
  }
  if (postcode.length > 0) {
    address['postcode'] = postcode;
  }
  return address;
}

function readAddress(value: unknown): AddressFields {
  if (typeof value !== 'object' || value === null) {
    return { line1: '', line2: '', city: '', postcode: '', countryCode: '' };
  }
  const record = value as Record<string, unknown>;
  return {
    line1: text(record['line1']),
    line2: text(record['line2']),
    city: text(record['city']),
    postcode: text(record['postcode']),
    countryCode: text(record['countryCode']),
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function platform(value: string): Platform {
  if (value === 'shopify' || value === 'manual') {
    return value;
  }
  return 'prestashop';
}

function authority(value: string): Authority {
  if (value === 'store' || value === 'platform') {
    return value;
  }
  return 'undecided';
}

function emptyParams(): { get: (name: string) => string | null } {
  return { get: () => null };
}
