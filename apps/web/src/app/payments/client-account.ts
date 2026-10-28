import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { forkJoin } from 'rxjs';
import { CompanyContextStore } from '../core/company-context.store';
import { canAttempt } from '../core/nav';
import { calendarDate } from '../invoices/invoice-query';
import { fieldValue } from '../orders/field-value';
import { CreateRequests } from './create-requests';
import {
  paymentFailure,
  positiveMoney,
  smallerMoney,
  type AccountView,
  type ClientCredit,
  type Failure,
  type PaymentDetail,
  type RefundView,
} from './payment-view';
import { MoneyRecordForm, type RecordFields } from './record-form';

@Component({
  selector: 'bp-client-account',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'span-all' },
  imports: [RouterLink, TranslocoPipe, Button, MoneyRecordForm],
  template: `
    <section class="card span-all" data-testid="client-account">
      <h2>{{ 'payments.account' | transloco }}</h2>
      @if (loading()) {
        <p role="status">{{ 'payments.loading' | transloco }}</p>
      }
      <p-button
        type="button"
        severity="secondary"
        [label]="'common.reload' | transloco"
        [disabled]="locked()"
        (onClick)="reload()"
      />
      @if (account(); as value) {
        <h3>{{ 'payments.openInvoices' | transloco }}</h3>
        @if (!value.openInvoices.length) {
          <p>{{ 'payments.noOpenInvoices' | transloco }}</p>
        } @else {
          <div class="table-scroll">
            <table class="credit-lines">
              <thead>
                <tr>
                  <th>{{ 'invoices.columns.number' | transloco }}</th>
                  <th>{{ 'invoices.columns.issueDate' | transloco }}</th>
                  <th>{{ 'invoices.columns.dueDate' | transloco }}</th>
                  <th>{{ 'invoices.columns.total' | transloco }}</th>
                  <th>{{ 'payments.openBalance' | transloco }}</th>
                </tr>
              </thead>
              <tbody>
                @for (invoice of value.openInvoices; track invoice.id) {
                  <tr>
                    <td>
                      <a [routerLink]="['/c', companyId(), 'invoices', invoice.id]">{{
                        invoice.number
                      }}</a>
                    </td>
                    <td>{{ dateLabel(invoice.issueDate) }}</td>
                    <td>{{ dateLabel(invoice.dueDate) }}</td>
                    <td>{{ invoice.total }}</td>
                    <td>{{ invoice.openBalance }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        <p>
          {{ 'payments.openTotal' | transloco }}: {{ value.openTotal }} {{ context.currency() }}
        </p>
        <h3>{{ 'payments.credits' | transloco }}</h3>
        @if (!value.credits.length) {
          <p>{{ 'payments.noCredits' | transloco }}</p>
        }
        @for (credit of value.credits; track credit.id) {
          <article class="repeat-item" data-testid="client-credit">
            <p>
              @if (credit.type === 'payment') {
                {{ 'payments.payment' | transloco }} · {{ dateLabel(credit.receivedOn) }} ·
                {{ credit.reference }}
              } @else {
                <a [routerLink]="['/c', companyId(), 'invoices', credit.id]">{{ credit.number }}</a>
                · {{ dateLabel(credit.issueDate) }}
              }
            </p>
            <p>
              {{ 'payments.remaining' | transloco }}: {{ credit.remaining }}
              {{ context.currency() }}
            </p>
            @if (canRecord()) {
              <div class="form-actions">
                <p-button
                  type="button"
                  severity="secondary"
                  [label]="'payments.apply' | transloco"
                  [disabled]="locked() || !!creates.pending() || !value.openInvoices.length"
                  (onClick)="selectCredit(credit, 'apply')"
                />
                <p-button
                  type="button"
                  severity="secondary"
                  [label]="'payments.recordRefund' | transloco"
                  [disabled]="locked() || !!creates.pending()"
                  (onClick)="selectCredit(credit, 'refund')"
                />
              </div>
            }
          </article>
        }
        <p>
          {{ 'payments.creditTotal' | transloco }}: {{ value.creditTotal }} {{ context.currency() }}
        </p>
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
          @if (selected(); as credit) {
            <section class="repeat-item" data-testid="credit-action">
              <h3>
                {{ (mode() === 'apply' ? 'payments.apply' : 'payments.recordRefund') | transloco }}
              </h3>
              <p>
                {{ credit.type === 'payment' ? credit.reference : credit.number }} ·
                {{ 'payments.remaining' | transloco }}: {{ credit.remaining }}
              </p>
              @if (mode() === 'apply') {
                <div class="form-grid">
                  <label
                    >{{ 'payments.target' | transloco
                    }}<select
                      [disabled]="locked() || !!creates.pending()"
                      (change)="chooseInvoice($event)"
                    >
                      @for (invoice of value.openInvoices; track invoice.id) {
                        <option [value]="invoice.id" [selected]="invoice.id === invoiceId()">
                          {{ invoice.number }} · {{ invoice.openBalance }}
                        </option>
                      }
                    </select></label
                  >
                  <label
                    >{{ 'payments.amount' | transloco
                    }}<input
                      inputmode="decimal"
                      [disabled]="locked() || !!creates.pending()"
                      [value]="amount()"
                      (input)="amount.set(field($event))"
                  /></label>
                  @if (!creates.pending()) {
                    <div class="form-actions">
                      <p-button
                        type="button"
                        [label]="'payments.apply' | transloco"
                        [disabled]="locked() || creates.blocked()"
                        (onClick)="allocate()"
                      />
                    </div>
                  }
                </div>
              } @else {
                <p>{{ 'payments.refundHelp' | transloco }}</p>
                <bp-money-record-form
                  [refund]="true"
                  [initialAmount]="credit.remaining"
                  [disabled]="locked() || creates.blocked() || !!creates.pending()"
                  [showSubmit]="!creates.pending()"
                  (submitted)="refund($event)"
                />
              }
            </section>
          }
          <h3>{{ 'payments.paymentHistory' | transloco }}</h3>
          <p>{{ 'payments.recordHelp' | transloco }}</p>
          <ul class="credit-list">
            @for (item of payments(); track item.id) {
              <li>
                {{ dateLabel(item.receivedOn) }} · {{ item.reference }} · {{ item.amount }} ·
                {{ 'payments.recordStatus.' + item.status | transloco }}
                <p-button
                  type="button"
                  severity="secondary"
                  [label]="'payments.details' | transloco"
                  [disabled]="locked() || !!creates.pending()"
                  (onClick)="showPayment(item.id)"
                />
              </li>
            }
          </ul>
          @if (detail(); as payment) {
            <section class="repeat-item" data-testid="payment-detail">
              <h3>{{ 'payments.payment' | transloco }} · {{ payment.reference }}</h3>
              @if (payment.status === 'recorded') {
                <label
                  >{{ 'payments.reason' | transloco
                  }}<input
                    maxlength="500"
                    [disabled]="locked() || !!creates.pending()"
                    [value]="voidReason()"
                    (input)="voidReason.set(field($event))"
                /></label>
                <p-button
                  type="button"
                  severity="secondary"
                  [label]="'payments.voidPayment' | transloco"
                  [disabled]="locked() || !!creates.pending() || !voidReason().trim()"
                  (onClick)="voidPayment()"
                />
              }
              <h4>{{ 'payments.refunds' | transloco }}</h4>
              @for (item of payment.refunds; track item.id) {
                <article class="repeat-item" data-testid="refund-detail">
                  <p>
                    {{ item.amount }} · {{ dateLabel(item.refundedOn) }} ·
                    {{ 'payments.recordStatus.' + item.status | transloco }}
                  </p>
                  @if (item.status === 'recorded') {
                    <label
                      >{{ 'payments.reason' | transloco
                      }}<input
                        maxlength="500"
                        [disabled]="locked() || !!creates.pending()"
                        [value]="refundReasons()[item.id] ?? ''"
                        (input)="setRefundReason(item.id, $event)"
                    /></label>
                    <p-button
                      type="button"
                      severity="secondary"
                      [label]="'payments.voidRefund' | transloco"
                      [disabled]="
                        locked() || !!creates.pending() || !(refundReasons()[item.id] ?? '').trim()
                      "
                      (onClick)="voidRefund(item)"
                    />
                  } @else {
                    <p>{{ item.voidReason }}</p>
                  }
                </article>
              }
            </section>
          }
        }
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
export class ClientAccount {
  readonly context = inject(CompanyContextStore);
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  readonly companyId = input.required<string>();
  readonly clientId = input.required<string>();
  readonly creates = new CreateRequests();
  readonly account = signal<AccountView | null>(null);
  readonly payments = signal<PaymentDetail[]>([]);
  readonly detail = signal<PaymentDetail | null>(null);
  readonly selected = signal<ClientCredit | null>(null);
  readonly mode = signal<'apply' | 'refund'>('apply');
  readonly amount = signal('');
  readonly invoiceId = signal('');
  readonly voidReason = signal('');
  readonly refundReasons = signal<Record<string, string>>({});
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly failure = signal<Failure | null>(null);
  readonly locked = computed(() => this.busy() || this.creates.busy() || this.loading());
  readonly field = fieldValue;
  readonly dateLabel = calendarDate;
  private generation = 0;
  private loadSequence = 0;
  private detailSequence = 0;
  private selectedPaymentId: string | null = null;
  constructor() {
    effect(() => {
      const company = this.companyId();
      const client = this.clientId();
      untracked(() => {
        this.generation += 1;
        this.detailSequence += 1;
        this.selectedPaymentId = null;
        this.busy.set(false);
        this.selected.set(null);
        this.detail.set(null);
        this.account.set(null);
        this.payments.set([]);
        this.failure.set(null);
        this.creates.reset(
          company,
          `client.${client}`,
          ['allocations', 'refunds'],
          (_operation, _id, request) => {
            this.selected.set(null);
            const paymentId = request.body['paymentId'];
            this.reload(typeof paymentId === 'string' ? paymentId : undefined);
          },
        );
        this.reload();
      });
    });
  }
  canView(): boolean {
    return canAttempt(
      this.context.grants(),
      this.context.withheldPermissions(),
      this.context.mfaStepUpRequired(),
      'invoice.view',
    );
  }
  canRecord(): boolean {
    return canAttempt(
      this.context.grants(),
      this.context.withheldPermissions(),
      this.context.mfaStepUpRequired(),
      'payment.record',
    );
  }
  reload(paymentId?: string): void {
    if (!this.canView()) return;
    if (!this.creates.pending()) this.selected.set(null);
    const generation = this.generation;
    const sequence = ++this.loadSequence;
    this.loading.set(true);
    this.failure.set(null);
    // Refresh the selection now; an account answer must never restore an older selection.
    const id = paymentId ?? this.selectedPaymentId;
    if (id) this.showPayment(id);
    forkJoin({
      account: this.http.get<AccountView>(
        `/api/c/${this.companyId()}/clients/${this.clientId()}/account`,
      ),
      payments: this.http.get<{ payments: PaymentDetail[] }>(
        `/api/c/${this.companyId()}/payments`,
        { params: { clientId: this.clientId() } },
      ),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ account, payments }) => {
          if (generation !== this.generation || sequence !== this.loadSequence) return;
          this.account.set(account);
          this.payments.set(payments.payments);
          this.loading.set(false);
        },
        error: (error: unknown) => {
          if (generation === this.generation && sequence === this.loadSequence) {
            this.loading.set(false);
            this.failure.set(paymentFailure(error));
          }
        },
      });
  }
  selectCredit(credit: ClientCredit, mode: 'apply' | 'refund'): void {
    if (!this.canRecord() || this.locked() || this.creates.pending()) return;
    this.selected.set(credit);
    this.mode.set(mode);
    this.failure.set(null);
    this.creates.failure.set(null);
    const invoice = this.account()?.openInvoices[0];
    this.invoiceId.set(invoice?.id ?? '');
    this.amount.set(
      invoice ? smallerMoney(credit.remaining, invoice.openBalance) : credit.remaining,
    );
  }
  chooseInvoice(event: Event): void {
    if (this.locked()) return;
    this.invoiceId.set(fieldValue(event));
    const invoice = this.account()?.openInvoices.find((item) => item.id === this.invoiceId());
    const credit = this.selected();
    if (invoice && credit) this.amount.set(smallerMoney(credit.remaining, invoice.openBalance));
  }
  allocate(): void {
    const credit = this.selected();
    const amount = positiveMoney(this.amount());
    if (!this.canRecord() || this.locked() || !credit) return;
    this.failure.set(null);
    this.creates.failure.set(null);
    if (!amount || !this.invoiceId()) {
      this.failure.set({ key: 'payments.errors.fields', correlationId: null });
      return;
    }
    this.creates.start('allocations', { ...source(credit), invoiceId: this.invoiceId(), amount });
  }
  refund(fields: RecordFields): void {
    const credit = this.selected();
    if (!this.canRecord() || this.locked() || !credit) return;
    this.failure.set(null);
    this.creates.failure.set(null);
    this.creates.start('refunds', {
      ...source(credit),
      amount: fields.amount,
      refundedOn: fields.date,
      method: fields.method,
      reference: fields.reference,
      notes: fields.notes,
    });
  }
  retry(): void {
    if (!this.canRecord() || this.locked()) return;
    this.failure.set(null);
    this.creates.retry();
  }
  discard(): void {
    if (this.canRecord() && !this.locked() && this.creates.discard()) {
      this.selected.set(null);
      this.reload();
    }
  }
  showPayment(id: string): void {
    if (!this.canView()) return;
    const paymentId = id.toLowerCase();
    if (this.selectedPaymentId !== paymentId) this.detail.set(null);
    this.selectedPaymentId = paymentId;
    const generation = this.generation;
    const sequence = ++this.detailSequence;
    this.busy.set(true);
    this.http
      .get<{ payment: PaymentDetail }>(`/api/c/${this.companyId()}/payments/${paymentId}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ payment }) => {
          if (
            generation === this.generation &&
            sequence === this.detailSequence &&
            paymentId === this.selectedPaymentId
          ) {
            this.detail.set(payment);
            this.voidReason.set('');
            this.refundReasons.set({});
            this.busy.set(false);
          }
        },
        error: (error: unknown) => {
          if (
            generation === this.generation &&
            sequence === this.detailSequence &&
            paymentId === this.selectedPaymentId
          ) {
            this.busy.set(false);
            this.detail.set(null);
            this.failure.set(paymentFailure(error));
          }
        },
      });
  }
  setRefundReason(id: string, event: Event): void {
    this.refundReasons.update((prior) => ({ ...prior, [id]: fieldValue(event) }));
  }
  voidPayment(): void {
    const payment = this.detail();
    if (payment?.status === 'recorded')
      this.void(`payments/${payment.id}/void`, payment.version, this.voidReason());
  }
  voidRefund(refund: RefundView): void {
    if (refund.status === 'recorded')
      this.void(`refunds/${refund.id}/void`, refund.version, this.refundReasons()[refund.id] ?? '');
  }
  private void(path: string, expectedVersion: number, reason: string): void {
    if (!this.canRecord() || this.locked() || this.creates.pending() || !reason.trim()) return;
    const generation = this.generation;
    this.busy.set(true);
    this.failure.set(null);
    this.creates.failure.set(null);
    this.http
      .post(`/api/c/${this.companyId()}/${path}`, { expectedVersion, reason })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          if (generation === this.generation) {
            this.busy.set(false);
            this.reload();
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
function source(credit: ClientCredit): Record<string, string> {
  return credit.type === 'payment' ? { paymentId: credit.id } : { creditNoteId: credit.id };
}
