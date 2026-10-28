import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoPipe } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { isAlreadyPrinted, readApiError } from '../core/api-error';
import { CompanyContextStore } from '../core/company-context.store';
import { canAttempt } from '../core/nav';
import { formatCompanyDate } from '../format/company-date';
import { fieldValue } from '../orders/field-value';
import { companyToday } from './delivery-deadline';
import { calendarDate } from './invoice-query';

export type DeliveryMethod = 'handed_over' | 'posted' | 'emailed_outside_platform' | 'other';

export type DeliveryView = {
  id: string;
  method: DeliveryMethod;
  deliveredOn: string;
  paperCopyKept: boolean;
  note: string | null;
};

export type InvoicePrintJob = {
  id: string;
  status: string;
  isReprint: boolean;
  copies: number;
  createdAt: string;
  /** Set when the printer is the mock provider: nothing is printed for real. */
  simulationLabel?: string | null;
};

const METHODS: readonly DeliveryMethod[] = [
  'handed_over',
  'posted',
  'emailed_outside_platform',
  'other',
];
const PAPER: ReadonlySet<DeliveryMethod> = new Set(['handed_over', 'posted']);

const DELIVERY_ERRORS: Readonly<Record<string, string>> = {
  paper_copy_required: 'invoices.delivery.errors.paperCopy',
  e_invoice_not_accepted: 'invoices.delivery.errors.eInvoice',
  delivered_in_future: 'invoices.delivery.errors.future',
  delivered_before_issue: 'invoices.delivery.errors.beforeIssue',
  not_issued: 'invoices.delivery.errors.notIssued',
};

const PRINT_ERRORS: Readonly<Record<string, string>> = {
  printer_not_mapped: 'invoices.print.errors.notMapped',
  location_required: 'invoices.print.errors.location',
  paper_size_not_supported: 'invoices.print.errors.paper',
  not_issued: 'invoices.print.errors.notIssued',
};

type Failure = { key: string; correlationId: string | null };

type LocationOption = { id: string; name: string };

/**
 * A print request that has not had a definite answer. Sent again as it is, it cannot print
 * twice. `lost`: an answer went missing, so only a success settles it; a refused retry does not
 * show that the first attempt failed.
 */
type PendingPrint = { body: Record<string, unknown>; lost: boolean };

/**
 * Delivery record and printing for an issued document. After each action the editor reloads
 * the document (`changed`), which brings back its deliveries and print jobs. Nothing here
 * changes the document itself.
 */
