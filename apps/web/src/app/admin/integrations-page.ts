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
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { of } from 'rxjs';
import { readApiError } from '../core/api-error';
import { CompanyContextStore } from '../core/company-context.store';
import { ActiveLang } from '../format/active-lang';
import { CompanyDatePipe } from '../format/company-date.pipe';
import { fieldValue } from '../orders/field-value';

const PAYMENT_STATUSES = [
  'pending',
  'authorized',
  'paid',
  'partially_paid',
  'refunded',
  'partially_refunded',
  'voided',
  'unknown',
] as const;

const DELIVERY_METHODS = ['courier_cy', 'post_international', 'collection', 'unknown'] as const;

type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

type StoreOption = { id: string; name: string; platform: string; status: string };

type StateEntry = { payment: PaymentStatus; cancelled: boolean };

type ConnectionView = {
  id: string;
  status: string;
  settings: {
    baseUrl: string;
    timezone: string;
    firstImportFrom: string;
    pollIntervalSeconds: number;
  };
  stateMap: Record<string, StateEntry>;
  carrierMap: Record<string, DeliveryMethod>;
  keySet: boolean;
  keySetAt: string | null;
  lastTestAt: string | null;
  lastTestResult: string | null;
  lastSyncAt: string | null;
  lastErrorClass: string | null;
  lastErrorAt: string | null;
  firstImportLocked: boolean;
};

type StateRow = { id: string; name: string; payment: PaymentStatus; cancelled: boolean };
type CarrierRow = { idReference: string; name: string; method: DeliveryMethod };

type TestBody = { ok: true } | { ok: false; errorClass: string; resource?: string };
type PrintTestBody = { ok: true; email: string } | { ok: false; errorClass: string };

