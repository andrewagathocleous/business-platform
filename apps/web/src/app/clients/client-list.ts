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
import { fieldValue } from '../orders/field-value';
import {
  type ClientQuery,
  clientsHttpParams,
  defaultClientQuery,
  invalidClientFilters,
  isCanonicalClientQuery,
  parseClientQuery,
  serializeClientQuery,
} from './client-query';

export type ClientRow = {
  id: string;
  kind: 'organisation' | 'individual';
  displayName: string;
  email: string | null;
  phone: string | null;
  vatNumber: string | null;
  archivedAt: string | null;
};

@Component({
  selector: 'bp-client-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, RouterLink, TableModule, Tag],
  template: `
    <section class="screen">
      <header class="screen-heading">
        <h1>{{ 'clients.title' | transloco }}</h1>
        @if (canManage()) {
          <a class="text-action" [routerLink]="['/c', companyId(), 'clients', 'new']">{{ 'clients.new' | transloco }}</a>
        }
      </header>
      @if (rejected().length > 0) {
        <p role="alert">{{ 'common.invalidFilters' | transloco: { fields: rejectedText() } }}</p>
      }
      <form class="filters" (submit)="$event.preventDefault()">
        <label>
          {{ 'clients.search' | transloco }}
          <input [value]="searchDraft()" (input)="onSearch($event)" />
        </label>
        <label class="check">
          <input
            type="checkbox"
            [checked]="query().includeArchived"
            (change)="setArchived($event)"
          />
          {{ 'clients.includeArchived' | transloco }}
        </label>
      </form>
      @if (loading()) {
        <p role="status">{{ 'clients.loading' | transloco }}</p>
      }
      @if (error()) {
        <p role="alert">{{ 'clients.error' | transloco }}</p>
      }
      @if (!loading() && !error() && rows().length === 0) {
        <p>{{ 'clients.empty' | transloco }}</p>
      }
      <div class="table-scroll">
        <p-table [value]="rows()">
          <ng-template pTemplate="header">
            <tr>
              <th>{{ 'clients.columns.name' | transloco }}</th>
              <th>{{ 'clients.columns.kind' | transloco }}</th>
              <th>{{ 'clients.columns.email' | transloco }}</th>
              <th>{{ 'clients.columns.phone' | transloco }}</th>
              <th>{{ 'clients.columns.vat' | transloco }}</th>
              <th>{{ 'clients.columns.archived' | transloco }}</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-client>
            <tr>
              <td><a [routerLink]="['/c', companyId(), 'clients', client.id]">{{ client.displayName }}</a></td>
              <td>{{ kindLabel(client.kind) | transloco }}</td>
              <td>{{ client.email }}</td>
              <td>{{ client.phone }}</td>
              <td>{{ client.vatNumber }}</td>
              <td>
                @if (client.archivedAt) {
                  <p-tag [value]="'clients.archived' | transloco" severity="secondary" />
                }
              </td>
            </tr>
          </ng-template>
        </p-table>
      </div>
    </section>
  `,
})
export class ClientListPage {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly context = inject(CompanyContextStore);
  private readonly transloco = inject(TranslocoService);
  private readonly searchInput = new Subject<string>();

  readonly companyId = signal('');
  readonly query = signal<ClientQuery>(defaultClientQuery());
  readonly searchDraft = signal('');
  readonly rejected = signal<string[]>([]);
  readonly rows = signal<ClientRow[]>([]);
  readonly loading = signal(false);
  readonly error = signal(false);
  private requestSeq = 0;

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
        const parsed = parseClientQuery(query);
        const invalid = invalidClientFilters(query);
        this.query.set(parsed);
        this.searchDraft.set(parsed.q);
        this.rejected.set(invalid);
        if (invalid.length === 0 && !isCanonicalClientQuery(query)) {
          void this.router.navigate([], {
            relativeTo: this.route,
            queryParams: serializeClientQuery(parsed),
            replaceUrl: true,
          });
          return;
        }
        this.load(companyId, parsed);
      });
  }

  canManage(): boolean {
    return canAttempt(
      this.context.grants(),
      this.context.withheldPermissions(),
      this.context.mfaStepUpRequired(),
      'client.manage',
    );
  }

  kindLabel(kind: string): string {
    return kind === 'individual' ? 'clients.kind.individual' : 'clients.kind.organisation';
  }

  onSearch(event: Event): void {
    const value = fieldValue(event);
    this.searchDraft.set(value);
    this.searchInput.next(value);
  }

  setArchived(event: Event): void {
    const target = event.target;
    const includeArchived = target instanceof HTMLInputElement ? target.checked : false;
    this.navigate({ ...this.query(), includeArchived });
  }

  load(companyId: string, params: ClientQuery): void {
    if (companyId.length === 0) {
      this.loading.set(false);
      return;
    }
    const seq = ++this.requestSeq;
    this.loading.set(true);
    this.error.set(false);
    this.http
      .get<{ clients: ClientRow[] }>(`/api/c/${companyId}/clients`, {
        params: clientsHttpParams(params),
        context: new HttpContext().set(NAVIGATE_ON_DENIED, true),
      })
      .subscribe({
        next: (body) => {
          if (seq !== this.requestSeq) {
            return;
          }
          this.rows.set(body.clients);
          this.loading.set(false);
        },
        error: () => {
          if (seq !== this.requestSeq) {
            return;
          }
          this.loading.set(false);
          this.error.set(true);
        },
      });
  }

  rejectedText(): string {
    const labels: Record<string, string> = {
      q: 'clients.search',
      includeArchived: 'clients.includeArchived',
    };
    return this.rejected()
      .map((key) => this.transloco.translate(labels[key] ?? key))
      .join(', ');
  }

  private navigate(next: ClientQuery): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: serializeClientQuery(next) });
  }
}

function emptyParams(): ParamMap {
  return { has: () => false, get: () => null, getAll: () => [], keys: [] };
}
