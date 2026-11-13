import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  InjectionToken,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { isAlreadyPrinted } from '../core/api-error';
import { CompanyDatePipe } from '../format/company-date.pipe';
import {
  readPendingPrint,
  removePendingPrintIfKey,
  requestKeyOf,
  unknownPrintOutcome,
  writePendingPrint,
  type PendingPrint,
} from '../printing/pending-print';
import { translateCode } from './labels';
import type { PrintSlot } from './models';
import { printActions } from './print-actions';
import { fieldValue } from './field-value';

const noPrintPermissions = { submit: false, reprint: false, confirm: false };

function isPollDenied(error: unknown): boolean {
  return error instanceof HttpErrorResponse && (error.status === 403 || error.status === 404);
}

/** A 200 without a print job is unreadable: the outcome is still unknown. */
function readablePrintJob(response: unknown): PrintSlot | null {
  if (typeof response !== 'object' || response === null || !('printJob' in response)) {
    return null;
  }
  const job = response.printJob;
  if (typeof job !== 'object' || job === null || Array.isArray(job)) {
    return null;
  }
  if (!('id' in job) || typeof job.id !== 'string' || job.id.length === 0) {
    return null;
  }
  if (!('status' in job) || typeof job.status !== 'string') {
    return null;
  }
  return job as PrintSlot;
}

export const PRINT_POLL_MS = new InjectionToken<number>('PRINT_POLL_MS', { factory: () => 2_000 });
export const PRINT_POLL_LIMIT_MS = new InjectionToken<number>('PRINT_POLL_LIMIT_MS', {
  factory: () => 120_000,
});

