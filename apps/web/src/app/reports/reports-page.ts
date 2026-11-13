import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import type { Observable } from 'rxjs';
import { CompanyContextStore } from '../core/company-context.store';
import { companyToday } from '../invoices/delivery-deadline';
import { fieldValue } from '../orders/field-value';
import { AccountantExport } from './accountant-export';
import {
  asOfProblem,
  periodProblem,
  reportFailure,
  type AgeingReport,
  type CollectedReport,
  type Failure,
  type InvoicedReport,
} from './report-view';

type View = 'invoiced' | 'collected' | 'ageing';

@Component({
  selector: 'bp-reports-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, Button, RouterLink, AccountantExport],
  templateUrl: './reports-page.html',
})
export class ReportsPage {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly context = inject(CompanyContextStore);
  private readonly destroyRef = inject(DestroyRef);
  private sequence = 0;
  readonly companyId = signal('');
  readonly view = signal<View>('invoiced');
  readonly views = ['invoiced', 'collected', 'ageing'] as const;
  readonly buckets = ['current', 'days1To30', 'days31To60', 'days61To90', 'over90'] as const;
  readonly taxSets = ['invoiced', 'credited', 'totals'] as const;
  readonly collectionSets = ['payments', 'refunds', 'total'] as const;
  readonly from = signal('');
  readonly to = signal('');
  readonly asOf = signal('');
  readonly invoiced = signal<InvoicedReport | null>(null);
  readonly collected = signal<CollectedReport | null>(null);
  readonly ageing = signal<AgeingReport | null>(null);
  readonly loading = signal(false);
  readonly failure = signal<Failure | null>(null);
  readonly field = fieldValue;

  constructor() {
    this.route.parent?.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      this.companyId.set(params.get('companyId') ?? '');
      this.open(this.view());
    });
  }
  today(): string {
    return companyToday(this.context.timezone());
  }
  selectView(event: Event): void {
    const value = fieldValue(event);
    if (value === 'invoiced' || value === 'collected' || value === 'ageing') this.open(value);
  }
  open(view: View): void {
    this.view.set(view);
    const today = this.today();
    this.from.set(`${today.slice(0, 7)}-01`);
    this.to.set(today);
    this.asOf.set(today);
    this.load();
  }
  load(): void {
    const seq = ++this.sequence;
    this.invoiced.set(null);
    this.collected.set(null);
    this.ageing.set(null);
    this.loading.set(false);
    const view = this.view();
    const problem =
      view === 'ageing'
        ? asOfProblem(this.asOf(), this.today())
        : periodProblem(this.from(), this.to());
    this.failure.set(problem ? { key: problem, correlationId: null } : null);
    if (problem || !this.companyId()) return;
    const params: Record<string, string> =
      view === 'ageing' ? { asOf: this.asOf() } : { from: this.from(), to: this.to() };
    this.loading.set(true);
    // Each response is tied to its view and request; older replies cannot replace it.
    const request: Observable<InvoicedReport | CollectedReport | AgeingReport> =
      view === 'invoiced'
        ? this.http.get<InvoicedReport>(`/api/c/${this.companyId()}/reports/invoiced`, { params })
        : view === 'collected'
          ? this.http.get<CollectedReport>(`/api/c/${this.companyId()}/reports/collected`, {
              params,
            })
          : this.http.get<AgeingReport>(`/api/c/${this.companyId()}/reports/ageing`, { params });
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (body) => {
        if (seq !== this.sequence) return;
        if ('asOf' in body) this.ageing.set(body);
        else if (view === 'invoiced') this.invoiced.set(body as InvoicedReport);
        else this.collected.set(body as CollectedReport);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        if (seq !== this.sequence) return;
        this.loading.set(false);
        this.failure.set(reportFailure(error, view === 'ageing'));
      },
    });
  }
}