@Component({
  selector: 'bp-integrations-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, Button, CompanyDatePipe, RouterLink],
  template: `
    <section class="screen">
      <h1>{{ 'integrations.title' | transloco }}</h1>
      @if (loadingStores()) {
        <p role="status">{{ 'integrations.loading' | transloco }}</p>
      }
      @if (sectionError()) {
        <p role="alert">{{ sectionError() }}</p>
      }
      @if (storesLoaded() && stores().length === 0 && !sectionError()) {
        <p>
          {{ 'integrations.noStores' | transloco }}
          <a [routerLink]="['/c', companyId(), 'admin', 'stores']">{{
            'integrations.storesLink' | transloco
          }}</a>
        </p>
      }
      @if (stores().length > 0) {
        <section data-testid="prestashop">
          <label>
            {{ 'integrations.store' | transloco }}
            <select
              [disabled]="busy() || loadingStores()"
              (change)="chooseStore(field($event))"
            >
              <option value="" [selected]="selectedStoreId() === ''">
                {{ 'integrations.chooseStore' | transloco }}
              </option>
              @for (store of stores(); track store.id) {
                <option [value]="store.id" [selected]="store.id === selectedStoreId()">
                  {{ store.name }}
                </option>
              }
            </select>
          </label>
          @if (loaded()) {
            <form class="form-grid" (submit)="$event.preventDefault()">
              @if (status()) {
                <p class="span-all" data-testid="sync-status">{{ statusText() }}</p>
              }
              @if (notice()) {
                <p class="span-all" role="status">{{ notice() }}</p>
              }
              <label>
                {{ 'integrations.shopUrl' | transloco }}
                <input
                  [value]="baseUrl()"
                  [disabled]="!canEdit()"
                  (input)="baseUrl.set(field($event))"
                />
              </label>
              @if (showKeyInput()) {
                <label>
                  {{ 'integrations.key' | transloco }}
                  <input
                    type="password"
                    autocomplete="off"
                    data-testid="prestashop-key"
                    [value]="key()"
                    [disabled]="!canEdit()"
                    (input)="key.set(field($event))"
                  />
                </label>
              }
              @if (keySet() && keySetAt()) {
                <p class="span-all">
                  {{ 'integrations.keySetOn' | transloco }}
                  {{ keySetAt() | companyDate: context.timezone() : lang.code() }}
                </p>
              }
              @if (canManage() && keySet() && !replacingKey()) {
                <div class="form-actions">
                  <p-button
                    type="button"
                    [label]="'integrations.replaceKey' | transloco"
                    [disabled]="busy()"
                    (onClick)="replacingKey.set(true)"
                  />
                </div>
              }
              <label>
                {{ 'integrations.timezone' | transloco }}
                <input
                  [value]="timezone()"
                  [disabled]="!canEdit()"
                  (input)="timezone.set(field($event))"
                />
              </label>
              <label>
                {{ 'integrations.firstImport' | transloco }}
                <input
                  data-testid="first-import"
                  [value]="firstImportFrom()"
                  [disabled]="!canEdit() || firstImportLocked()"
                  (input)="firstImportFrom.set(field($event))"
                />
              </label>
              @if (firstImportLocked()) {
                <p class="span-all">{{ 'integrations.firstImportLocked' | transloco }}</p>
              }
              <label>
                {{ 'integrations.pollMinutes' | transloco }}
                <input
                  [value]="pollMinutes()"
                  [disabled]="!canEdit()"
                  (input)="pollMinutes.set(field($event))"
                />
              </label>
              @if (canManage()) {
                <div class="form-actions">
                  <p-button
                    type="button"
                    [label]="'integrations.save' | transloco"
                    [disabled]="!canSave()"
                    (onClick)="save()"
                  />
                  <p-button
                    type="button"
                    [label]="'integrations.test' | transloco"
                    [disabled]="!canTest()"
                    (onClick)="testConnection()"
                  />
                  <p-button
                    type="button"
                    [label]="'integrations.start' | transloco"
                    [disabled]="!canStart()"
                    (onClick)="activate()"
                  />
                  <p-button
                    type="button"
                    [label]="'integrations.pause' | transloco"
                    [disabled]="!canPause()"
                    (onClick)="pause()"
                  />
                </div>
              }
            </form>
            @if (connection()) {
              <section data-testid="maps">
                @if (canManage() && lastTestResult() === 'ok') {
                  <p-button
                    type="button"
                    [label]="'integrations.loadShop' | transloco"
                    [disabled]="busy()"
                    (onClick)="loadFromShop()"
                  />
                }
                <h2>{{ 'integrations.orderStates' | transloco }}</h2>
                <div class="table-scroll">
                  <table class="items">
                    <thead>
                      <tr>
                        <th>{{ 'integrations.state' | transloco }}</th>
                        <th>{{ 'integrations.payment' | transloco }}</th>
                        <th>{{ 'integrations.cancelled' | transloco }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of stateRows(); track row.id) {
                        <tr>
                          <td>{{ row.name }}</td>
                          <td>
                            <select
                              [disabled]="!canEdit()"
                              (change)="setPayment(row.id, field($event))"
                            >
                              @for (payment of payments; track payment) {
                                <option
                                  [value]="payment"
                                  [selected]="payment === row.payment"
                                >
                                  {{ ('orders.payment.' + payment) | transloco }}
                                </option>
                              }
                            </select>
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              [checked]="row.cancelled"
                              [disabled]="!canEdit()"
                              (change)="setCancelled(row.id, $event)"
                            />
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
                <h2>{{ 'integrations.carriers' | transloco }}</h2>
                <div class="table-scroll">
                  <table class="items">
                    <thead>
                      <tr>
                        <th>{{ 'integrations.carrier' | transloco }}</th>
                        <th>{{ 'integrations.delivery' | transloco }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of carrierRows(); track row.idReference) {
                        <tr>
                          <td>{{ row.name }}</td>
                          <td>
                            <select
                              [disabled]="!canEdit()"
                              (change)="setDelivery(row.idReference, field($event))"
                            >
                              @for (method of deliveries; track method) {
                                <option [value]="method" [selected]="method === row.method">
                                  {{ ('orders.delivery.' + method) | transloco }}
                                </option>
                              }
                            </select>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
                @if (canManage()) {
                  <p-button
                    type="button"
                    [label]="'integrations.saveMaps' | transloco"
                    [disabled]="busy()"
                    (onClick)="saveMaps()"
                  />
                }
              </section>
            }
          }
        </section>
      }
      @if (canPrint()) {
        <section data-testid="printnode">
          <h2>{{ 'integrations.printTitle' | transloco }}</h2>
          @if (printError()) {
            <p role="alert">{{ printError() }}</p>
          }
          @if (printLoaded()) {
            @if (printKeySet() && printKeySetAt()) {
              <p>
                {{ 'integrations.keySetOn' | transloco }}
                {{ printKeySetAt() | companyDate: context.timezone() : lang.code() }}
              </p>
            }
            @if (printNotice()) {
              <p role="status">{{ printNotice() }}</p>
            }
            <form class="form-grid" (submit)="$event.preventDefault()">
              <label>
                {{ 'integrations.printKey' | transloco }}
                <input
                  type="password"
                  autocomplete="off"
                  data-testid="printnode-key"
                  [value]="printKey()"
                  [disabled]="printBusy()"
                  (input)="printKey.set(field($event))"
                />
              </label>
              <div class="form-actions">
                <p-button
                  type="button"
                  [label]="'integrations.save' | transloco"
                  [disabled]="printBusy() || printKey().trim().length === 0"
                  (onClick)="savePrint()"
                />
                <p-button
                  type="button"
                  [label]="'integrations.printTest' | transloco"
                  [disabled]="printBusy() || !printKeySet()"
                  (onClick)="testPrint()"
                />
              </div>
            </form>
          }
        </section>
      }
    </section>
  `,
})
export class IntegrationsPage {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly transloco = inject(TranslocoService);
  readonly context = inject(CompanyContextStore);
  readonly lang = inject(ActiveLang);

