import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink, type ParamMap } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { TableModule, type TableLazyLoadEvent } from 'primeng/table';
import { Subject, combineLatest, debounceTime, of } from 'rxjs';
import { CompanyContextStore } from '../core/company-context.store';
import { NAVIGATE_ON_DENIED } from '../core/navigate-on-denied';
import { ActiveLang } from '../format/active-lang';
import { CompanyDatePipe } from '../format/company-date.pipe';
import { MoneyPipe } from '../format/money.pipe';
import { fieldValue } from './field-value';
import { FULFILMENT_STATUSES, PAYMENT_STATUSES, reviewCodes, translateCode } from './labels';
import type { OrderListResponse, OrderSummary, StoreFilter } from './models';
import {
  type OrderQuery,
  defaultOrderQuery,
  isSortField,
  isCanonicalOrderQuery,
  ordersHttpParams,
  parseOrderQuery,
  serializeOrderQuery,
} from './order-query';
import { StatusTagsComponent } from './status-tags';

@Component({
  selector: 'bp-order-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, RouterLink, TableModule, MoneyPipe, CompanyDatePipe, StatusTagsComponent],
  template: `
    <section class="orders-page">
      <h1>{{ 'orders.title' | transloco }}</h1>
      <form class="order-filters" (submit)="$event.preventDefault()">
        <label>
          {{ 'orders.search' | transloco }}
          <input [value]="searchDraft()" (input)="onSearch($event)" />
        </label>
        <fieldset>
          <legend>{{ 'orders.filters.fulfilment' | transloco }}</legend>
          @for (status of fulfilmentStatuses; track status) {
            <button
              type="button"
              [attr.aria-pressed]="pressed(query().fulfilmentStatus, status)"
              (click)="toggleFulfilment(status)"
            >
              {{ label('orders.fulfilment', status) }}
            </button>
          }
        </fieldset>
        <fieldset>
          <legend>{{ 'orders.filters.payment' | transloco }}</legend>
          @for (status of paymentStatuses; track status) {
            <button
              type="button"
              [attr.aria-pressed]="pressed(query().paymentStatus, status)"
              (click)="togglePayment(status)"
            >
              {{ label('orders.payment', status) }}
            </button>
          }
        </fieldset>
        @if (stores().length > 1) {
          <label>
            {{ 'orders.filters.store' | transloco }}
            <select (change)="setStore($event)">
              <option value="" [selected]="query().storeId === ''">{{ 'orders.filters.allStores' | transloco }}</option>
              @for (store of stores(); track store.id) {
                <option [value]="store.id" [selected]="store.id === query().storeId">{{ store.name }}</option>
              }
            </select>
          </label>
        }
        <label>
          {{ 'orders.filters.assigned' | transloco }}
          <select (change)="setAssigned($event)">
            <option value="any" [selected]="query().assigned === 'any'">{{ 'orders.filters.any' | transloco }}</option>
            <option value="me" [selected]="query().assigned === 'me'">{{ 'orders.filters.me' | transloco }}</option>
            <option value="none" [selected]="query().assigned === 'none'">{{ 'orders.filters.none' | transloco }}</option>
          </select>
        </label>
        <label>
          {{ 'orders.filters.from' | transloco }}
          <input type="date" [value]="query().from" (change)="setFrom($event)" />
        </label>
        <label>
          {{ 'orders.filters.to' | transloco }}
          <input type="date" [value]="query().to" (change)="setTo($event)" />
        </label>
      </form>
      @if (loading()) {
        <p role="status">{{ 'orders.loading' | transloco }}</p>
      }
      @if (error()) {
        <p role="alert">{{ 'orders.error' | transloco }}</p>
      }
      @if (!loading() && !error() && total() === 0) {
        <p>{{ 'orders.empty' | transloco }}</p>
      }
      <div class="order-cards">
        @for (order of rows(); track order.id) {
          <article class="order-card" [class.review-row]="order.fulfilmentStatus === 'review_required'">
            <p>
              <a [routerLink]="['/c', companyId(), 'orders', order.id]">{{ order.externalNumber }}</a>
            </p>
            <p>{{ order.sourceCreatedAt | companyDate: context.timezone() : lang.code() }}</p>
            <p>{{ customerName(order) }}</p>
            <p>{{ storeName(order.storeId) }}</p>
            <bp-status-tags
              [paymentStatus]="order.paymentStatus"
              [fulfilmentStatus]="order.fulfilmentStatus"
              [integrationStatus]="order.integrationStatus"
            />
            @if (order.fulfilmentStatus === 'review_required') {
              <p class="review-flag">
                <span class="pi pi-exclamation-triangle" aria-hidden="true"></span>
                {{ 'orders.reviewRequired' | transloco }}
              </p>
            }
            @if (reasons(order).length > 0) {
              <p class="review-reason">
                @for (code of reasons(order); track code) {
                  <span>{{ label('orders.review', code) }}</span>
                }
              </p>
            }
            <p>
              <span class="card-label">{{ 'orders.columns.delivery' | transloco }}</span>
              {{ label('orders.delivery', order.deliveryMethod) }}
            </p>
            <p>
              <span class="card-label">{{ 'orders.columns.total' | transloco }}</span>
              {{ order.total | money: order.currency : lang.code() }}
            </p>
            <p>
              <span class="card-label">{{ 'orders.columns.assignee' | transloco }}</span>
              {{ order.assignedTo?.displayName ?? ('orders.unassigned' | transloco) }}
            </p>
          </article>
        }
        @if (total() > query().pageSize) {
          <div class="pager">
            <button type="button" [disabled]="query().page <= 1" (click)="previousPage()">
              {{ 'orders.previous' | transloco }}
            </button>
            <button type="button" [disabled]="query().page * query().pageSize >= total()" (click)="nextPage()">
              {{ 'orders.next' | transloco }}
            </button>
          </div>
        }
      </div>
      <div class="table-scroll order-table">
        <p-table
          [value]="rows()"
          [lazy]="true"
          [lazyLoadOnInit]="false"
          [paginator]="true"
          [rows]="query().pageSize"
          [first]="firstRow()"
          [totalRecords]="total()"
          [rowsPerPageOptions]="pageSizes"
          [sortField]="query().sortField"
          [sortOrder]="query().sortDirection === 'asc' ? 1 : -1"
          [showFirstLastIcon]="false"
          (onLazyLoad)="onLazy($event)"
        >
          <ng-template pTemplate="header">
            <tr>
              <th pSortableColumn="externalNumber">
                {{ 'orders.columns.number' | transloco }} <p-sortIcon field="externalNumber" />
              </th>
              <th pSortableColumn="sourceCreatedAt">
                {{ 'orders.columns.created' | transloco }} <p-sortIcon field="sourceCreatedAt" />
              </th>
              <th>{{ 'orders.columns.customer' | transloco }}</th>
              <th>{{ 'orders.columns.store' | transloco }}</th>
              <th pSortableColumn="paymentStatus">
                {{ 'orders.columns.payment' | transloco }} <p-sortIcon field="paymentStatus" />
              </th>
              <th pSortableColumn="fulfilmentStatus">
                {{ 'orders.columns.fulfilment' | transloco }} <p-sortIcon field="fulfilmentStatus" />
              </th>
              <th>{{ 'orders.columns.integration' | transloco }}</th>
              <th>{{ 'orders.columns.delivery' | transloco }}</th>
              <th pSortableColumn="total">
                {{ 'orders.columns.total' | transloco }} <p-sortIcon field="total" />
              </th>
              <th>{{ 'orders.columns.assignee' | transloco }}</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-order>
            <tr [class.review-row]="order.fulfilmentStatus === 'review_required'">
              <td>
                <a [routerLink]="['/c', companyId(), 'orders', order.id]">{{ order.externalNumber }}</a>
                @if (order.fulfilmentStatus === 'review_required') {
                  <p class="review-flag">
                    <span class="pi pi-exclamation-triangle" aria-hidden="true"></span>
                    {{ 'orders.reviewRequired' | transloco }}
                  </p>
                }
              </td>
              <td>{{ order.sourceCreatedAt | companyDate: context.timezone() : lang.code() }}</td>
              <td>{{ customerName(order) }}</td>
              <td>{{ storeName(order.storeId) }}</td>
              <td colspan="3">
                <bp-status-tags
                  [paymentStatus]="order.paymentStatus"
                  [fulfilmentStatus]="order.fulfilmentStatus"
                  [integrationStatus]="order.integrationStatus"
                />
                @if (reasons(order).length > 0) {
                  <p class="review-reason">
                    @for (code of reasons(order); track code) {
                      <span>{{ label('orders.review', code) }}</span>
                    }
                  </p>
                }
              </td>
              <td>{{ label('orders.delivery', order.deliveryMethod) }}</td>
              <td>{{ order.total | money: order.currency : lang.code() }}</td>
              <td>{{ order.assignedTo?.displayName ?? ('orders.unassigned' | transloco) }}</td>
            </tr>
          </ng-template>
          <ng-template pTemplate="paginatorpreviouspagelinkicon">{{ 'orders.previous' | transloco }}</ng-template>
          <ng-template pTemplate="paginatornextpagelinkicon">{{ 'orders.next' | transloco }}</ng-template>
        </p-table>
      </div>
    </section>
  `,
})
export class OrderListPage {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly transloco = inject(TranslocoService);
  private readonly searchInput = new Subject<string>();
  readonly context = inject(CompanyContextStore);
  readonly lang = inject(ActiveLang);