@Component({
  selector: 'bp-issued-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The editor's form is a grid; the panel spans it like the other full-width sections.
  host: { class: 'span-all' },
  imports: [TranslocoPipe, Button],
  template: `
    <section class="card span-all" data-testid="deliveries">
      <h2>{{ 'invoices.delivery.title' | transloco }}</h2>
      @if (deliveries().length === 0) {
        <p>{{ 'invoices.delivery.none' | transloco }}</p>
      } @else {
        <ul>
          @for (delivery of deliveries(); track delivery.id) {
            <li>
              {{ dateLabel(delivery.deliveredOn) }} ·
              {{ 'invoices.delivery.methods.' + delivery.method | transloco }}
              @if (delivery.paperCopyKept) {
                · {{ 'invoices.delivery.copyKept' | transloco }}
              }
              @if (delivery.note) {
                <div style="white-space: pre-wrap">{{ delivery.note }}</div>
              }
            </li>
          }
        </ul>
      }
      @if (canRecord()) {
        <div class="form-grid">
          <fieldset style="display: contents" [disabled]="busy()">
            <label>
              {{ 'invoices.delivery.method' | transloco }}
              <select (change)="setMethod($event)">
                @for (option of methods; track option) {
                  <option [value]="option" [selected]="option === method()">
                    {{ 'invoices.delivery.methods.' + option | transloco }}
                  </option>
                }
              </select>
            </label>
            <label>
              {{ 'invoices.delivery.date' | transloco }}
              <input type="date" [value]="deliveredOn()" (change)="setDate($event)" />
            </label>
            @if (paper()) {
              <label class="check">
                <input type="checkbox" [checked]="copyKept()" (change)="setCopyKept($event)" />
                {{ 'invoices.delivery.keepCopy' | transloco }}
              </label>
            }
            <label class="span-all">
              {{ 'invoices.delivery.note' | transloco }}
              <textarea [value]="note()" (input)="setNote($event)"></textarea>
            </label>
            <div class="form-actions">
              <p-button
                type="button"
                [label]="'invoices.delivery.record' | transloco"
                [disabled]="busy() || (paper() && !copyKept())"
                (onClick)="record()"
              />
            </div>
          </fieldset>
        </div>
      }
      @if (deliveryFailure(); as failure) {
        <p role="alert">{{ failure.key | transloco }}</p>
        @if (failure.correlationId) {
          <p>{{ 'errors.correlation' | transloco }}: {{ failure.correlationId }}</p>
        }
      }
      @for (warning of deliveryWarnings(); track warning) {
        <p role="status">{{ 'invoices.delivery.warnings.' + warning | transloco }}</p>
      }
    </section>

    @if (canSeePrinting()) {
      <section class="card span-all" data-testid="print">
        <h2>{{ 'invoices.print.title' | transloco }}</h2>
        <p>{{ 'invoices.print.help' | transloco }}</p>
        @if (printJobs().length > 0) {
          <ul data-testid="print-history">
            @for (job of printJobs(); track job.id) {
              <li>
                {{ timeLabel(job.createdAt) }} ·
                {{ 'orders.printStatus.' + job.status | transloco }} ·
                {{ 'invoices.print.copies' | transloco: { copies: job.copies } }}
                @if (job.isReprint) {
                  · {{ 'invoices.print.reprinted' | transloco }}
                }
                @if (job.simulationLabel) {
                  · {{ job.simulationLabel }}
                }
              </li>
            }
          </ul>
        }
        @if (queued(); as job) {
          <p role="status">
            {{ 'invoices.print.queued' | transloco: { copies: job.copies } }}
            @if (job.simulationLabel) {
              ({{ job.simulationLabel }})
            }
          </p>
        }
        @if (pending()) {
          <p role="alert">{{ 'invoices.print.uncertain' | transloco }}</p>
          <p-button
            type="button"
            [label]="'invoices.print.retry' | transloco"
            [disabled]="busy()"
            (onClick)="retry()"
          />
          @if (retryRefused()) {
            <p>{{ 'invoices.print.discardHelp' | transloco }}</p>
            <p-button
              type="button"
              severity="secondary"
              [label]="'invoices.print.discard' | transloco"
              [disabled]="busy()"
              (onClick)="discard()"
            />
          }
        } @else {
          @if (locations().length > 0) {
            <label>
              {{ 'invoices.print.location' | transloco }}
              <select (change)="setLocation($event)">
                <option value="" [selected]="locationId() === ''">
                  {{ 'invoices.print.chooseLocation' | transloco }}
                </option>
                @for (location of locations(); track location.id) {
                  <option [value]="location.id" [selected]="location.id === locationId()">
                    {{ location.name }}
                  </option>
                }
              </select>
            </label>
          }
          @if (canFirstPrint()) {
            <p-button
              type="button"
              [label]="'invoices.print.action' | transloco"
              [disabled]="busy()"
              (onClick)="print(false)"
            />
          }
          @if (canReprint()) {
            <label class="span-all">
              {{ 'invoices.print.reason' | transloco }}
              <input [value]="reason()" (input)="setReason($event)" />
            </label>
            <p-button
              type="button"
              severity="secondary"
              [label]="'invoices.print.reprint' | transloco"
              [disabled]="busy() || reason().trim().length < 5"
              (onClick)="print(true)"
            />
          }
        }
        @if (printFailure(); as failure) {
          <p role="alert">{{ failure.key | transloco }}</p>
          @if (failure.correlationId) {
            <p>{{ 'errors.correlation' | transloco }}: {{ failure.correlationId }}</p>
          }
        }
      </section>
    }
  `,
})
export class IssuedActions {
  private readonly http = inject(HttpClient);
  private readonly context = inject(CompanyContextStore);
  /** A left panel stops listening: a late answer cannot touch what a newer panel saved. */
  private readonly destroyRef = inject(DestroyRef);