  readonly payments = PAYMENT_STATUSES;
  readonly deliveries = DELIVERY_METHODS;
  readonly field = fieldValue;

  readonly companyId = signal('');
  readonly stores = signal<StoreOption[]>([]);
  readonly selectedStoreId = signal('');
  readonly loadingStores = signal(false);
  readonly storesLoaded = signal(false);
  readonly sectionError = signal('');
  readonly loaded = signal(false);
  readonly busy = signal(false);
  readonly connection = signal<ConnectionView | null>(null);
  readonly baseUrl = signal('');
  readonly key = signal('');
  readonly replacingKey = signal(false);
  readonly timezone = signal('');
  readonly firstImportFrom = signal('');
  readonly pollMinutes = signal('3');
  readonly status = signal<string | null>(null);
  readonly lastTestResult = signal<string | null>(null);
  readonly keySet = signal(false);
  readonly keySetAt = signal<string | null>(null);
  readonly firstImportLocked = signal(false);
  readonly notice = signal('');
  readonly stateRows = signal<StateRow[]>([]);
  readonly carrierRows = signal<CarrierRow[]>([]);

  readonly printKey = signal('');
  readonly printKeySet = signal(false);
  readonly printKeySetAt = signal<string | null>(null);
  readonly printLoaded = signal(false);
  readonly printError = signal('');
  readonly printNotice = signal('');
  readonly printBusy = signal(false);

  readonly canManage = computed(() => this.context.has('integration.manage'));
  readonly canPrint = computed(() => this.context.has('printer.manage'));
  readonly canEdit = computed(() => this.canManage() && this.loaded() && !this.busy());
  readonly showKeyInput = computed(
    () => this.canManage() && (!this.keySet() || this.replacingKey()),
  );