  readonly fulfilmentStatuses = FULFILMENT_STATUSES;
  readonly paymentStatuses = PAYMENT_STATUSES;
  readonly pageSizes = [25, 50, 100];
  readonly companyId = signal('');
  readonly query = signal<OrderQuery>(defaultOrderQuery());
  readonly searchDraft = signal('');
  readonly rows = signal<OrderSummary[]>([]);
  readonly total = signal(0);
  readonly stores = signal<StoreFilter[]>([]);
  readonly loading = signal(false);
  readonly error = signal(false);
  private requestSeq = 0;
  private storesFor: string | null = null;

  constructor() {
    this.searchInput.pipe(debounceTime(300), takeUntilDestroyed()).subscribe((q) => {
      if (q === this.query().q) {
        return;
      }
      this.navigate({ ...this.query(), q, page: 1 });
    });
    const companyId$ = this.route.parent?.paramMap ?? of(emptyParams());
    combineLatest([companyId$, this.route.queryParamMap])
      .pipe(takeUntilDestroyed())
      .subscribe(([company, query]) => {
        const companyId = company.get('companyId') ?? '';
        this.companyId.set(companyId);
        const parsed = parseOrderQuery(query);
        this.query.set(parsed);
        this.searchDraft.set(parsed.q);
        if (!isCanonicalOrderQuery(query)) {
          void this.router.navigate([], {
            relativeTo: this.route,
            queryParams: serializeOrderQuery(parsed),
            replaceUrl: true,
          });
          return;
        }
        this.load(companyId, parsed);
      });
  }

