import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { CompanyContextStore } from '../core/company-context.store';
import { companyToday } from '../invoices/delivery-deadline';
import { fieldValue } from '../orders/field-value';
import { positiveMoney } from './payment-view';

export type RecordFields = {
  amount: string;
  date: string;
  method: string;
  reference: string;
  notes: string;
};

/** Shared typed fields for money already received or paid back. Customer text stays untouched. */
@Component({
  selector: 'bp-money-record-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, Button],
  host: { class: 'span-all' },
  template: `
    <div class="form-grid">
      <label
        >{{ 'payments.amount' | transloco
        }}<input
          inputmode="decimal"
          [disabled]="disabled()"
          [value]="amount()"
          (input)="amount.set(field($event))"
      /></label>
      <label
        >{{ (refund() ? 'payments.refundedOn' : 'payments.receivedOn') | transloco
        }}<input
          type="date"
          [disabled]="disabled()"
          [max]="today()"
          [value]="date()"
          (input)="date.set(field($event))"
      /></label>
      <label
        >{{ 'payments.method' | transloco
        }}<select [disabled]="disabled()" (change)="method.set(field($event))">
          @for (item of methods; track item) {
            <option [value]="item" [selected]="method() === item">
              {{ 'payments.methods.' + item | transloco }}
            </option>
          }
        </select></label
      >
      <label
        >{{ 'payments.reference' | transloco
        }}<input
          maxlength="200"
          [disabled]="disabled()"
          [value]="reference()"
          (input)="reference.set(field($event))"
      /></label>
      <label class="span-all"
        >{{ 'payments.notes' | transloco
        }}<textarea
          maxlength="20000"
          [disabled]="disabled()"
          [value]="notes()"
          (input)="notes.set(field($event))"
        ></textarea>
      </label>
      @if (!refund()) {
        <label class="check span-all"
          ><input
            type="checkbox"
            [disabled]="disabled()"
            [checked]="apply()"
            (change)="toggle($event)"
          />{{ 'payments.applyHere' | transloco }}</label
        >
      }
      @if (problem()) {
        <p role="alert">{{ 'payments.errors.fields' | transloco }}</p>
      }
      @if (showSubmit()) {
        <div class="form-actions">
          <p-button
            type="button"
            [label]="(refund() ? 'payments.recordRefund' : 'payments.record') | transloco"
            [disabled]="disabled()"
            (onClick)="submit()"
          />
        </div>
      }
    </div>
  `,
})
export class MoneyRecordForm {
  private readonly context = inject(CompanyContextStore);
  readonly initialAmount = input('');
  readonly disabled = input(false);
  readonly showSubmit = input(true);
  readonly refund = input(false);
  readonly submitted = output<RecordFields & { apply: boolean }>();
  readonly field = fieldValue;
  readonly methods = ['bank_transfer', 'card', 'cash', 'store', 'other'];
  readonly amount = signal('');
  readonly date = signal('');
  readonly method = signal('bank_transfer');
  readonly reference = signal('');
  readonly notes = signal('');
  readonly apply = signal(true);
  readonly problem = signal(false);
  constructor() {
    effect(() => {
      this.amount.set(this.initialAmount());
      this.date.set(this.today());
    });
  }
  today(): string {
    return companyToday(this.context.timezone());
  }
  toggle(event: Event): void {
    this.apply.set(event.target instanceof HTMLInputElement && event.target.checked);
  }
  submit(): void {
    if (this.disabled()) return;
    const amount = positiveMoney(this.amount());
    if (!amount || !this.date() || this.date() > this.today()) {
      this.problem.set(true);
      return;
    }
    this.problem.set(false);
    this.submitted.emit({
      amount,
      date: this.date(),
      method: this.method(),
      reference: this.reference(),
      notes: this.notes(),
      apply: this.apply(),
    });
  }
}