  /** Store generation: a company change or a store choice. Guards the PrestaShop section. */
  private generation = 0;
  /** Company generation: only a company change. Guards the PrintNode section. */
  private printGeneration = 0;
  private savedPollSeconds: number | null = null;
  /** Company and store the visible form was loaded for. Save writes only here. */
  private boundCompanyId: string | null = null;
  private boundStoreId: string | null = null;
  private printBoundCompanyId: string | null = null;

  constructor() {
    const companyId$ = this.route.parent?.paramMap ?? of(emptyParams());
    companyId$.pipe(takeUntilDestroyed()).subscribe((params) => {
      this.open(params.get('companyId') ?? '');
    });
  }

  open(companyId: string): void {
    this.generation += 1;
    this.printGeneration += 1;
    this.companyId.set(companyId);
    this.clearShopForm();
    this.clearPrint();
    this.stores.set([]);
    this.selectedStoreId.set('');
    this.storesLoaded.set(false);
    this.sectionError.set('');
    this.loaded.set(false);
    this.busy.set(false);
    this.boundCompanyId = null;
    this.boundStoreId = null;
    if (!companyId) {
      return;
    }
    this.loadStores(this.generation);
    if (this.context.has('printer.manage')) {
      this.loadPrint(this.printGeneration, companyId);
    }
  }

  chooseStore(storeId: string): void {
    this.generation += 1;
    this.selectedStoreId.set(storeId);
    this.clearShopForm();
    this.loaded.set(false);
    this.busy.set(false);
    this.boundStoreId = null;
    this.notice.set('');
    if (!storeId || !this.companyId()) {
      return;
    }
    this.loadConnection(this.generation, this.companyId(), storeId);
  }