  firstRow(): number {
    return (this.query().page - 1) * this.query().pageSize;
  }

  pressed(selected: readonly string[], status: string): string {
    return selected.includes(status) ? 'true' : 'false';
  }

  label(prefix: string, code: string): string {
    return translateCode(this.transloco, prefix, code);
  }

  customerName(order: OrderSummary): string {
    return order.customer?.displayName ?? this.transloco.translate('orders.noName');
  }

  storeName(storeId: string): string {
    return this.stores().find((store) => store.id === storeId)?.name ?? '';
  }

  reasons(order: OrderSummary): string[] {
    return reviewCodes(order);
  }

  onSearch(event: Event): void {
    const value = fieldValue(event);
    this.searchDraft.set(value);
    this.searchInput.next(value);
  }

  toggleFulfilment(status: string): void {
    this.navigate({ ...this.query(), fulfilmentStatus: toggle(this.query().fulfilmentStatus, status), page: 1 });
  }

  togglePayment(status: string): void {
    this.navigate({ ...this.query(), paymentStatus: toggle(this.query().paymentStatus, status), page: 1 });
  }

  setStore(event: Event): void {
    this.navigate({ ...this.query(), storeId: fieldValue(event), page: 1 });
  }

  setAssigned(event: Event): void {
    const value = fieldValue(event);
    const assigned = value === 'me' || value === 'none' ? value : 'any';
    this.navigate({ ...this.query(), assigned, page: 1 });
  }

