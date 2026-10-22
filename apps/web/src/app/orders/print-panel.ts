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
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { isAlreadyPrinted } from '../core/api-error';
import { CompanyDatePipe } from '../format/company-date.pipe';
import { translateCode } from './labels';
import type { PrintSlot } from './models';
import { printActions } from './print-actions';
import { fieldValue } from './field-value';

const noPrintPermissions = { submit: false, reprint: false, confirm: false };

function isPollDenied(error: unknown): boolean {
  return error instanceof HttpErrorResponse && (error.status === 403 || error.status === 404);
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
          <a [href]="previewHref()" target="_blank" rel="noopener">{{ 'orders.print.preview' | transloco }}</a>
        }
      </div>
      @if (reprintOpen()) {
        <div class="dialog" role="dialog" [attr.aria-label]="'orders.print.reprintTitle' | transloco">
          @if (actions().warning) {
            <p class="print-warning">{{ 'orders.print.mayStillPrint' | transloco }}</p>
          }
          <label>
            {{ 'orders.print.reason' | transloco }}
            <textarea class="control" [value]="reprintReason()" (input)="onReason($event)"></textarea>
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

  constructor() {
    effect((onCleanup) => {
      const job = this.job();
      const companyId = this.companyId();
      const orderId = this.orderId();
      const generation = ++this.pollGeneration;
      this.live.set(job);
      this.waiting.set(false);
      this.pollDenied.set(false);
      if (!job || orderId.length === 0 || !printActions(job.status, false, noPrintPermissions).poll) {
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
    return this.documentType() === 'packing_slip' ? 'orders.print.packingSlip' : 'orders.print.giftMessage';
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
    if (this.mutating()) {
      return;
    }
    if (reprint && (this.reprintReason().length < 5 || !current)) {
      return;
    }
    this.mutating.set(true);
    const mutation = ++this.mutation;
    const body = {
      documentType: this.documentType(),
      sourceType: 'order',
      sourceId: this.orderId(),
      ...(reprint && current
        ? { reprint: { ofPrintJobId: current.id, reason: this.reprintReason() } }
        : {}),
    };
    this.http.post<{ printJob: PrintSlot }>(`/api/c/${this.companyId()}/print-requests`, body).subscribe({
      next: (response) => {
        if (mutation !== this.mutation) {
          return;
        }
        this.live.set(response.printJob);
        this.reprintOpen.set(false);
        this.reprintReason.set('');
        this.mutating.set(false);
        this.changed.emit(true);
      },
      error: (error: unknown) => {
        if (mutation !== this.mutation) {
          return;
        }
        this.mutating.set(false);
        if (isAlreadyPrinted(error)) {
          this.changed.emit(true);
        }
      },
    });
  }

  confirm(outcome: 'printed' | 'not_printed'): void {
    const current = this.shown();
    if (!current || this.mutating()) {
      return;
    }
    this.mutating.set(true);
    const mutation = ++this.mutation;
    this.http
      .post<{ printJob: PrintSlot }>(`/api/c/${this.companyId()}/print-jobs/${current.id}/confirm`, { outcome })
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
    this.http.post<{ printJob: PrintSlot }>(`/api/c/${this.companyId()}/print-jobs/${current.id}/cancel`, {}).subscribe({
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
