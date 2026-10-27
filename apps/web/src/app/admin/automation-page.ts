import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, type ParamMap } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { combineLatest, of } from 'rxjs';
import { CompanyContextStore } from '../core/company-context.store';
import { canAttempt } from '../core/nav';
import { NAVIGATE_ON_DENIED } from '../core/navigate-on-denied';
import { ActiveLang } from '../format/active-lang';
import { CompanyDatePipe } from '../format/company-date.pipe';
import { fieldValue } from '../orders/field-value';
import { translateCode } from '../orders/labels';
import { printJobActions } from './print-job-actions';
import {
  type AutomationQuery,
  defaultAutomationQuery,
  isCanonicalAutomationQuery,
  jobsHttpParams,
  parseAutomationQuery,
  printJobsHttpParams,
  serializeAutomationQuery,
} from './automation-query';

type SwitchRow = {
  key: string;
  enabled: boolean;
  reason: string | null;
  updatedAt: string;
  actorLabel?: string | null;
};
type JobRow = {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  lastError: string | null;
};
type PrintRow = {
  id: string;
  documentType: string;
  status: string;
  simulationLabel: string | null;
  can?: { cancel: boolean; release: boolean };
};

@Component({
  selector: 'bp-automation-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, Button, CompanyDatePipe],
  template: `
    <section class="screen">
      <h1>{{ 'automation.title' | transloco }}</h1>
      <p>{{ 'automation.outboundNote' | transloco }}</p>
      @if (loading()) {
        <p role="status">{{ 'automation.loading' | transloco }}</p>
      }
      @if (loadError()) {
        <p role="alert">{{ 'automation.error' | transloco }}</p>
      }
      <h2>{{ 'automation.switches' | transloco }}</h2>
      <div class="table-scroll">
        <table class="items">
          <thead>
            <tr>
              <th>{{ 'automation.columns.switch' | transloco }}</th>
              <th>{{ 'automation.columns.state' | transloco }}</th>
              <th>{{ 'automation.columns.lastChange' | transloco }}</th>
              @if (canManage()) {
                <th>{{ 'automation.columns.actions' | transloco }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (item of switches(); track item.key) {
              <tr>
                <td>{{ item.key }}</td>
                <td>{{ (item.enabled ? 'automation.on' : 'automation.off') | transloco }}</td>
                <td>
                  <div class="last-change">
                    @if (item.reason) {
                      <span>{{ item.reason }}</span>
                    }
                    @if (switchActor(item); as actor) {
                      <span>{{ actor }}</span>
                    }
                    <span>{{ item.updatedAt | companyDate: context.timezone() : lang.code() }}</span>
                  </div>
                </td>
                @if (canManage()) {
                  <td>
                    <p-button
                      type="button"
                      size="small"
                      severity="secondary"
                      [label]="(item.enabled ? 'automation.turnOff' : 'automation.turnOn') | transloco: { key: item.key }"
                      (onClick)="askSwitch(item)"
                    />
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>

      <h2>{{ 'automation.jobs' | transloco }}</h2>
      <form class="filters" (submit)="$event.preventDefault()">
        <label>
          {{ 'automation.jobStatus' | transloco }}
          <select (change)="setJobStatus($event)">
            <option value="" [selected]="query().jobStatus === ''">{{ 'automation.anyStatus' | transloco }}</option>
            @for (status of jobStatuses; track status) {
              <option [value]="status" [selected]="status === query().jobStatus">{{ status }}</option>
            }
          </select>
        </label>
      </form>
      <div class="table-scroll">
        <table class="items">
          <thead>
            <tr>
              <th>{{ 'automation.columns.type' | transloco }}</th>
              <th>{{ 'automation.columns.status' | transloco }}</th>
              <th>{{ 'automation.columns.attempts' | transloco }}</th>
              <th>{{ 'automation.columns.runAfter' | transloco }}</th>
              <th>{{ 'automation.columns.lastError' | transloco }}</th>
            </tr>
          </thead>
          <tbody>
            @for (job of jobs(); track job.id) {
              <tr>
                <td>{{ job.type }}</td>
                <td>{{ job.status }}</td>
                <td>{{ job.attempts }}/{{ job.maxAttempts }}</td>
                <td>{{ job.runAfter | companyDate: context.timezone() : lang.code() }}</td>
                <td>{{ job.lastError }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <div class="actions">
        <p-button
          type="button"
          severity="secondary"
          [label]="'common.previous' | transloco"
          [disabled]="query().jobPage <= 1"
          (onClick)="setJobPage(query().jobPage - 1)"
        />
        <p-button
          type="button"
          severity="secondary"
          [label]="'common.next' | transloco"
          [disabled]="!jobsHasMore()"
          (onClick)="setJobPage(query().jobPage + 1)"
        />
      </div>

      <h2>{{ 'automation.printJobs' | transloco }}</h2>
      <form class="filters" (submit)="$event.preventDefault()">
        <label>
          {{ 'automation.printStatus' | transloco }}
          <select (change)="setPrintStatus($event)">
            <option value="" [selected]="query().printStatus === ''">{{ 'automation.anyStatus' | transloco }}</option>
            @for (status of printStatuses; track status) {
              <option [value]="status" [selected]="status === query().printStatus">{{ printLabel(status) }}</option>
            }
          </select>
        </label>
      </form>
      <div class="table-scroll">
        <table class="items">
          <thead>
            <tr>
              <th>{{ 'automation.columns.document' | transloco }}</th>
              <th>{{ 'automation.columns.status' | transloco }}</th>
              <th>{{ 'automation.columns.actions' | transloco }}</th>
            </tr>
          </thead>
          <tbody>
            @for (job of printJobs(); track job.id) {
              <tr>
                <td>{{ job.documentType }}</td>
                <td>
                  {{ printLabel(job.status) }}
                  @if (job.simulationLabel) {
                    <span class="simulated-badge">{{ 'orders.print.simulated' | transloco }}</span>
                  }
                </td>
                <td>
                  <div class="row-actions">
                  @if (actions(job).release) {
                    <p-button
                      type="button"
                      size="small"
                      severity="secondary"
                      [label]="'automation.release' | transloco"
                      [disabled]="busy()"
                      (onClick)="release(job)"
                    />
                  }
                  @if (actions(job).cancel) {
                    <p-button
                      type="button"
                      size="small"
                      severity="danger"
                      [label]="'automation.cancel' | transloco"
                      [disabled]="busy()"
                      (onClick)="cancel(job)"
                    />
                  }
                  </div>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <div class="actions">
        <p-button
          type="button"
          severity="secondary"
          [label]="'common.previous' | transloco"
          [disabled]="query().printPage <= 1"
          (onClick)="setPrintPage(query().printPage - 1)"
        />
        <p-button
          type="button"
          severity="secondary"
          [label]="'common.next' | transloco"
          [disabled]="!printHasMore()"
          (onClick)="setPrintPage(query().printPage + 1)"
        />
      </div>

      @if (pendingSwitch(); as pending) {
        <div class="modal" role="presentation">
          <div class="dialog" role="dialog" aria-modal="true" data-testid="switch-dialog" aria-labelledby="switch-title">
            <h2 id="switch-title">{{ (pending.enabled ? 'automation.turnOff' : 'automation.turnOn') | transloco: { key: pending.key } }}</h2>
            <label>
              {{ 'automation.reason' | transloco }}
              <textarea [value]="reason()" (input)="reason.set(field($event))"></textarea>
            </label>
            <div class="actions">
              <p-button
                type="button"
                [label]="'automation.confirm' | transloco"
                [disabled]="busy() || reason().trim().length === 0"
                (onClick)="confirmSwitch()"
              />
              <p-button
                type="button"
                severity="secondary"
                [label]="'automation.back' | transloco"
                (onClick)="pendingSwitch.set(null)"
              />
            </div>
          </div>
        </div>
      }
    </section>
  `,
})
export class AutomationPage {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly transloco = inject(TranslocoService);
  readonly context = inject(CompanyContextStore);
  readonly lang = inject(ActiveLang);
  readonly field = fieldValue;
  readonly jobStatuses = ['queued', 'running', 'succeeded', 'failed', 'held', 'uncertain', 'cancelled'] as const;
  readonly printStatuses = [
    'queued',
    'held',
    'submitting',
    'submitted',
    'delivered_to_printer',
    'done_reported',
    'confirmed_printed',
    'not_printed',
    'failed',
    'uncertain',
    'cancelled',
  ] as const;

