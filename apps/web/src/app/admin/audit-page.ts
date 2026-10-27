import { HttpClient, HttpContext } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, type ParamMap } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { Tag } from 'primeng/tag';
import { Subject, combineLatest, debounceTime, of } from 'rxjs';
import { clipboardWrite } from '../core/clipboard';
import { CompanyContextStore } from '../core/company-context.store';
import { NAVIGATE_ON_DENIED } from '../core/navigate-on-denied';
import { ActiveLang } from '../format/active-lang';
import { CompanyDatePipe } from '../format/company-date.pipe';
import { fieldValue } from '../orders/field-value';
import { auditDetailsText } from './audit-details';
import {
  AUDIT_PAGE_SIZE,
  type AuditQuery,
  auditHttpParams,
  defaultAuditQuery,
  invalidAuditFilters,
  isCanonicalAuditQuery,
  parseAuditQuery,
  serializeAuditQuery,
} from './audit-query';

type AuditEvent = {
  id: string;
  occurredAt: string;
  actorLabel: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: string;
  correlationId: string;
  details: unknown;
};

@Component({
  selector: 'bp-audit-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, Button, Tag, CompanyDatePipe],
  template: `
    <section class="screen">
      <h1>{{ 'audit.title' | transloco }}</h1>
      @if (rejected().length > 0) {
        <p role="alert">{{ 'common.invalidFilters' | transloco: { fields: rejectedText() } }}</p>
      }
      <form class="filters" (submit)="$event.preventDefault()">
        <label>
          {{ 'audit.filters.action' | transloco }}
          <input [value]="draft().action" (input)="onText('action', $event)" />
        </label>
        <label>
          {{ 'audit.filters.objectType' | transloco }}
          <input [value]="draft().objectType" (input)="onText('objectType', $event)" />
        </label>
        <label>
          {{ 'audit.filters.objectId' | transloco }}
          <input [value]="draft().objectId" (input)="onText('objectId', $event)" />
        </label>
        <label>
          {{ 'audit.filters.actor' | transloco }}
          <input [value]="draft().actorId" (input)="onText('actorId', $event)" />
        </label>
        <label>
          {{ 'audit.filters.outcome' | transloco }}
          <select (change)="setOutcome($event)">
            <option value="" [selected]="query().outcome === ''">{{ 'audit.anyOutcome' | transloco }}</option>
            <option value="success" [selected]="query().outcome === 'success'">{{ 'audit.outcome.success' | transloco }}</option>
            <option value="denied" [selected]="query().outcome === 'denied'">{{ 'audit.outcome.denied' | transloco }}</option>
            <option value="failure" [selected]="query().outcome === 'failure'">{{ 'audit.outcome.failure' | transloco }}</option>
          </select>
        </label>
        <label>
          {{ 'audit.filters.from' | transloco }}
          <input type="date" [value]="query().from" (change)="setDate('from', $event)" />
        </label>
        <label>
          {{ 'audit.filters.to' | transloco }}
          <input type="date" [value]="query().to" (change)="setDate('to', $event)" />
        </label>
      </form>
      @if (loading()) {
        <p role="status">{{ 'audit.loading' | transloco }}</p>
      }
      @if (loadError()) {
        <p role="alert">{{ 'audit.error' | transloco }}</p>
      }
      <div class="table-scroll table-fit audit-table">
        <table class="items">
          <thead>
            <tr>
              <th>{{ 'audit.columns.time' | transloco }}</th>
              <th>{{ 'audit.columns.actor' | transloco }}</th>
              <th>{{ 'audit.columns.action' | transloco }}</th>
              <th>{{ 'audit.columns.object' | transloco }}</th>
              <th>{{ 'audit.columns.outcome' | transloco }}</th>
              <th>{{ 'audit.columns.correlation' | transloco }}</th>
              <th>{{ 'audit.columns.details' | transloco }}</th>
            </tr>
          </thead>
          <tbody>
            @for (event of events(); track event.id) {
              <tr>
                <td>{{ event.occurredAt | companyDate: context.timezone() : lang.code() }}</td>
                <td>{{ event.actorLabel }}</td>
                <td>{{ event.action }}</td>
                <td>
                  <div>{{ event.objectType }}</div>
                  @if (event.objectId) {
                    <div class="id-line">
                      <span class="id-text" [attr.title]="event.objectId">{{ shortId(event.objectId) }}</span>
                      <p-button
                        type="button"
                        size="small"
                        severity="secondary"
                        [label]="'audit.copy' | transloco"
                        [ariaLabel]="'audit.copyObject' | transloco"
                        (onClick)="copyValue(event.objectId)"
                      />
                    </div>
                  }
                </td>
                <td>
                  <p-tag [value]="outcomeLabel(event.outcome) | transloco" [severity]="outcomeSeverity(event.outcome)" />
                </td>
                <td>
                  <div class="id-line">
                    <span class="id-text" [attr.title]="event.correlationId">{{ shortId(event.correlationId) }}</span>
                    <p-button
                      type="button"
                      size="small"
                      severity="secondary"
                      [label]="'audit.copy' | transloco"
                      [ariaLabel]="'audit.copyCorrelation' | transloco"
                      (onClick)="copyValue(event.correlationId)"
                    />
                  </div>
                </td>
                <td>
                  <p-button
                    type="button"
                    size="small"
                    severity="secondary"
                    [label]="'audit.details' | transloco"
                    (onClick)="toggle(event.id)"
                  />
                </td>
              </tr>
              @if (isOpen(event.id)) {
                <tr>
                  <td colspan="7"><pre>{{ details(event.details) }}</pre></td>
                </tr>
              }
            }
          </tbody>
        </table>
      </div>
      <div class="actions">
        <p-button
          type="button"
          severity="secondary"
          [label]="'common.previous' | transloco"
          [disabled]="query().offset === 0"
          (onClick)="page(-1)"
        />
        <p-button
          type="button"
          severity="secondary"
          [label]="'common.next' | transloco"
          [disabled]="!hasMore()"
          (onClick)="page(1)"
        />
      </div>
    </section>
  `,
})
export class AuditPage {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly textInput = new Subject<void>();
  private readonly transloco = inject(TranslocoService);
  readonly context = inject(CompanyContextStore);
  readonly lang = inject(ActiveLang);

