import { HttpClient, HttpContext } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink, type ParamMap } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { TableModule } from 'primeng/table';
import { Tag } from 'primeng/tag';
import { Subject, combineLatest, debounceTime, of } from 'rxjs';
import { CompanyContextStore } from '../core/company-context.store';
import { canAttempt } from '../core/nav';
import { NAVIGATE_ON_DENIED } from '../core/navigate-on-denied';
import { ActiveLang } from '../format/active-lang';
import { MoneyPipe } from '../format/money.pipe';
import { fieldValue } from '../orders/field-value';
import type { PaymentState } from '../payments/payment-view';
import { type DeadlineState, companyToday, deadlineState } from './delivery-deadline';
import {
  type InvoiceQuery,
  calendarDate,
  defaultInvoiceQuery,
  invoicesHttpParams,
  invalidInvoiceFilters,
  isCanonicalInvoiceQuery,
  parseInvoiceQuery,
  serializeInvoiceQuery,
} from './invoice-query';

type InvoiceRow = {
  id: string;
  documentType: string;
  status: string;
  number?: string | null;
  clientDisplayName: string;
  currency: string;
  issueDate: string | null;
  dueDate: string | null;
  deliveryDeadline?: string | null;
  lastDeliveredOn?: string | null;
  total: string;
  openBalance?: string | null;
  paymentState?: PaymentState | null;
};

type ClientOption = { id: string; displayName: string };

@Component({
  selector: 'bp-invoice-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, RouterLink, TableModule, Tag, MoneyPipe],
  template: `
    <section class="screen">
      <header class="screen-heading">
        <h1>{{ 'invoices.title' | transloco }}</h1>
        @if (canDraft()) {
          <a class="text-action" [routerLink]="['/c', companyId(), 'invoices', 'new']">{{ 'invoices.new' | transloco }}</a>
        }
      </header>
      @if (rejected().length > 0) {
        <p role="alert">{{ 'common.invalidFilters' | transloco: { fields: rejectedText() } }}</p>
      }
      <form class="filters" (submit)="$event.preventDefault()">
        <label>
          {{ 'invoices.search' | transloco }}
          <input [value]="searchDraft()" (input)="onSearch($event)" />
        </label>
        <label>
          {{ 'invoices.filters.status' | transloco }}
          <select (change)="setStatus($event)">
            <option value="" [selected]="query().status === ''">{{ 'invoices.filters.any' | transloco }}</option>
            <option value="draft" [selected]="query().status === 'draft'">{{ 'invoices.status.draft' | transloco }}</option>
            <option value="issued" [selected]="query().status === 'issued'">{{ 'invoices.status.issued' | transloco }}</option>
            <option value="cancelled" [selected]="query().status === 'cancelled'">{{ 'invoices.status.cancelled' | transloco }}</option>
          </select>
        </label>
        <label>
          {{ 'invoices.filters.delivery' | transloco }}
          <select (change)="setDelivery($event)">
            <option value="" [selected]="query().delivery === ''">{{ 'invoices.filters.deliveryAny' | transloco }}</option>
            <option value="pending" [selected]="query().delivery === 'pending'">{{ 'invoices.filters.deliveryPending' | transloco }}</option>
          </select>
        </label>
        <label>
          {{ 'payments.filter' | transloco }}
          <select (change)="setPayment($event)">
            <option value="" [selected]="query().payment === ''">{{ 'invoices.filters.any' | transloco }}</option>
            <option value="open" [selected]="query().payment === 'open'">{{ 'payments.moneyOwing' | transloco }}</option>
          </select>
        </label>
        <label>
          {{ 'invoices.filters.client' | transloco }}
          <select (change)="setClient($event)">
            <option value="" [selected]="query().clientId === ''">{{ 'invoices.filters.anyClient' | transloco }}</option>
            @for (client of clients(); track client.id) {
              <option [value]="client.id" [selected]="client.id === query().clientId">{{ client.displayName }}</option>
            }
          </select>
        </label>
        <label>
          {{ 'invoices.filters.from' | transloco }}
          <input type="date" [value]="query().from" (change)="setFrom($event)" />
        </label>
        <label>
          {{ 'invoices.filters.to' | transloco }}
          <input type="date" [value]="query().to" (change)="setTo($event)" />
        </label>
      </form>
      @if (loading()) {
        <p role="status">{{ 'invoices.loading' | transloco }}</p>
      }
      @if (loadError()) {
        <p role="alert">{{ 'invoices.error' | transloco }}</p>
      }
      @if (!loading() && !loadError() && rows().length === 0) {
        <p>{{ 'invoices.empty' | transloco }}</p>
      }
      <div class="table-scroll">
        <p-table [value]="rows()">
          <ng-template pTemplate="header">
            <tr>
              <th>{{ 'invoices.columns.number' | transloco }}</th>
              <th>{{ 'invoices.columns.type' | transloco }}</th>
              <th>{{ 'invoices.columns.client' | transloco }}</th>
              <th>{{ 'invoices.columns.issueDate' | transloco }}</th>
              <th>{{ 'invoices.columns.dueDate' | transloco }}</th>
              <th>{{ 'invoices.columns.deadline' | transloco }}</th>
              <th>{{ 'invoices.columns.status' | transloco }}</th>
              <th>{{ 'payments.filter' | transloco }}</th>
              <th>{{ 'invoices.columns.total' | transloco }}</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-invoice>
            <tr>
              <td>
                <a [routerLink]="['/c', companyId(), 'invoices', invoice.id]">{{ invoice.number || (numberLabel(invoice.status) | transloco) }}</a>
              </td>
              <td>{{ typeLabel(invoice.documentType) | transloco }}</td>
              <td>{{ invoice.clientDisplayName }}</td>
              <td>{{ dateLabel(invoice.issueDate) }}</td>
              <td>{{ dateLabel(invoice.dueDate) }}</td>
              <td>
                {{ dateLabel(invoice.deliveryDeadline ?? null) }}
                @switch (deadline(invoice)) {
                  @case ('overdue') {
                    <p-tag severity="danger" [value]="'invoices.deadline.overdue' | transloco" />
                  }
                  @case ('soon') {
                    <p-tag severity="warn" [value]="'invoices.deadline.soon' | transloco" />
                  }
                }
              </td>
              <td><p-tag [value]="statusLabel(invoice.status) | transloco" [severity]="statusSeverity(invoice.status)" /></td>
              <td>
                @if (invoice.status === 'issued' && invoice.documentType === 'invoice' && invoice.paymentState) {
                  <p-tag [value]="'payments.states.' + invoice.paymentState | transloco" [severity]="invoice.paymentState === 'paid' ? 'success' : 'warn'" />
                  <p>{{ invoice.openBalance | money: invoice.currency : lang.code() }}</p>
                }
              </td>
              <td>{{ invoice.total | money: invoice.currency : lang.code() }}</td>
            </tr>
          </ng-template>
        </p-table>
      </div>
    </section>
  `,
})
export class InvoiceListPage {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly context = inject(CompanyContextStore);
  private readonly transloco = inject(TranslocoService);
  private readonly searchInput = new Subject<string>();
  readonly lang = inject(ActiveLang);