  readonly companyId = signal('');
  readonly query = signal<AutomationQuery>(defaultAutomationQuery());
  readonly switches = signal<SwitchRow[]>([]);
  readonly jobs = signal<JobRow[]>([]);
  readonly printJobs = signal<PrintRow[]>([]);
  readonly jobsHasMore = signal(false);
  readonly printHasMore = signal(false);
  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly busy = signal(false);
  readonly pendingSwitch = signal<{ key: string; enabled: boolean } | null>(null);
  readonly reason = signal('');
  private switchSeq = 0;
  private jobSeq = 0;
  private printSeq = 0;

  constructor() {
    const companyId$ = this.route.parent?.paramMap ?? of(emptyParams());
    combineLatest([companyId$, this.route.queryParamMap])
      .pipe(takeUntilDestroyed())
      .subscribe(([company, query]) => {
        const companyId = company.get('companyId') ?? '';
        this.companyId.set(companyId);
        const parsed = parseAutomationQuery(query);
        this.query.set(parsed);
        if (!isCanonicalAutomationQuery(query)) {
          void this.router.navigate([], {
            relativeTo: this.route,
            queryParams: serializeAutomationQuery(parsed),
            replaceUrl: true,
          });
          return;
        }
        this.loadSwitches(companyId);
        this.loadJobs(companyId, parsed);
        this.loadPrintJobs(companyId, parsed);
      });
  }