  readonly companyId = input.required<string>();
  readonly invoiceId = input.required<string>();
  readonly deliveries = input<readonly DeliveryView[]>([]);
  readonly printJobs = input<readonly InvoicePrintJob[]>([]);
  /** The first print that still counts (from the API, however old), or null. */
  readonly firstPrintJobId = input<string | null>(null);
  /** Something was recorded or queued: the editor reloads the document. */
  readonly changed = output();

  readonly methods = METHODS;
  readonly method = signal<DeliveryMethod>('handed_over');
  readonly deliveredOn = signal('');
  readonly copyKept = signal(false);
  readonly note = signal('');
  readonly reason = signal('');
  readonly busy = signal(false);
  readonly deliveryFailure = signal<Failure | null>(null);
  readonly deliveryWarnings = signal<string[]>([]);
  readonly printFailure = signal<Failure | null>(null);
  readonly queued = signal<{ copies: number; simulationLabel: string | null } | null>(null);
  /** A retry of a lost request was refused: the user may discard it after checking the history. */
  readonly retryRefused = signal(false);
  readonly locations = signal<LocationOption[]>([]);
  readonly locationId = signal('');
  /**
   * A print request whose outcome is unknown (no answer, a server error, an unreadable reply).
   * It keeps its request key, so sending it again returns the job it may already have created.
   * It is kept in session storage too, so a page reload does not lose it.
   */
  readonly pending = signal<PendingPrint | null>(null);

  /** What a reprint refers to: the first print that still counts, else the latest job. */
  readonly reprintOf = computed(() => this.firstPrintJobId() ?? this.printJobs()[0]?.id ?? null);

  /** Bumped when the document changes, so a late answer for the previous one is ignored. */
  private generation = 0;

  constructor() {
    effect(() => {
      // A different document (or company) starts with a clean form.
      this.companyId();
      this.invoiceId();
      this.generation += 1;
      this.method.set('handed_over');
      this.deliveredOn.set(untracked(() => companyToday(this.context.timezone())));
      this.copyKept.set(false);
      this.note.set('');
      this.reason.set('');
      this.busy.set(false);
      this.deliveryFailure.set(null);
      this.deliveryWarnings.set([]);
      this.printFailure.set(null);
      this.queued.set(null);
      this.locations.set([]);
      this.locationId.set('');
      this.pending.set(untracked(() => this.storedPending()));
      this.retryRefused.set(false);
    });
  }

  canRecord(): boolean {
    return this.allowed('invoice.issue');
  }

  canSeePrinting(): boolean {
    return (
      this.allowed('invoice.view') &&
      (this.allowed('print.submit') || this.allowed('print.reprint'))
    );
  }

  /** No first print counts yet (none, or each one failed, was cancelled or not printed). */
  canFirstPrint(): boolean {
    return (
      this.allowed('invoice.view') &&
      this.allowed('print.submit') &&
      this.firstPrintJobId() === null &&
      this.pending() === null
    );
  }

  canReprint(): boolean {
    return (
      this.allowed('invoice.view') &&
      this.allowed('print.reprint') &&
      this.reprintOf() !== null &&
      this.pending() === null
    );
  }

  paper(): boolean {
    return PAPER.has(this.method());
  }

  dateLabel(value: string): string {
    return calendarDate(value);
  }

  timeLabel(value: string): string {
    return formatCompanyDate(value, this.context.timezone());
  }

  setMethod(event: Event): void {
    const value = fieldValue(event);
    const method = METHODS.find((option) => option === value);
    if (method) {
      this.method.set(method);
    }
  }

  setDate(event: Event): void {
    this.deliveredOn.set(fieldValue(event));
  }

  setCopyKept(event: Event): void {
    const target = event.target;
    this.copyKept.set(target instanceof HTMLInputElement && target.checked);
  }

