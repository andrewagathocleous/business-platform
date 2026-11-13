import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoPipe } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { CompanyContextStore } from '../core/company-context.store';
import { canAttempt } from '../core/nav';
import { companyToday } from '../invoices/delivery-deadline';
import { fieldValue } from '../orders/field-value';
import {
  exportFailure,
  exportFileName,
  periodProblem,
  saveExport,
  type Failure,
} from './report-view';

@Component({
  selector: 'bp-accountant-export',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, Button],
  template: `
    @if (canExport()) {
      <section class="card" data-testid="accountant-export" aria-labelledby="export-title">
        <h2 id="export-title">{{ 'reports.export.title' | transloco }}</h2>
        <p>{{ 'reports.export.sensitive' | transloco }}</p>
        @if (stepUp()) {
          <p>{{ 'reports.errors.mfa' | transloco }}</p>
        }
        <form class="filters" (submit)="$event.preventDefault(); download()">
          <label
            >{{ 'reports.from' | transloco
            }}<input
              type="date"
              [disabled]="busy()"
              [value]="from()"
              (input)="from.set(field($event))"
          /></label>
          <label
            >{{ 'reports.to' | transloco
            }}<input type="date" [disabled]="busy()" [value]="to()" (input)="to.set(field($event))"
          /></label>
          <label class="check"
            ><input
              type="checkbox"
              [disabled]="busy()"
              [checked]="pdfs()"
              (change)="togglePdfs($event)"
            />{{ 'reports.export.pdfs' | transloco }}</label
          >
          <p-button
            type="submit"
            [disabled]="busy()"
            [label]="'reports.export.download' | transloco"
          />
        </form>
        @if (busy()) {
          <p role="status">{{ 'reports.export.loading' | transloco }}</p>
        }
        @if (failure(); as error) {
          <p role="alert">{{ error.key | transloco }}</p>
          @if (error.correlationId) {
            <p>{{ 'errors.correlation' | transloco }}: {{ error.correlationId }}</p>
          }
        }
      </section>
    }
  `,
})
export class AccountantExport {
  private readonly http = inject(HttpClient);
  private readonly context = inject(CompanyContextStore);
  private readonly destroyRef = inject(DestroyRef);
  private sequence = 0;
  readonly companyId = input.required<string>();
  readonly from = signal('');
  readonly to = signal('');
  readonly pdfs = signal(false);
  readonly busy = signal(false);
  readonly failure = signal<Failure | null>(null);
  readonly field = fieldValue;

  constructor() {
    effect(() => {
      this.companyId();
      const today = companyToday(this.context.timezone());
      this.from.set(`${today.slice(0, 7)}-01`);
      this.to.set(today);
      this.pdfs.set(false);
      this.busy.set(false);
      this.failure.set(null);
      this.sequence++;
    });
  }

  canExport(): boolean {
    return canAttempt(
      this.context.grants(),
      this.context.withheldPermissions(),
      this.context.mfaStepUpRequired(),
      'invoice.export',
    );
  }
  stepUp(): boolean {
    return (
      this.context.mfaStepUpRequired() &&
      this.context.withheldPermissions().includes('invoice.export')
    );
  }
  togglePdfs(event: Event): void {
    this.pdfs.set(event.target instanceof HTMLInputElement && event.target.checked);
  }
  download(): void {
    if (this.busy() || !this.canExport() || !this.companyId()) return;
    const from = this.from();
    const to = this.to();
    const problem = periodProblem(from, to);
    this.failure.set(problem ? { key: problem, correlationId: null } : null);
    if (problem) return;
    const seq = ++this.sequence;
    this.busy.set(true);
    this.http
      .get(`/api/c/${this.companyId()}/exports/accountant`, {
        params: { from, to, pdfs: String(this.pdfs()) },
        responseType: 'blob',
        observe: 'response',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (seq !== this.sequence) return;
          this.busy.set(false);
          if (response.body)
            saveExport(
              response.body,
              exportFileName(response.headers.get('Content-Disposition'), from, to),
            );
          else
            this.failure.set({
              key: 'reports.errors.failed',
              correlationId: response.headers.get('X-Correlation-Id'),
            });
        },
        error: (error: unknown) => {
          void this.refused(error, seq);
        },
      });
  }
  private async refused(error: unknown, seq: number): Promise<void> {
    const failure = await exportFailure(error);
    if (this.destroyRef.destroyed || seq !== this.sequence) return;
    if (failure.key === 'reports.errors.permission' && this.stepUp())
      failure.key = 'reports.errors.mfa';
    this.failure.set(failure);
    this.busy.set(false);
  }
}