  canManage(): boolean {
    return canAttempt(
      this.context.grants(),
      this.context.withheldPermissions(),
      this.context.mfaStepUpRequired(),
      'automation.manage',
    );
  }

  switchActor(item: SwitchRow): string {
    return item.actorLabel && item.actorLabel.length > 0 ? item.actorLabel : '';
  }

  printLabel(status: string): string {
    return translateCode(this.transloco, 'orders.printStatus', status);
  }

  actions(job: PrintRow): { release: boolean; cancel: boolean } {
    return printJobActions(job.status, {
      release:
        job.can?.release === true &&
        canAttempt(
          this.context.grants(),
          this.context.withheldPermissions(),
          this.context.mfaStepUpRequired(),
          'automation.replay',
        ),
      cancel:
        job.can?.cancel === true &&
        canAttempt(
          this.context.grants(),
          this.context.withheldPermissions(),
          this.context.mfaStepUpRequired(),
          'print.submit',
        ),
    });
  }

  setJobStatus(event: Event): void {
    const value = fieldValue(event);
    const jobStatus = this.jobStatuses.find((status) => status === value) ?? '';
    this.navigate({ ...this.query(), jobStatus, jobPage: 1 });
  }

  setPrintStatus(event: Event): void {
    const value = fieldValue(event);
    const printStatus = this.printStatuses.find((status) => status === value) ?? '';
    this.navigate({ ...this.query(), printStatus, printPage: 1 });
  }

  setJobPage(page: number): void {
    this.navigate({ ...this.query(), jobPage: page < 1 ? 1 : page });
  }

  setPrintPage(page: number): void {
    this.navigate({ ...this.query(), printPage: page < 1 ? 1 : page });
  }

  askSwitch(item: SwitchRow): void {
    this.reason.set('');
    this.pendingSwitch.set({ key: item.key, enabled: item.enabled });
  }

