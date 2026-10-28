import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { Tag } from 'primeng/tag';
import { CompanyContextStore } from '../core/company-context.store';
import { canAttempt } from '../core/nav';
import { calendarDate } from '../invoices/invoice-query';
import { fieldValue } from '../orders/field-value';
import { CreateRequests } from './create-requests';
import {
  paymentFailure,
  smallerMoney,
  type AllocationView,
  type Failure,
  type PaymentState,
} from './payment-view';
import { MoneyRecordForm, type RecordFields } from './record-form';

@Component({
  selector: 'bp-invoice-payments',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'span-all' },
  imports: [RouterLink, TranslocoPipe, Button, Tag, MoneyRecordForm],
  template: `
    <section class="card span-all" data-testid="invoice-payments">
      <h2>{{ 'payments.title' | transloco }}</h2>
      <p>{{ 'payments.openBalance' | transloco }}: {{ openBalance() }} {{ currency() }}</p>
      <p-tag
        [value]="'payments.states.' + paymentState() | transloco"
        [severity]="paymentState() === 'paid' ? 'success' : 'warn'"
      />
      <p>{{ 'payments.recordHelp' | transloco }}</p>
      @if (allocations().length) {
        <ul class="credit-list" data-testid="allocations">
          @for (item of allocations(); track item.id) {
            <li>
              @if (item.source; as source) {
                @if (source.type === 'payment') {
                  {{ dateLabel(source.receivedOn) }} · {{ source.reference }}
                } @else {
                  <a [routerLink]="['/c', companyId(), 'invoices', source.id]">{{
                    source.number
                  }}</a>
                }
              }
              · {{ item.amount }} {{ currency() }} · {{ 'payments.effectiveOn' | transloco }}
              {{ dateLabel(item.effectiveOn) }}
              @if (item.reversedOn) {
                <p>
                  {{ 'payments.reversedOn' | transloco }} {{ dateLabel(item.reversedOn) }}:
                  {{ item.reversalReason }}
                </p>
              } @else if (canRecord() && !creates.pending()) {
                <label
                  >{{ 'payments.reason' | transloco
                  }}<input
                    maxlength="500"
                    [disabled]="locked()"
                    [value]="reasons()[item.id] ?? ''"
                    (input)="setReason(item.id, $event)"
                /></label>
                <p-button
                  type="button"
                  severity="secondary"
                  [label]="'payments.reverse' | transloco"
                  [disabled]="locked() || !(reasons()[item.id] ?? '').trim()"
                  (onClick)="reverse(item.id)"
                />
              }
            </li>
          }
        </ul>
      }
      @if (canRecord()) {
        @if (creates.pending()) {
          <p role="status">{{ 'payments.pending' | transloco }}</p>
          <p-button
            type="button"
            [label]="'payments.retry' | transloco"
            [disabled]="locked()"
            (onClick)="retry()"
          />
          @if (creates.retryRefused()) {
            <p>{{ 'payments.discardHelp' | transloco }}</p>
            <p-button
              type="button"
              severity="secondary"
              [label]="'payments.discard' | transloco"
              [disabled]="locked()"
              (onClick)="discard()"
            />
          }
        }
        @if (formOpen()) {
          <h3>{{ 'payments.record' | transloco }}</h3>
          <bp-money-record-form
            [initialAmount]="openBalance()"
            [disabled]="locked() || creates.blocked() || !!creates.pending()"
            [showSubmit]="!creates.pending()"
            (submitted)="record($event)"
          />
        } @else if (!creates.pending()) {
          <p-button
            type="button"
            [label]="'payments.recordAnother' | transloco"
            [disabled]="locked() || creates.blocked()"
            (onClick)="recordAnother()"
          />
        }
      }
      @if (notice(); as key) {
        <p role="status">{{ key | transloco }}</p>
      }
      @if (creates.failure() ?? failure(); as item) {
        <p role="alert">{{ item.key | transloco }}</p>
        @if (item.correlationId) {
          <p>{{ 'errors.correlation' | transloco }}: {{ item.correlationId }}</p>
        }
      }
    </section>
  `,
})
export class InvoicePayments {
  private readonly context = inject(CompanyContextStore);
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  readonly companyId = input.required<string>();
  readonly invoiceId = input.required<string>();
  readonly clientId = input.required<string>();
  readonly currency = input('EUR');
  readonly openBalance = input.required<string>();
  readonly paymentState = input.required<PaymentState>();
  readonly allocations = input<readonly AllocationView[]>([]);
  readonly frozen = input(false);
  readonly changed = output();
  readonly creates = new CreateRequests();
  readonly busy = signal(false);
  readonly reasons = signal<Record<string, string>>({});
  readonly failure = signal<Failure | null>(null);
  readonly notice = signal<string | null>(null);
  readonly formOpen = signal(true);
  readonly locked = computed(() => this.busy() || this.creates.busy() || this.frozen());
  readonly dateLabel = calendarDate;
  private generation = 0;
  constructor() {
    effect(() => {
      const company = this.companyId();
      const invoice = this.invoiceId();
      untracked(() => {
        this.generation += 1;
        this.busy.set(false);
        this.failure.set(null);
        this.notice.set(null);
        this.formOpen.set(true);
        this.reasons.set({});
        this.creates.reset(
          company,
          `invoice.${invoice}`,
          ['allocations', 'payments'],
          (operation, id, request) => {
            this.formOpen.set(false);
            if (operation === 'payments' && request.followUp) {
              this.notice.set(null);
              this.creates.start('allocations', {
                paymentId: id,
                invoiceId: request.followUp.invoiceId,
                amount: request.followUp.amount,
              });
              // Even a storage failure on the allocation must refresh the recorded payment.
              if (!this.creates.busy() && !this.creates.pending()) {
                this.notice.set('payments.recordedCredit');
                this.changed.emit();
              }
            } else {
              this.notice.set('payments.saved');
              this.changed.emit();
            }
          },
          (operation) => {
            if (operation === 'allocations') {
              this.notice.set('payments.recordedCredit');
              this.changed.emit();
            }
          },
          () => {
            this.changed.emit();
          },
        );
      });
    });
  }
  canRecord(): boolean {
    return canAttempt(
      this.context.grants(),
      this.context.withheldPermissions(),
      this.context.mfaStepUpRequired(),
      'payment.record',
    );
  }
  record(fields: RecordFields & { apply: boolean }): void {
    if (!this.canRecord() || this.locked() || !this.formOpen()) return;
    this.failure.set(null);
    this.notice.set(null);
    const allocation = smallerMoney(fields.amount, this.openBalance());
    this.creates.start(
      'payments',
      {
        clientId: this.clientId(),
        amount: fields.amount,
        receivedOn: fields.date,
        method: fields.method,
        reference: fields.reference,
        notes: fields.notes,
      },
      fields.apply && allocation !== '0.00' && allocation !== '0'
        ? { invoiceId: this.invoiceId(), amount: allocation }
        : undefined,
    );
  }
  retry(): void {
    if (!this.canRecord() || this.locked()) return;
    this.notice.set(null);
    this.failure.set(null);
    this.creates.retry();
  }
  discard(): void {
    if (this.canRecord() && !this.locked() && this.creates.discard()) {
      this.formOpen.set(false);
      this.changed.emit();
    }
  }
  recordAnother(): void {
    if (!this.canRecord() || this.locked() || this.creates.pending() || this.creates.blocked())
      return;
    this.notice.set(null);
    this.formOpen.set(true);
  }
  setReason(id: string, event: Event): void {
    this.reasons.update((prior) => ({ ...prior, [id]: fieldValue(event) }));
  }
  reverse(id: string): void {
    const reason = this.reasons()[id] ?? '';
    if (!this.canRecord() || this.locked() || this.creates.pending() || !reason.trim()) return;
    this.busy.set(true);
    this.notice.set(null);
    this.failure.set(null);
    this.creates.failure.set(null);
    const generation = this.generation;
    this.http
      .post(`/api/c/${this.companyId()}/allocations/${id}/reverse`, { reason })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          if (generation === this.generation) {
            this.busy.set(false);
            this.changed.emit();
          }
        },
        error: (error: unknown) => {
          if (generation === this.generation) {
            this.busy.set(false);
            this.failure.set(paymentFailure(error));
          }
        },
      });
  }
}