  readonly companyId = signal('');
  readonly query = signal<InvoiceQuery>(defaultInvoiceQuery());
  readonly searchDraft = signal('');
  readonly rejected = signal<string[]>([]);
  readonly rows = signal<InvoiceRow[]>([]);
  readonly clients = signal<ClientOption[]>([]);
  readonly loading = signal(false);
  readonly loadError = signal(false);
  private requestSeq = 0;
  private clientsFor: string | null = null;

  constructor() {
    this.searchInput.pipe(debounceTime(300), takeUntilDestroyed()).subscribe((q) => {
      if (q === this.query().q) {
        return;
      }
      this.navigate({ ...this.query(), q });
    });
    const companyId$ = this.route.parent?.paramMap ?? of(emptyParams());
    combineLatest([companyId$, this.route.queryParamMap])
      .pipe(takeUntilDestroyed())
      .subscribe(([company, query]) => {
        const companyId = company.get('companyId') ?? '';
        this.companyId.set(companyId);
        const parsed = parseInvoiceQuery(query);
        const invalid = invalidInvoiceFilters(query);
        this.query.set(parsed);
        this.searchDraft.set(parsed.q);
        this.rejected.set(invalid);
        if (invalid.length === 0 && !isCanonicalInvoiceQuery(query)) {
          void this.router.navigate([], {
            relativeTo: this.route,
            queryParams: serializeInvoiceQuery(parsed),
            replaceUrl: true,
          });
          return;
        }
        this.load(companyId, parsed);
      });
  }