  setNote(event: Event): void {
    this.note.set(fieldValue(event));
  }

  setReason(event: Event): void {
    this.reason.set(fieldValue(event));
  }

  setLocation(event: Event): void {
    this.locationId.set(fieldValue(event));
  }

  record(): void {
    if (!this.canRecord() || this.busy() || (this.paper() && !this.copyKept())) {
      return;
    }
    this.busy.set(true);
    this.deliveryFailure.set(null);
    this.deliveryWarnings.set([]);
    const generation = this.generation;
    const note = this.note();
    this.http
      .post<{ warnings: string[] }>(
        `/api/c/${this.companyId()}/invoices/${this.invoiceId()}/deliveries`,
        {
          method: this.method(),
          deliveredOn: this.deliveredOn(),
          paperCopyKept: this.paper() ? this.copyKept() : false,
          // Customer text is sent as typed.
          note: note.length > 0 ? note : null,
        },
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          this.note.set('');
          this.copyKept.set(false);
          this.deliveryWarnings.set(response.warnings);
          this.changed.emit();
        },
        error: (error: unknown) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          this.deliveryFailure.set(
            failure(error, DELIVERY_ERRORS, 'invoices.delivery.errors.failed'),
          );
        },
      });
  }

  print(reprint: boolean): void {
    if (this.busy() || this.pending()) {
      return;
    }
    const prior = this.reprintOf();
    if (
      reprint
        ? !this.canReprint() || !prior || this.reason().trim().length < 5
        : !this.canFirstPrint()
    ) {
      return;
    }
    const locationId = this.locationId();
    const body: Record<string, unknown> = {
      documentType: 'invoice',
      sourceType: 'invoice',
      sourceId: this.invoiceId(),
      requestKey: crypto.randomUUID(),
      ...(locationId ? { locationId } : {}),
      ...(reprint && prior
        ? { reprint: { ofPrintJobId: prior, reason: this.reason().trim() } }
        : {}),
    };
    // Remembered before it is sent: if the answer is lost, the same request goes again.
    // Without a saved copy a lost answer could not be recovered, so nothing is sent.
    if (!this.setPending({ body, lost: false })) {
      this.pending.set(null);
      this.printFailure.set({ key: 'invoices.print.errors.storage', correlationId: null });
      return;
    }
    this.send(body);
  }

  /** Sends the request whose answer was lost, unchanged. The API returns its job if it exists. */
  retry(): void {
    const pending = this.pending();
    if (!pending || this.busy()) {
      return;
    }
    this.send(pending.body);
  }

  /** Gives up a lost request after a refused retry; the history shows whether it printed. */
  discard(): void {
    const pending = this.pending();
    if (!pending || !this.retryRefused() || this.busy()) {
      return;
    }
    this.clearPending(keyOf(pending.body));
    this.retryRefused.set(false);
    this.printFailure.set(null);
  }

  private send(body: Record<string, unknown>): void {
    this.busy.set(true);
    this.printFailure.set(null);
    this.queued.set(null);
    const generation = this.generation;
    const key = keyOf(body);
    this.http
      .post<unknown>(`/api/c/${this.companyId()}/print-requests`, body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          const job = queuedJob(response);
          if (job === null) {
            // A reply without the job: the outcome is still unknown, so the request is kept.
            this.markLost(key);
            this.changed.emit();
            return;
          }
          this.clearPending(key);
          this.retryRefused.set(false);
          this.reason.set('');
          this.queued.set(job);
          this.changed.emit();
        },
        error: (error: unknown) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          if (unknownOutcome(error)) {
            // Kept: the only way on is to send the same request again.
            this.markLost(key);
            this.changed.emit();
            return;
          }
          if (this.pending()?.lost && keyOf(this.pending()?.body) === key) {
            // This attempt was refused, but an earlier one may have been queued: keep it.
            this.retryRefused.set(true);
            this.printFailure.set(failure(error, PRINT_ERRORS, 'invoices.print.errors.failed'));
            this.changed.emit();
            return;
          }
          // A definite refusal of the only attempt: nothing was queued.
          this.clearPending(key);
          if (isAlreadyPrinted(error)) {
            // Someone printed it first; the reloaded history offers the reprint.
            this.printFailure.set({ key: 'invoices.print.alreadyPrinted', correlationId: null });
            this.changed.emit();
            return;
          }
          const failed = error instanceof HttpErrorResponse ? readApiError(error) : null;
          if (failed?.code === 'location_required') {
            this.loadLocations(generation);
          }
          this.printFailure.set(failure(error, PRINT_ERRORS, 'invoices.print.errors.failed'));
        },
      });
  }

  private storageKey(): string {
    return `bp.invoicePrint.${this.companyId()}.${this.invoiceId()}`;
  }

  private storedPending(): PendingPrint | null {
    try {
      const raw = sessionStorage.getItem(this.storageKey());
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (typeof parsed === 'object' && parsed !== null && 'body' in parsed) {
        const body = parsed.body;
        if (typeof body === 'object' && body !== null) {
          // Found after a reload: whatever happened to it, its answer is lost.
          return { body: body as Record<string, unknown>, lost: true };
        }
      }
    } catch {
      // Storage may be unavailable; the pending request then lives only in this page.
    }
    return null;
  }

  /** Only the request that owns the saved key may change it. */
  private markLost(key: string | null): void {
    const pending = this.pending();
    if (pending && !pending.lost && keyOf(pending.body) === key) {
      this.setPending({ ...pending, lost: true });
    }
  }

  private clearPending(key: string | null): void {
    if (keyOf(this.pending()?.body) === key) {
      this.pending.set(null);
    }
    try {
      const stored = this.storedPending();
      if (stored && keyOf(stored.body) === key) {
        sessionStorage.removeItem(this.storageKey());
      }
    } catch {
      // Storage may be unavailable.
    }
  }

  /** False when the browser would not save it; the page still holds it until it is closed. */
  private setPending(pending: PendingPrint): boolean {
    this.pending.set(pending);
    try {
      sessionStorage.setItem(this.storageKey(), JSON.stringify(pending));
      return true;
    } catch {
      return false;
    }
  }

  private loadLocations(generation: number): void {
    this.http
      .get<{ locations: (LocationOption & { archivedAt: string | null })[] }>(
        `/api/c/${this.companyId()}/locations`,
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (body) => {
          if (generation === this.generation) {
            this.locations.set(body.locations.filter((location) => location.archivedAt === null));
          }
        },
        error: () => undefined,
      });
  }

  private allowed(permission: string): boolean {
    return canAttempt(
      this.context.grants(),
      this.context.withheldPermissions(),
      this.context.mfaStepUpRequired(),
      permission,
    );
  }
}