  readonly companyId = signal('');
  readonly query = signal<AuditQuery>(defaultAuditQuery());
  readonly rejected = signal<string[]>([]);
  readonly draft = signal<AuditQuery>(defaultAuditQuery());
  readonly events = signal<AuditEvent[]>([]);
  readonly hasMore = signal(false);
  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly expanded = signal<readonly string[]>([]);
  private requestSeq = 0;

  constructor() {
    this.textInput.pipe(debounceTime(300), takeUntilDestroyed()).subscribe(() => {
      const draft = this.draft();
      const current = this.query();
      if (
        draft.action === current.action &&
        draft.objectType === current.objectType &&
        draft.objectId === current.objectId &&
        draft.actorId === current.actorId
      ) {
        return;
      }
      this.navigate({ ...current, ...textFields(draft), offset: 0 });
    });
    const companyId$ = this.route.parent?.paramMap ?? of(emptyParams());
    combineLatest([companyId$, this.route.queryParamMap])
      .pipe(takeUntilDestroyed())
      .subscribe(([company, query]) => {
        const companyId = company.get('companyId') ?? '';
        this.companyId.set(companyId);
        const parsed = parseAuditQuery(query);
        const invalid = invalidAuditFilters(query);
        this.query.set(parsed);
        this.draft.set(parsed);
        this.rejected.set(invalid);
        if (invalid.length === 0 && !isCanonicalAuditQuery(query)) {
          void this.router.navigate([], {
            relativeTo: this.route,
            queryParams: serializeAuditQuery(parsed),
            replaceUrl: true,
          });
          return;
        }
        this.load(companyId, parsed);
      });
  }

  outcomeLabel(outcome: string): string {
    if (outcome === 'denied') {
      return 'audit.outcome.denied';
    }
    if (outcome === 'failure') {
      return 'audit.outcome.failure';
    }
    return 'audit.outcome.success';
  }

  outcomeSeverity(outcome: string): 'success' | 'warn' | 'danger' {
    if (outcome === 'denied') {
      return 'warn';
    }
    if (outcome === 'failure') {
      return 'danger';
    }
    return 'success';
  }

  details(value: unknown): string {
    return auditDetailsText(value);
  }

  shortId(value: string | null): string {
    if (!value) {
      return '';
    }
    return `…${value.slice(-8)}`;
  }

  copyValue(value: string | null): void {
    if (!value) {
      return;
    }
    const write = clipboardWrite();
    if (!write) {
      return;
    }
    void write(value).catch(() => undefined);
  }

  isOpen(id: string): boolean {
    return this.expanded().includes(id);
  }

  toggle(id: string): void {
    this.expanded.update((ids) => (ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]));
  }

  onText(field: 'action' | 'objectType' | 'objectId' | 'actorId', event: Event): void {
    const value = fieldValue(event);
    this.draft.update((draft) => ({ ...draft, [field]: value }));
    this.textInput.next();
  }

  setOutcome(event: Event): void {
    const value = fieldValue(event);
    const outcome = value === 'success' || value === 'denied' || value === 'failure' ? value : '';
    this.navigate({ ...this.query(), outcome, offset: 0 });
  }

  setDate(field: 'from' | 'to', event: Event): void {
    this.navigate({ ...this.query(), [field]: fieldValue(event), offset: 0 });
  }

  page(direction: -1 | 1): void {
    const offset = this.query().offset + direction * AUDIT_PAGE_SIZE;
    this.navigate({ ...this.query(), offset: offset < 0 ? 0 : offset });
  }

  private load(companyId: string, query: AuditQuery): void {
    if (companyId.length === 0) {
      this.loading.set(false);
      return;
    }
    const seq = ++this.requestSeq;
    this.loading.set(true);
    this.loadError.set(false);
    this.http
      .get<{ events: AuditEvent[]; hasMore: boolean }>(`/api/c/${companyId}/audit-events`, {
        params: auditHttpParams(query, this.context.timezone()),
        context: new HttpContext().set(NAVIGATE_ON_DENIED, true),
      })
      .subscribe({
        next: (body) => {
          if (seq !== this.requestSeq) {
            return;
          }
          this.events.set(body.events);
          this.hasMore.set(body.hasMore);
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

  rejectedText(): string {
    const labels: Record<string, string> = {
      action: 'audit.filters.action',
      objectType: 'audit.filters.objectType',
      objectId: 'audit.filters.objectId',
      actor: 'audit.filters.actor',
      outcome: 'audit.filters.outcome',
      from: 'audit.filters.from',
      to: 'audit.filters.to',
    };
    return this.rejected()
      .map((key) => this.transloco.translate(labels[key] ?? key))
      .join(', ');
  }

  private navigate(next: AuditQuery): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: serializeAuditQuery(next) });
  }
}

function textFields(draft: AuditQuery): Pick<AuditQuery, 'action' | 'objectType' | 'objectId' | 'actorId'> {
  return {
    action: draft.action,
    objectType: draft.objectType,
    objectId: draft.objectId,
    actorId: draft.actorId,
  };
}

function emptyParams(): ParamMap {
  return { has: () => false, get: () => null, getAll: () => [], keys: [] };
}