  save(): void {
    const companyId = this.boundCompanyId;
    const storeId = this.boundStoreId;
    if (!this.canSave() || !companyId || !storeId) {
      return;
    }
    if (companyId !== this.companyId() || storeId !== this.selectedStoreId()) {
      return;
    }
    const generation = this.generation;
    const body = this.connectionBody();
    this.busy.set(true);
    this.notice.set('');
    this.http
      .put<{ connection: ConnectionView }>(this.connectionUrl(companyId, storeId), body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          this.applyConnection(response.connection);
        },
        error: (error: unknown) => {
          this.failShop(generation, error);
        },
      });
  }

  testConnection(): void {
    const companyId = this.boundCompanyId;
    const storeId = this.boundStoreId;
    if (!this.canTest() || !companyId || !storeId) {
      return;
    }
    const generation = this.generation;
    this.busy.set(true);
    this.notice.set('');
    this.http
      .post<TestBody>(`${this.connectionUrl(companyId, storeId)}/test`, {})
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (body) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          if (body.ok) {
            this.lastTestResult.set('ok');
            this.notice.set(this.transloco.translate('integrations.testOk'));
            return;
          }
          this.lastTestResult.set(body.errorClass);
          this.notice.set(this.errorSentence(body.errorClass, body.resource));
        },
        error: (error: unknown) => {
          this.failShop(generation, error);
        },
      });
  }

  activate(): void {
    this.postAction('activate');
  }

  pause(): void {
    this.postAction('pause');
  }

  loadFromShop(): void {
    const companyId = this.boundCompanyId;
    const storeId = this.boundStoreId;
    if (!companyId || !storeId || this.busy() || this.lastTestResult() !== 'ok') {
      return;
    }
    const generation = this.generation;
    this.busy.set(true);
    this.notice.set('');
    const base = this.connectionUrl(companyId, storeId);
    this.http
      .get<unknown>(`${base}/order-states`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (body) => {
          if (generation !== this.generation) {
            return;
          }
          this.mergeStates(readStates(body));
          this.http
            .get<unknown>(`${base}/carriers`)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: (carriers) => {
                if (generation !== this.generation) {
                  return;
                }
                this.busy.set(false);
                this.mergeCarriers(readCarriers(carriers));
              },
              error: (error: unknown) => {
                this.failLookup(generation, error);
              },
            });
        },
        error: (error: unknown) => {
          this.failLookup(generation, error);
        },
      });
  }

  saveMaps(): void {
    const companyId = this.boundCompanyId;
    const storeId = this.boundStoreId;
    if (!companyId || !storeId || !this.canManage() || this.busy() || !this.loaded()) {
      return;
    }
    const generation = this.generation;
    const stateNames = new Map(this.stateRows().map((row) => [row.id, row.name]));
    const carrierNames = new Map(this.carrierRows().map((row) => [row.idReference, row.name]));
    const stateMap: Record<string, StateEntry> = {};
    for (const row of this.stateRows()) {
      stateMap[row.id] = { payment: row.payment, cancelled: row.cancelled };
    }
    const carrierMap: Record<string, DeliveryMethod> = {};
    for (const row of this.carrierRows()) {
      carrierMap[row.idReference] = row.method;
    }
    this.busy.set(true);
    this.http
      .put<{ connection: ConnectionView }>(`${this.connectionUrl(companyId, storeId)}/maps`, {
        stateMap,
        carrierMap,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          this.applyConnection(response.connection);
          this.stateRows.update((rows) =>
            rows.map((row) => ({ ...row, name: stateNames.get(row.id) ?? row.name })),
          );
          this.carrierRows.update((rows) =>
            rows.map((row) => ({
              ...row,
              name: carrierNames.get(row.idReference) ?? row.name,
            })),
          );
        },
        error: (error: unknown) => {
          this.failShop(generation, error);
        },
      });
  }

  setPayment(id: string, value: string): void {
    const payment = paymentOf(value);
    this.stateRows.update((rows) => rows.map((row) => (row.id === id ? { ...row, payment } : row)));
  }

  setCancelled(id: string, event: Event): void {
    const target = event.target;
    const cancelled = target instanceof HTMLInputElement && target.checked;
    this.stateRows.update((rows) =>
      rows.map((row) => (row.id === id ? { ...row, cancelled } : row)),
    );
  }

  setDelivery(idReference: string, value: string): void {
    const method = deliveryOf(value);
    this.carrierRows.update((rows) =>
      rows.map((row) => (row.idReference === idReference ? { ...row, method } : row)),
    );
  }

  savePrint(): void {
    const companyId = this.printBoundCompanyId;
    const key = this.printKey().trim();
    if (!companyId || companyId !== this.companyId() || !this.printLoaded() || this.printBusy()) {
      return;
    }
    if (key.length === 0) {
      return;
    }
    const generation = this.printGeneration;
    this.printBusy.set(true);
    this.printNotice.set('');
    this.http
      .put<{ keySet: boolean; keySetAt: string | null }>(
        `/api/c/${companyId}/print-accounts/printnode`,
        { key },
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (body) => {
          if (generation !== this.printGeneration) {
            return;
          }
          this.printBusy.set(false);
          this.printKey.set('');
          this.printKeySet.set(body.keySet);
          this.printKeySetAt.set(body.keySetAt);
        },
        error: (error: unknown) => {
          this.failPrint(generation, error);
        },
      });
  }

  testPrint(): void {
    const companyId = this.printBoundCompanyId;
    if (!companyId || companyId !== this.companyId() || !this.printKeySet() || this.printBusy()) {
      return;
    }
    const generation = this.printGeneration;
    this.printBusy.set(true);
    this.printNotice.set('');
    this.http
      .post<PrintTestBody>(`/api/c/${companyId}/print-accounts/printnode/test`, {})
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (body) => {
          if (generation !== this.printGeneration) {
            return;
          }
          this.printBusy.set(false);
          this.printNotice.set(
            body.ok
              ? this.transloco.translate('integrations.printEmail', { email: body.email })
              : this.errorSentence(body.errorClass),
          );
        },
        error: (error: unknown) => {
          this.failPrint(generation, error);
        },
      });
  }

  canSave(): boolean {
    if (!this.canEdit() || !this.boundCompanyId || !this.boundStoreId) {
      return false;
    }
    if (this.boundCompanyId !== this.companyId() || this.boundStoreId !== this.selectedStoreId()) {
      return false;
    }
    if (!this.baseUrl().trim() || !this.timezone().trim() || !this.firstImportFrom().trim()) {
      return false;
    }
    if (!this.connection() && this.key().trim().length === 0) {
      return false;
    }
    return this.pollSeconds() !== null;
  }

  canTest(): boolean {
    return this.canEdit() && this.connection() !== null && this.keySet();
  }

  canStart(): boolean {
    return (
      this.canEdit() &&
      this.connection() !== null &&
      this.status() !== 'active' &&
      this.lastTestResult() === 'ok'
    );
  }

  canPause(): boolean {
    return this.canEdit() && this.connection() !== null && this.status() !== 'paused';
  }

  statusText(): string {
    const status = this.status();
    if (status === 'paused' || status === 'active' || status === 'auth_failed') {
      return this.transloco.translate(`integrations.status.${status}`);
    }
    return status ?? '';
  }

  private loadStores(generation: number): void {
    const companyId = this.companyId();
    this.loadingStores.set(true);
    this.http
      .get<{ stores: StoreOption[] }>(`/api/c/${companyId}/stores`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (body) => {
          if (generation !== this.generation) {
            return;
          }
          this.loadingStores.set(false);
          this.storesLoaded.set(true);
          this.stores.set(
            body.stores.filter(
              (store) => store.platform === 'prestashop' && store.status !== 'archived',
            ),
          );
        },
        error: (error: unknown) => {
          if (generation !== this.generation) {
            return;
          }
          this.loadingStores.set(false);
          this.storesLoaded.set(true);
          this.sectionError.set(this.failureText(error));
        },
      });
  }

  private loadConnection(generation: number, companyId: string, storeId: string): void {
    this.http
      .get<{ connection: ConnectionView | null }>(this.connectionUrl(companyId, storeId))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (body) => {
          if (generation !== this.generation) {
            return;
          }
          this.boundCompanyId = companyId;
          this.boundStoreId = storeId;
          this.applyConnection(body.connection);
          this.loaded.set(true);
        },
        error: (error: unknown) => {
          if (generation !== this.generation) {
            return;
          }
          this.sectionError.set(this.failureText(error));
        },
      });
  }

  private loadPrint(generation: number, companyId: string): void {
    this.http
      .get<{ keySet: boolean; keySetAt: string | null }>(
        `/api/c/${companyId}/print-accounts/printnode`,
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (body) => {
          if (generation !== this.printGeneration || companyId !== this.companyId()) {
            return;
          }
          this.printBoundCompanyId = companyId;
          this.printKey.set('');
          this.printKeySet.set(body.keySet);
          this.printKeySetAt.set(body.keySetAt);
          this.printLoaded.set(true);
        },
        error: (error: unknown) => {
          if (generation !== this.printGeneration) {
            return;
          }
          this.printError.set(this.failureText(error));
        },
      });
  }

  private postAction(action: 'activate' | 'pause'): void {
    const companyId = this.boundCompanyId;
    const storeId = this.boundStoreId;
    if (!companyId || !storeId || !this.canEdit() || !this.connection()) {
      return;
    }
    if (action === 'activate' && !this.canStart()) {
      return;
    }
    if (action === 'pause' && !this.canPause()) {
      return;
    }
    const generation = this.generation;
    this.busy.set(true);
    this.notice.set('');
    this.http
      .post<{ connection: ConnectionView }>(
        `${this.connectionUrl(companyId, storeId)}/${action}`,
        {},
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (body) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          this.applyConnection(body.connection);
        },
        error: (error: unknown) => {
          this.failShop(generation, error);
        },
      });
  }

  private applyConnection(connection: ConnectionView | null): void {
    this.connection.set(connection);
    this.key.set('');
    this.replacingKey.set(false);
    if (!connection) {
      this.baseUrl.set('');
      this.timezone.set(this.context.timezone());
      this.firstImportFrom.set('');
      this.pollMinutes.set('3');
      this.savedPollSeconds = null;
      this.status.set(null);
      this.lastTestResult.set(null);
      this.keySet.set(false);
      this.keySetAt.set(null);
      this.firstImportLocked.set(false);
      this.stateRows.set([]);
      this.carrierRows.set([]);
      return;
    }
    this.baseUrl.set(connection.settings.baseUrl);
    this.timezone.set(connection.settings.timezone);
    this.firstImportFrom.set(connection.settings.firstImportFrom);
    this.savedPollSeconds = connection.settings.pollIntervalSeconds;
    this.pollMinutes.set(formatMinutes(connection.settings.pollIntervalSeconds));
    this.status.set(connection.status);
    this.lastTestResult.set(connection.lastTestResult);
    this.keySet.set(connection.keySet);
    this.keySetAt.set(connection.keySetAt);
    this.firstImportLocked.set(connection.firstImportLocked);
    this.stateRows.set(
      Object.entries(connection.stateMap).map(([id, entry]) => ({
        id,
        name: id,
        payment: entry.payment,
        cancelled: entry.cancelled,
      })),
    );
    this.carrierRows.set(
      Object.entries(connection.carrierMap).map(([idReference, method]) => ({
        idReference,
        name: idReference,
        method,
      })),
    );
  }

  private mergeStates(shop: { id: string; name: string }[]): void {
    const current = new Map(this.stateRows().map((row) => [row.id, row]));
    const rows: StateRow[] = shop.map((state) => {
      const saved = current.get(state.id);
      current.delete(state.id);
      return saved
        ? { ...saved, name: state.name }
        : { id: state.id, name: state.name, payment: 'pending', cancelled: false };
    });
    for (const leftover of current.values()) {
      rows.push(leftover);
    }
    this.stateRows.set(rows);
  }

  private mergeCarriers(shop: { idReference: string; name: string }[]): void {
    const current = new Map(this.carrierRows().map((row) => [row.idReference, row]));
    const rows: CarrierRow[] = shop.map((carrier) => {
      const saved = current.get(carrier.idReference);
      current.delete(carrier.idReference);
      return saved
        ? { ...saved, name: carrier.name }
        : { idReference: carrier.idReference, name: carrier.name, method: 'unknown' };
    });
    for (const leftover of current.values()) {
      rows.push(leftover);
    }
    this.carrierRows.set(rows);
  }

  private connectionBody(): Record<string, unknown> {
    const pollIntervalSeconds = this.pollSeconds();
    const body: Record<string, unknown> = {
      baseUrl: this.baseUrl().trim(),
      timezone: this.timezone().trim(),
      firstImportFrom: this.firstImportFrom().trim(),
      ...(pollIntervalSeconds === null ? {} : { pollIntervalSeconds }),
    };
    const key = this.key().trim();
    if (key.length > 0) {
      body['key'] = key;
    }
    return body;
  }

  private pollSeconds(): number | null {
    const shown = this.pollMinutes().trim();
    if (this.savedPollSeconds !== null && shown === formatMinutes(this.savedPollSeconds)) {
      return this.savedPollSeconds;
    }
    const minutes = Number(shown);
    if (!Number.isFinite(minutes) || minutes < 2) {
      return null;
    }
    const seconds = Math.round(minutes * 60);
    if (!Number.isInteger(seconds) || seconds < 120) {
      return null;
    }
    return seconds;
  }

  private clearShopForm(): void {
    this.connection.set(null);
    this.baseUrl.set('');
    this.key.set('');
    this.replacingKey.set(false);
    this.timezone.set('');
    this.firstImportFrom.set('');
    this.pollMinutes.set('3');
    this.savedPollSeconds = null;
    this.status.set(null);
    this.lastTestResult.set(null);
    this.keySet.set(false);
    this.keySetAt.set(null);
    this.firstImportLocked.set(false);
    this.notice.set('');
    this.stateRows.set([]);
    this.carrierRows.set([]);
  }

  private clearPrint(): void {
    this.printKey.set('');
    this.printKeySet.set(false);
    this.printKeySetAt.set(null);
    this.printLoaded.set(false);
    this.printError.set('');
    this.printNotice.set('');
    this.printBusy.set(false);
    this.printBoundCompanyId = null;
  }

  private failShop(generation: number, error: unknown): void {
    if (generation !== this.generation) {
      return;
    }
    this.busy.set(false);
    this.notice.set(this.failureText(error));
  }

  private failLookup(generation: number, error: unknown): void {
    if (generation !== this.generation) {
      return;
    }
    this.busy.set(false);
    if (error instanceof HttpErrorResponse && error.status === 502) {
      const body: unknown = error.error;
      const errorClass =
        isRecord(body) && typeof body['errorClass'] === 'string' ? body['errorClass'] : 'bad_response';
      this.notice.set(this.errorSentence(errorClass));
      return;
    }
    this.notice.set(this.failureText(error));
  }

  private failPrint(generation: number, error: unknown): void {
    if (generation !== this.printGeneration) {
      return;
    }
    this.printBusy.set(false);
    this.printError.set(this.failureText(error));
  }

  private failureText(error: unknown): string {
    if (error instanceof HttpErrorResponse && error.status === 403) {
      return this.transloco.translate('integrations.forbidden');
    }
    if (error instanceof HttpErrorResponse) {
      const api = readApiError(error);
      const reason = api.code ?? api.message;
      const key = `integrations.reasons.${reason}`;
      const translated = this.transloco.translate(key);
      if (translated !== key) {
        return translated;
      }
    }
    return this.transloco.translate('integrations.loadError');
  }

  private errorSentence(errorClass: string, resource?: string): string {
    const key = `integrations.errors.${errorClass}`;
    const translated = this.transloco.translate(key);
    const sentence =
      translated === key ? this.transloco.translate('integrations.errors.bad_response') : translated;
    if (!resource) {
      return sentence;
    }
    return `${sentence} ${this.transloco.translate('integrations.resource', { resource })}`;
  }

  private connectionUrl(companyId: string, storeId: string): string {
    return `/api/c/${companyId}/stores/${storeId}/prestashop-connection`;
  }
}

function formatMinutes(seconds: number): string {
  const minutes = seconds / 60;
  return Number.isInteger(minutes) ? String(minutes) : String(minutes);
}

function paymentOf(value: string): PaymentStatus {
  return PAYMENT_STATUSES.find((status) => status === value) ?? 'pending';
}

function deliveryOf(value: string): DeliveryMethod {
  return DELIVERY_METHODS.find((method) => method === value) ?? 'unknown';
}

function readStates(body: unknown): { id: string; name: string }[] {
  if (!Array.isArray(body)) {
    return [];
  }
  return body.filter(isState);
}

function readCarriers(body: unknown): { idReference: string; name: string }[] {
  if (!Array.isArray(body)) {
    return [];
  }
  return body.filter(isCarrier);
}

function isState(value: unknown): value is { id: string; name: string } {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['name'] === 'string';
}

function isCarrier(value: unknown): value is { idReference: string; name: string } {
  return (
    isRecord(value) &&
    typeof value['idReference'] === 'string' &&
    typeof value['name'] === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function emptyParams(): { get: (name: string) => string | null } {
  return { get: () => null };
}