/**
 * Only a 4xx says the request was refused. No answer, a server error, or a reply that could
 * not be read (even with status 200) leaves the outcome unknown.
 */
function unknownOutcome(error: unknown): boolean {
  return !(error instanceof HttpErrorResponse) || error.status < 400 || error.status >= 500;
}

function keyOf(body: Record<string, unknown> | undefined): string | null {
  const key = body?.['requestKey'];
  return typeof key === 'string' ? key : null;
}

function queuedJob(response: unknown): { copies: number; simulationLabel: string | null } | null {
  if (typeof response !== 'object' || response === null || !('printJob' in response)) {
    return null;
  }
  const job = response.printJob;
  if (typeof job !== 'object' || job === null || !('copies' in job)) {
    return null;
  }
  if (typeof job.copies !== 'number') {
    return null;
  }
  const label = 'simulationLabel' in job ? job.simulationLabel : null;
  return { copies: job.copies, simulationLabel: typeof label === 'string' ? label : null };
}

function failure(
  error: unknown,
  known: Readonly<Record<string, string>>,
  fallback: string,
): Failure {
  const body = error instanceof HttpErrorResponse ? readApiError(error) : null;
  return {
    key: known[body?.code ?? ''] ?? fallback,
    correlationId: body?.correlationId ?? null,
  };
}