  confirmSwitch(): void {
    const pending = this.pendingSwitch();
    const reason = this.reason().trim();
    if (!pending || reason.length === 0 || !this.begin()) {
      return;
    }
    this.http
      .put<{ switch: SwitchRow }>(`/api/c/${this.companyId()}/automation/switches/${encodeURIComponent(pending.key)}`, {
        enabled: !pending.enabled,
        reason,
      })
      .subscribe({
        next: () => {
          this.pendingSwitch.set(null);
          this.reason.set('');
          this.busy.set(false);
          this.loadSwitches(this.companyId());
        },
        error: () => {
          this.busy.set(false);
        },
      });
  }

  release(job: PrintRow): void {
    if (!this.actions(job).release || !this.begin()) {
      return;
    }
    this.http.post(`/api/c/${this.companyId()}/print-jobs/${job.id}/release`, {}).subscribe({
      next: () => {
        this.busy.set(false);
        this.loadPrintJobs(this.companyId(), this.query());
      },
      error: () => {
        this.busy.set(false);
      },
    });
  }

  cancel(job: PrintRow): void {
    if (!this.actions(job).cancel || !this.begin()) {
      return;
    }
    this.http.post(`/api/c/${this.companyId()}/print-jobs/${job.id}/cancel`, {}).subscribe({
      next: () => {
        this.busy.set(false);
        this.loadPrintJobs(this.companyId(), this.query());
      },
      error: () => {
        this.busy.set(false);
      },
    });
  }

  private loadSwitches(companyId: string): void {
    if (companyId.length === 0) {
      this.loading.set(false);
      return;
    }
    const seq = ++this.switchSeq;
    this.loading.set(true);
    this.loadError.set(false);
    this.http
      .get<{ switches: SwitchRow[] }>(`/api/c/${companyId}/automation/switches`, {
        context: new HttpContext().set(NAVIGATE_ON_DENIED, true),
      })
      .subscribe({
        next: (body) => {
          if (seq !== this.switchSeq) {
            return;
          }
          this.switches.set(body.switches);
          this.loading.set(false);
        },
        error: (error: unknown) => {
          if (seq !== this.switchSeq) {
            return;
          }
          this.loading.set(false);
          if (error instanceof HttpErrorResponse) {
            this.loadError.set(true);
          }
        },
      });
  }

  private loadJobs(companyId: string, query: AutomationQuery): void {
    if (companyId.length === 0) {
      return;
    }
    const seq = ++this.jobSeq;
    this.http
      .get<{ jobs: JobRow[]; page: number; pageSize: number }>(`/api/c/${companyId}/automation/jobs`, {
        params: jobsHttpParams(query),
      })
      .subscribe({
        next: (body) => {
          if (seq !== this.jobSeq) {
            return;
          }
          this.jobs.set(body.jobs);
          this.jobsHasMore.set(body.jobs.length === body.pageSize);
        },
        error: () => {
          if (seq === this.jobSeq) {
            this.jobs.set([]);
          }
        },
      });
  }

  private loadPrintJobs(companyId: string, query: AutomationQuery): void {
    if (companyId.length === 0) {
      return;
    }
    const seq = ++this.printSeq;
    this.http
      .get<{ printJobs: PrintRow[]; page: number; pageSize: number; total: number }>(`/api/c/${companyId}/print-jobs`, {
        params: printJobsHttpParams(query),
      })
      .subscribe({
        next: (body) => {
          if (seq !== this.printSeq) {
            return;
          }
          this.printJobs.set(body.printJobs);
          this.printHasMore.set(body.page * body.pageSize < body.total);
        },
        error: () => {
          if (seq === this.printSeq) {
            this.printJobs.set([]);
          }
        },
      });
  }

  private navigate(next: AutomationQuery): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: serializeAutomationQuery(next) });
  }

  private begin(): boolean {
    if (this.busy()) {
      return false;
    }
    this.busy.set(true);
    return true;
  }
}

function emptyParams(): ParamMap {
  return { has: () => false, get: () => null, getAll: () => [], keys: [] };
}