@Component({
  selector: 'bp-print-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, CompanyDatePipe, Button],
  template: `
    <article class="print-card" [attr.data-document]="documentType()">
      <h3>{{ titleKey() | transloco }}</h3>
      @if (shown(); as job) {
        <p class="print-status" data-testid="print-status">{{ statusLabel(job.status) }}</p>
        @if (job.isReprint) {
          <p>{{ 'orders.print.reprintFlag' | transloco }}</p>
        }
        <p>{{ 'orders.print.provider' | transloco }}: {{ job.provider }}</p>
        @if (job.provider === 'mock') {
          <p class="simulated-badge">{{ 'orders.print.simulated' | transloco }}</p>
        }
        <p>{{ job.createdAt | companyDate: zone() : lang() }}</p>
        @if (actions().heldNote) {
          <p>{{ 'orders.print.heldNote' | transloco }}</p>
        }
        @if (pollDenied()) {
          <p role="status">{{ 'orders.print.pollDenied' | transloco }}</p>
        } @else if (waiting()) {
          <p role="status">{{ 'orders.print.waiting' | transloco }}</p>
        }
      }
      <div class="print-actions">
        @if (cannotCheck()) {
          <p role="alert">{{ 'orders.print.unreadable' | transloco }}</p>
          <p-button
            type="button"
            [label]="'orders.print.checkAgain' | transloco"
            [disabled]="mutating()"
            (onClick)="checkAgain()"
          />
        } @else if (pending()) {
          <p role="alert">{{ 'orders.print.uncertain' | transloco }}</p>
          <p-button
            type="button"
            [label]="'orders.print.retry' | transloco"
            [disabled]="mutating()"
            (onClick)="retry()"
          />
          @if (retryRefused()) {
            <p>{{ 'orders.print.discardHelp' | transloco }}</p>
            <p-button
              type="button"
              severity="secondary"
              [label]="'orders.print.discard' | transloco"
              [disabled]="mutating()"
              (onClick)="discard()"
            />
          }
        } @else {
          @if (actions().print) {
            <p-button
              type="button"
              [label]="'orders.print.print' | transloco"
              [disabled]="mutating()"
              (onClick)="print(false)"
            />
          }
          @if (actions().confirmPrinted) {
            <p-button
              type="button"
              severity="secondary"
              [label]="'orders.print.confirmPrinted' | transloco"
              [disabled]="mutating()"
              (onClick)="confirm('printed')"
            />
          }
          @if (actions().notPrinted) {
            <p-button
              type="button"
              severity="secondary"
              [label]="'orders.print.notPrinted' | transloco"
              [disabled]="mutating()"
              (onClick)="confirm('not_printed')"
            />
          }
          @if (actions().cancel) {
            <p-button
              type="button"
              severity="secondary"
              [label]="'orders.print.cancel' | transloco"
              [disabled]="mutating()"
              (onClick)="cancel()"
            />
          }
          @if (actions().reprint) {
            <p-button
              type="button"
              severity="secondary"
              [label]="'orders.print.reprint' | transloco"
              [disabled]="mutating()"
              (onClick)="reprintOpen.set(true)"
            />
          }
          @if (canPreview()) {
            <a [href]="previewHref()" target="_blank" rel="noopener">{{
              'orders.print.preview' | transloco
            }}</a>
          }
        }
      </div>
      @if (storageBlocked()) {
        <p role="alert">{{ 'orders.print.storage' | transloco }}</p>
      }
      @if (reprintOpen() && !pending() && !cannotCheck()) {
        <div
          class="dialog"
          role="dialog"
          [attr.aria-label]="'orders.print.reprintTitle' | transloco"
        >
          @if (actions().warning) {
            <p class="print-warning">{{ 'orders.print.mayStillPrint' | transloco }}</p>
          }
          <label>
            {{ 'orders.print.reason' | transloco }}
            <textarea
              class="control"
              [value]="reprintReason()"
              (input)="onReason($event)"
            ></textarea>
          </label>
          <p-button
            type="button"
            [label]="'orders.print.reprint' | transloco"
            [disabled]="mutating() || reprintReason().length < 5"
            (onClick)="print(true)"
          />
          <p-button
            type="button"
            severity="secondary"
            [label]="'orders.print.back' | transloco"
            (onClick)="reprintOpen.set(false)"
          />
        </div>
      }
    </article>
  `,
})
export class PrintPanelComponent {
  private readonly http = inject(HttpClient);
  private readonly transloco = inject(TranslocoService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly pollMs = inject(PRINT_POLL_MS);
  private readonly pollLimitMs = inject(PRINT_POLL_LIMIT_MS);

  readonly companyId = input.required<string>();
  readonly orderId = input.required<string>();
  readonly documentType = input.required<'packing_slip' | 'gift_message'>();
  readonly job = input<PrintSlot | null>(null);
  readonly canSubmit = input(false);
  readonly canReprint = input(false);
  readonly canConfirm = input(false);
  readonly canPreview = input(false);
  readonly firstPrintAvailable = input(true);
  readonly zone = input('Asia/Nicosia');
  readonly lang = input('en');
  readonly changed = output<boolean>();

  readonly live = signal<PrintSlot | null>(null);
  readonly waiting = signal(false);
  readonly pollDenied = signal(false);
  readonly mutating = signal(false);
  readonly reprintOpen = signal(false);
  readonly reprintReason = signal('');
  /**
   * A print request whose outcome is unknown. It keeps its request key, so sending it again
   * returns the job it may already have created. Session storage keeps it across a reload.
   */
  readonly pending = signal<PendingPrint | null>(null);
  /** A retry of a lost request was refused: the user may discard it after checking the history. */
  readonly retryRefused = signal(false);
  /** The browser would not keep the request, so nothing was sent. */
  readonly storageBlocked = signal(false);
  /**
   * The saved note could not be read. A new print or reprint would replace a request whose
   * outcome is unknown, so both stay refused until a later read succeeds.
   */
  readonly cannotCheck = signal(false);
  readonly shown = computed(() => this.live() ?? this.job());
  readonly actions = computed(() =>
    printActions(this.shown()?.status ?? null, this.firstPrintAvailable(), {
      submit: this.canSubmit(),
      reprint: this.canReprint(),
      confirm: this.canConfirm(),
    }),
  );
  private pollGeneration = 0;
  private pollSeq = 0;
  private appliedPoll = 0;
  private mutation = 0;
  /** Bumped when the company, order or document changes, so a late answer is ignored. */
  private generation = 0;

  constructor() {
    effect(() => {
      const storageKey = this.storageKey();
      this.generation += 1;
      this.mutating.set(false);
      this.retryRefused.set(false);
      this.storageBlocked.set(false);
      this.reprintOpen.set(false);
      this.reprintReason.set('');
      untracked(() => {
        this.loadStored(storageKey);
      });
    });

    effect((onCleanup) => {
      const job = this.job();
      const companyId = this.companyId();
      const orderId = this.orderId();
      const generation = ++this.pollGeneration;
      this.live.set(job);
      this.waiting.set(false);
      this.pollDenied.set(false);
      if (
        !job ||
        orderId.length === 0 ||
        !printActions(job.status, false, noPrintPermissions).poll
      ) {
        return;
      }
      const started = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      const jobId = job.id;

      const arm = (delay: number) => {
        if (stopped || generation !== this.pollGeneration) {
          return;
        }
        timer = setTimeout(run, delay);
      };

      const run = () => {
        if (stopped || generation !== this.pollGeneration) {
          return;
        }
        if (Date.now() - started >= this.pollLimitMs) {
          this.waiting.set(true);
          return;
        }
        const seq = ++this.pollSeq;
        this.http
          .get<{ printJob: PrintSlot }>(`/api/c/${companyId}/print-jobs/${jobId}`)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: (body) => {
              if (stopped || generation !== this.pollGeneration) {
                return;
              }
              if (seq < this.appliedPoll) {
                arm(this.pollMs);
                return;
              }
              this.appliedPoll = seq;
              const next = body.printJob;
              this.live.set(next);
              if (!printActions(next.status, false, noPrintPermissions).poll) {
                this.changed.emit(true);
                return;
              }
              if (Date.now() - started >= this.pollLimitMs) {
                this.waiting.set(true);
                return;
              }
              arm(this.pollMs);
            },
            error: (error: unknown) => {
              if (stopped || generation !== this.pollGeneration) {
                return;
              }
              if (isPollDenied(error)) {
                this.pollDenied.set(true);
                this.waiting.set(false);
                return;
              }
              if (Date.now() - started >= this.pollLimitMs) {
                this.waiting.set(true);
                return;
              }
              arm(this.pollMs);
            },
          });
      };

      arm(this.pollMs);
      onCleanup(() => {
        stopped = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
    });
  }

  titleKey(): string {
    return this.documentType() === 'packing_slip'
      ? 'orders.print.packingSlip'
      : 'orders.print.giftMessage';
  }

  statusLabel(status: string): string {
    return translateCode(this.transloco, 'orders.printStatus', status);
  }

  previewHref(): string {
    const file = this.documentType() === 'packing_slip' ? 'packing-slip.pdf' : 'gift-message.pdf';
    return `/api/c/${this.companyId()}/orders/${this.orderId()}/documents/${file}`;
  }

  onReason(event: Event): void {
    this.reprintReason.set(fieldValue(event));
  }

  print(reprint: boolean): void {
    const current = this.shown();
    if (this.mutating() || this.pending() || this.cannotCheck()) {
      return;
    }
    if (reprint && (this.reprintReason().length < 5 || !current)) {
      return;
    }
    const body: Record<string, unknown> = {
      documentType: this.documentType(),
      sourceType: 'order',
      sourceId: this.orderId(),
      requestKey: crypto.randomUUID(),
      ...(reprint && current
        ? { reprint: { ofPrintJobId: current.id, reason: this.reprintReason() } }
        : {}),
    };
    // Remembered before it is sent. Without a saved copy a lost answer could not be recovered.
    if (!this.remember({ body, lost: false })) {
      this.storageBlocked.set(true);
      return;
    }
    this.storageBlocked.set(false);
    this.send(body);
  }

  /** Reads the saved note again. A new print stays refused while it still cannot be read. */
  checkAgain(): void {
    this.loadStored(this.storageKey());
    if (!this.cannotCheck()) {
      this.storageBlocked.set(false);
      this.retryRefused.set(false);
      this.reprintOpen.set(false);
    }
  }

  /** Sends the request whose answer was lost, unchanged. The API returns its job if it exists. */
  retry(): void {
    const pending = this.pending();
    if (!pending || this.mutating()) {
      return;
    }
    this.send(pending.body);
  }

  /** Gives up a lost request after a refused retry; the history shows whether it printed. */
  discard(): void {
    const pending = this.pending();
    if (!pending || !this.retryRefused() || this.mutating()) {
      return;
    }
    this.clearPending(requestKeyOf(pending.body));
    this.retryRefused.set(false);
  }

  private send(body: Record<string, unknown>): void {
    this.mutating.set(true);
    const generation = this.generation;
    const mutation = ++this.mutation;
    const key = requestKeyOf(body);
    this.http
      .post<unknown>(`/api/c/${this.companyId()}/print-requests`, body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation !== this.generation || mutation !== this.mutation) {
            return;
          }
          this.mutating.set(false);
          const job = readablePrintJob(response);
          if (job === null) {
            // A reply without the job: the outcome is still unknown, so the request is kept.
            this.markLost(key);
            this.changed.emit(true);
            return;
          }
          this.clearPending(key);
          this.retryRefused.set(false);
          this.live.set(job);
          this.reprintOpen.set(false);
          this.reprintReason.set('');
          this.changed.emit(true);
        },
        error: (error: unknown) => {
          if (generation !== this.generation || mutation !== this.mutation) {
            return;
          }
          this.mutating.set(false);
          if (unknownPrintOutcome(error)) {
            // Kept: the only way on is to send the same request again.
            this.markLost(key);
            this.changed.emit(true);
            return;
          }
          if (this.pending()?.lost && requestKeyOf(this.pending()?.body) === key) {
            // This attempt was refused, but an earlier one may have been queued: keep it.
            this.retryRefused.set(true);
            this.changed.emit(true);
            return;
          }
          // A definite refusal of the only attempt: nothing was queued.
          this.clearPending(key);
          if (isAlreadyPrinted(error)) {
            this.changed.emit(true);
          }
        },
      });
  }

  private storageKey(): string {
    return `bp.orderPrint.${this.companyId()}.${this.orderId()}.${this.documentType()}`;
  }

  /** A failed read is kept: it must not be treated as "no earlier request". */
  private loadStored(storageKey: string): void {
    const read = readPendingPrint(() => sessionStorage, storageKey);
    if (read.kind === 'unreadable') {
      this.cannotCheck.set(true);
      this.pending.set(null);
      return;
    }
    this.cannotCheck.set(false);
    this.pending.set(read.kind === 'pending' ? read.pending : null);
  }

  /** Only the request that owns the saved key may change it. */
  private markLost(key: string | null): void {
    const pending = this.pending();
    if (pending && !pending.lost && requestKeyOf(pending.body) === key) {
      this.setPending({ ...pending, lost: true });
      this.reprintOpen.set(false);
    }
  }

  private clearPending(key: string | null): void {
    if (requestKeyOf(this.pending()?.body) === key) {
      this.pending.set(null);
    }
    removePendingPrintIfKey(() => sessionStorage, this.storageKey(), key);
  }

  /** False when the browser would not save it; the page still holds it until it is closed. */
  private setPending(pending: PendingPrint): boolean {
    this.pending.set(pending);
    return writePendingPrint(() => sessionStorage, this.storageKey(), pending);
  }

  /**
   * Saves the exact request before it is sent. A write that throws, or that does not stick,
   * sends nothing: a lost answer could not be repeated unchanged.
   */
  private remember(pending: PendingPrint): boolean {
    if (!this.setPending(pending)) {
      this.pending.set(null);
      return false;
    }
    try {
      if (sessionStorage.getItem(this.storageKey()) === JSON.stringify(pending)) {
        return true;
      }
    } catch {
      this.pending.set(null);
      return false;
    }
    this.pending.set(null);
    return false;
  }

  confirm(outcome: 'printed' | 'not_printed'): void {
    const current = this.shown();
    if (!current || this.mutating()) {
      return;
    }
    this.mutating.set(true);
    const mutation = ++this.mutation;
    this.http
      .post<{ printJob: PrintSlot }>(
        `/api/c/${this.companyId()}/print-jobs/${current.id}/confirm`,
        { outcome },
      )
      .subscribe({
        next: (response) => {
          if (mutation !== this.mutation) {
            return;
          }
          this.live.set(response.printJob);
          this.mutating.set(false);
          this.changed.emit(true);
        },
        error: () => {
          if (mutation !== this.mutation) {
            return;
          }
          this.mutating.set(false);
        },
      });
  }

  cancel(): void {
    const current = this.shown();
    if (!current || this.mutating()) {
      return;
    }
    this.mutating.set(true);
    const mutation = ++this.mutation;
    this.http
      .post<{ printJob: PrintSlot }>(
        `/api/c/${this.companyId()}/print-jobs/${current.id}/cancel`,
        {},
      )
      .subscribe({
        next: (response) => {
          if (mutation !== this.mutation) {
            return;
          }
          this.live.set(response.printJob);
          this.mutating.set(false);
          this.changed.emit(true);
        },
        error: () => {
          if (mutation !== this.mutation) {
            return;
          }
          this.mutating.set(false);
        },
      });
  }
}