  setFrom(event: Event): void {
    this.navigate({ ...this.query(), from: fieldValue(event), page: 1 });
  }

  setTo(event: Event): void {
    this.navigate({ ...this.query(), to: fieldValue(event), page: 1 });
  }

  previousPage(): void {
    if (this.query().page <= 1) {
      return;
    }
    this.navigate({ ...this.query(), page: this.query().page - 1 });
  }

  nextPage(): void {
    if (this.query().page * this.query().pageSize >= this.total()) {
      return;
    }
    this.navigate({ ...this.query(), page: this.query().page + 1 });
  }

  onLazy(event: TableLazyLoadEvent): void {
    const rows = event.rows;
    const pageSize = rows === 25 || rows === 50 || rows === 100 ? rows : this.query().pageSize;
    const page = Math.floor((event.first ?? 0) / pageSize) + 1;
    const rawField = Array.isArray(event.sortField) ? event.sortField[0] : event.sortField;
    const sortField = isSortField(rawField) ? rawField : this.query().sortField;
    const sortDirection = event.sortOrder === 1 ? 'asc' : 'desc';
    const current = this.query();
    if (
      page === current.page &&
      pageSize === current.pageSize &&
      sortField === current.sortField &&
      sortDirection === current.sortDirection
    ) {
      return;
    }
    this.navigate({ ...current, page, pageSize, sortField, sortDirection });
  }

  load(companyId: string, params: OrderQuery): void {
    if (companyId.length === 0) {
      this.loading.set(false);
      return;
    }
    this.loadStores(companyId);
    const seq = ++this.requestSeq;
    this.loading.set(true);
    this.error.set(false);
    this.http
      .get<OrderListResponse>(`/api/c/${companyId}/orders`, {
        params: ordersHttpParams(params),
        context: new HttpContext().set(NAVIGATE_ON_DENIED, true),
      })
      .subscribe({
        next: (body) => {
          if (seq !== this.requestSeq) {
            return;
          }
          this.rows.set(body.orders);
          this.total.set(body.total);
          this.loading.set(false);
        },
        error: (error: unknown) => {
          if (seq !== this.requestSeq) {
            return;
          }
          this.loading.set(false);
          if (
            error instanceof HttpErrorResponse &&
            error.status === 400 &&
            this.route.snapshot.queryParamMap.keys.length > 0
          ) {
            void this.router.navigate([], { relativeTo: this.route, queryParams: {} });
            return;
          }
          this.error.set(true);
        },
      });
  }

  private loadStores(companyId: string): void {
    if (this.storesFor === companyId) {
      return;
    }
    this.storesFor = companyId;
    this.http.get<{ stores: StoreFilter[] }>(`/api/c/${companyId}/order-filters`).subscribe({
      next: (body) => {
        if (this.storesFor === companyId) {
          this.stores.set(body.stores);
        }
      },
      error: () => {
        if (this.storesFor === companyId) {
          this.stores.set([]);
        }
      },
    });
  }

  private navigate(next: OrderQuery): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: serializeOrderQuery(next) });
  }
}

function toggle(selected: readonly string[], status: string): string[] {
  return selected.includes(status) ? selected.filter((item) => item !== status) : [...selected, status];
}

function emptyParams(): ParamMap {
  return {
    has: () => false,
    get: () => null,
    getAll: () => [],
    keys: [],
  };
}