  canDraft(): boolean {
    return canAttempt(
      this.context.grants(),
      this.context.withheldPermissions(),
      this.context.mfaStepUpRequired(),
      'invoice.draft',
    );
  }

  numberLabel(status: string): string {
    return status === 'draft' ? 'invoices.draft' : this.statusLabel(status);
  }

  typeLabel(documentType: string): string {
    if (documentType === 'credit_note') {
      return 'invoices.type.creditNote';
    }
    return documentType === 'quote' ? 'invoices.type.quote' : 'invoices.type.invoice';
  }

  statusLabel(status: string): string {
    if (status === 'issued') {
      return 'invoices.status.issued';
    }
    if (status === 'cancelled') {
      return 'invoices.status.cancelled';
    }
    return 'invoices.status.draft';
  }

  statusSeverity(status: string): 'success' | 'warn' | 'secondary' {
    if (status === 'issued') {
      return 'success';
    }
    if (status === 'cancelled') {
      return 'secondary';
    }
    return 'warn';
  }

  dateLabel(value: string | null): string {
    return calendarDate(value);
  }

  deadline(row: InvoiceRow): DeadlineState {
    if (row.status !== 'issued') {
      return 'none';
    }
    return deadlineState(
      row.deliveryDeadline ?? null,
      (row.lastDeliveredOn ?? null) !== null,
      companyToday(this.context.timezone()),
    );
  }

  setPayment(event: Event): void {
    this.navigate({ ...this.query(), payment: fieldValue(event) === 'open' ? 'open' : '' });
  }

  setDelivery(event: Event): void {
    this.navigate({ ...this.query(), delivery: fieldValue(event) === 'pending' ? 'pending' : '' });
  }

  onSearch(event: Event): void {
    const value = fieldValue(event);
    this.searchDraft.set(value);
    this.searchInput.next(value);
  }

  setStatus(event: Event): void {
    const value = fieldValue(event);
    const status = value === 'draft' || value === 'issued' || value === 'cancelled' ? value : '';
    this.navigate({ ...this.query(), status });
  }

  setClient(event: Event): void {
    this.navigate({ ...this.query(), clientId: fieldValue(event) });
  }

  setFrom(event: Event): void {
    this.navigate({ ...this.query(), from: fieldValue(event) });
  }

  setTo(event: Event): void {
    this.navigate({ ...this.query(), to: fieldValue(event) });
  }

  load(companyId: string, params: InvoiceQuery): void {
    if (companyId.length === 0) {
      this.loading.set(false);
      return;
    }
    this.loadClients(companyId);
    const seq = ++this.requestSeq;
    this.loading.set(true);
    this.loadError.set(false);
    this.http
      .get<{ invoices: InvoiceRow[] }>(`/api/c/${companyId}/invoices`, {
        params: invoicesHttpParams(params),
        context: new HttpContext().set(NAVIGATE_ON_DENIED, true),
      })
      .subscribe({
        next: (body) => {
          if (seq !== this.requestSeq) {
            return;
          }
          this.rows.set(body.invoices);
          this.loading.set(false);
        },
        error: () => {
          if (seq !== this.requestSeq) {
            return;
          }
          this.loading.set(false);
          this.loadError.set(true);
        },
      });
  }

  private loadClients(companyId: string): void {
    if (this.clientsFor === companyId) {
      return;
    }
    this.clientsFor = companyId;
    this.http.get<{ clients: ClientOption[] }>(`/api/c/${companyId}/clients`).subscribe({
      next: (body) => {
        if (this.clientsFor === companyId) {
          this.clients.set(body.clients);
        }
      },
      error: () => {
        if (this.clientsFor === companyId) {
          this.clients.set([]);
        }
      },
    });
  }

  rejectedText(): string {
    const labels: Record<string, string> = {
      q: 'invoices.search',
      status: 'invoices.filters.status',
      delivery: 'invoices.filters.delivery',
      payment: 'payments.filter',
      clientId: 'invoices.filters.client',
      from: 'invoices.filters.from',
      to: 'invoices.filters.to',
    };
    return this.rejected()
      .map((key) => this.transloco.translate(labels[key] ?? key))
      .join(', ');
  }

  private navigate(next: InvoiceQuery): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: serializeInvoiceQuery(next) });
  }
}

function emptyParams(): ParamMap {
  return { has: () => false, get: () => null, getAll: () => [], keys: [] };
}
