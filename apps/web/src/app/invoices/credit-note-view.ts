import { HttpClient, HttpErrorResponse } from '@angular/common/http';
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
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { isVersionConflict, readApiError } from '../core/api-error';
import { CompanyContextStore } from '../core/company-context.store';
import { canAttempt } from '../core/nav';
import { fieldValue } from '../orders/field-value';
import type { AllocationView } from '../payments/payment-view';
import { quantityText, quantityUnits } from './credit-quantities';
import { decimalInput } from './decimal-input';
import { calendarDate } from './invoice-query';
import type { InvoiceView } from './invoice-view';

export type CreditNoteLineView = {
  id: string;
  position: number;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountPercent: string;
  taxCode: string;
  lineNet: string;
};

export type CreditNoteDetail = {
  id: string;
  status: string;
  number: string | null;
  version: number;
  currency: string;
  unappliedAmount?: string | null;
  allocations?: readonly AllocationView[];
  creditReason: string;
  creditedInvoice: { id: string; number: string | null; issueDate: string | null } | null;
  netTotal: string;
  taxTotal: string;
  total: string;
  lines: readonly CreditNoteLineView[];
  taxSummary: readonly { taxCode: string; net: string; tax: string; gross: string }[];
};

type Failure = { key: string; correlationId: string | null };

/** API error codes of saving a credit-note draft, and the message each shows. */
const SAVE_ERRORS: Readonly<Record<string, string>> = {
  over_credit: 'invoices.creditNote.errors.overCredit',
  quantity_not_positive: 'invoices.credit.errors.quantity',
  quantity_scale: 'invoices.credit.errors.quantity',
  invalid_quantity: 'invoices.credit.errors.quantity',
  not_draft: 'invoices.issue.errors.notDraft',
};

/** API error codes of issuing a credit note, and the message each shows. */
const ISSUE_ERRORS: Readonly<Record<string, string>> = {
  issuance_disabled: 'invoices.issue.errors.disabled',
  currency_not_supported: 'invoices.issue.errors.currency',
  number_taken: 'invoices.issue.errors.numberTaken',
  series_unavailable: 'invoices.creditNote.errors.series',
  not_draft: 'invoices.issue.errors.notDraft',
  over_credit: 'invoices.creditNote.errors.overCreditAtIssue',
  credit_changed: 'invoices.creditNote.errors.changed',
  not_creditable: 'invoices.credit.errors.notCreditable',
};

/**
 * One credit note. A draft's reason and quantities can change and it can be issued; everything
 * else comes from the invoice it credits, and its amounts are worked out by the API.
 */
@Component({
  selector: 'bp-credit-note',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The editor is a grid; the panel spans it like the other full-width sections.
  host: { class: 'span-all' },
  imports: [TranslocoPipe, RouterLink, Button],
  template: `
    <section class="card span-all" data-testid="credit-note">
      <h2>
        @if (note().number; as number) {
          {{ 'invoices.creditNote.title' | transloco: { number } }}
        } @else {
          {{ 'invoices.creditNote.draftTitle' | transloco }}
        }
      </h2>
      @if (note().creditedInvoice; as original) {
        <p data-testid="credited-invoice">
          {{ 'invoices.creditNote.credits' | transloco }}
          <a [routerLink]="['/c', companyId(), 'invoices', original.id]">{{ original.number }}</a>
          @if (original.issueDate) {
            ({{ dateLabel(original.issueDate) }})
          }
        </p>
      }
      @if (note().status === 'issued') {
        <section data-testid="credit-applications">
          <h3>{{ 'payments.applications' | transloco }}</h3>
          <p>
            {{ 'payments.notApplied' | transloco }}: {{ note().unappliedAmount }}
            {{ note().currency }}
          </p>
          <ul class="credit-list">
            @for (item of note().allocations ?? []; track item.id) {
              <li>
                @if (item.invoice; as target) {
                  <a [routerLink]="['/c', companyId(), 'invoices', target.id]">{{
                    target.number
                  }}</a>
                }
                · {{ item.amount }} · {{ dateLabel(item.effectiveOn) }}
                @if (item.reversedOn) {
                  <p>
                    {{ 'payments.reversedOn' | transloco }} {{ dateLabel(item.reversedOn) }}:
                    {{ item.reversalReason }}
                  </p>
                }
              </li>
            }
          </ul>
          <p>{{ 'payments.applyElsewhere' | transloco }}</p>
        </section>
      }
      @if (editable()) {
        <label class="span-all">
          {{ 'invoices.creditNote.reason' | transloco }}
          <!-- Disabled while a request is out: the reload after it would drop later edits. -->
          <textarea [disabled]="locked()" [value]="reason()" (input)="setReason($event)"></textarea>
        </label>
      } @else {
        <p>{{ 'invoices.creditNote.reason' | transloco }}</p>
        <p class="credit-reason" data-testid="credit-reason">{{ note().creditReason }}</p>
      }
      <div class="table-scroll">
        <table class="credit-lines">
          <thead>
            <tr>
              <th>{{ 'invoices.credit.columns.line' | transloco }}</th>
              <th>{{ 'invoices.fields.quantity' | transloco }}</th>
              <th>{{ 'invoices.fields.unitPrice' | transloco }}</th>
              <th>{{ 'invoices.fields.discount' | transloco }}</th>
              <th>{{ 'invoices.fields.tax' | transloco }}</th>
              <th>{{ 'invoices.totals.net' | transloco }}</th>
            </tr>
          </thead>
          <tbody>
            @for (line of note().lines; track line.id) {
              <tr>
                <td>{{ line.position }}. {{ line.description }}</td>
                <td>
                  @if (editable()) {
                    <input
                      inputmode="decimal"
                      [attr.aria-label]="
                        'invoices.credit.quantityFor' | transloco: { position: line.position }
                      "
                      [disabled]="locked()"
                      [value]="quantityFor(line.id)"
                      (input)="setQuantity(line.id, $event)"
                    />
                  } @else {
                    {{ shortQuantity(line.quantity) }}
                  }
                  {{ line.unit }}
                </td>
                <td>{{ line.unitPrice }}</td>
                <td>{{ line.discountPercent }}</td>
                <td>{{ line.taxCode }}</td>
                <td>{{ line.lineNet }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      @if (dirty()) {
        <p role="status">{{ 'invoices.creditNote.unsaved' | transloco }}</p>
      }
      <dl class="totals-list" data-testid="credit-totals">
        <div>
          <dt>{{ 'invoices.totals.net' | transloco }}</dt>
          <dd>{{ note().netTotal }}</dd>
        </div>
        <div>
          <dt>{{ 'invoices.totals.tax' | transloco }}</dt>
          <dd>{{ note().taxTotal }}</dd>
        </div>
        <div class="totals-grand">
          <dt>{{ 'invoices.creditNote.total' | transloco }}</dt>
          <dd>{{ note().total }} {{ note().currency }}</dd>
        </div>
      </dl>
      <table class="tax-summary">
        <thead>
          <tr>
            <th>{{ 'invoices.totals.taxCode' | transloco }}</th>
            <th>{{ 'invoices.totals.net' | transloco }}</th>
            <th>{{ 'invoices.totals.tax' | transloco }}</th>
            <th>{{ 'invoices.totals.gross' | transloco }}</th>
          </tr>
        </thead>
        <tbody>
          @for (group of note().taxSummary; track group.taxCode) {
            <tr>
              <td>{{ group.taxCode }}</td>
              <td>{{ group.net }}</td>
              <td>{{ group.tax }}</td>
              <td>{{ group.gross }}</td>
            </tr>
          }
        </tbody>
      </table>
      @if (editable()) {
        @if (problem(); as key) {
          <p class="field-error" role="alert">{{ key | transloco }}</p>
        }
        <div class="form-actions">
          <p-button
            type="button"
            [label]="'invoices.save' | transloco"
            [disabled]="locked() || !dirty()"
            (onClick)="save()"
          />
        </div>
        @if (saveFailure(); as item) {
          <p role="alert">{{ item.key | transloco }}</p>
          @if (item.correlationId) {
            <p>{{ 'errors.correlation' | transloco }}: {{ item.correlationId }}</p>
          }
        }
      }
    </section>
    @if (canIssue()) {
      <section class="card span-all" data-testid="credit-issue-panel">
        <h2>{{ 'invoices.creditNote.issueTitle' | transloco }}</h2>
        @if (dirty()) {
          <p>{{ 'invoices.creditNote.saveFirst' | transloco }}</p>
        }
        @if (confirming()) {
          <p role="alert">{{ 'invoices.creditNote.confirmText' | transloco }}</p>
          <div class="form-actions">
            <p-button
              type="button"
              [label]="'invoices.issue.confirm' | transloco"
              [disabled]="locked() || dirty()"
              (onClick)="confirmIssue()"
            />
            <p-button
              type="button"
              severity="secondary"
              [label]="'invoices.issue.cancel' | transloco"
              [disabled]="busy()"
              (onClick)="cancelIssue()"
            />
          </div>
        } @else {
          <p-button
            type="button"
            [label]="'invoices.creditNote.issueAction' | transloco"
            [disabled]="locked() || dirty()"
            (onClick)="startIssue()"
          />
        }
        @if (issueProblems().length > 0) {
          <div role="alert">
            <p>{{ 'invoices.creditNote.incomplete' | transloco }}</p>
            <ul>
              @for (problem of issueProblems(); track problem) {
                <li>{{ problemText(problem) }}</li>
              }
            </ul>
          </div>
        }
        @if (issueFailure(); as item) {
          <p role="alert">{{ item.key | transloco }}</p>
          @if (item.correlationId) {
            <p>{{ 'errors.correlation' | transloco }}: {{ item.correlationId }}</p>
          }
        }
      </section>
    }
  `,
})
export class CreditNoteView {
  private readonly http = inject(HttpClient);
  private readonly transloco = inject(TranslocoService);
  private readonly context = inject(CompanyContextStore);
  private readonly destroyRef = inject(DestroyRef);

  readonly companyId = input.required<string>();
  readonly note = input.required<CreditNoteDetail>();
  /** Saved or issued: the document as the API returned it, for the editor to show. */
  readonly changed = output<InvoiceView>();
  /** Someone else changed it first: the editor offers a reload. */
  readonly conflicted = output<string | null>();
  /** The editor is loading the document again: nothing changes until it lands. */
  readonly frozen = input(false);

  readonly reason = signal('');
  readonly quantities = signal<Readonly<Record<string, string>>>({});
  readonly busy = signal(false);
  /** An issue request is in flight: the draft cannot change under it. */
  readonly issuing = signal(false);
  readonly confirming = signal(false);
  readonly problem = signal<string | null>(null);
  readonly saveFailure = signal<Failure | null>(null);
  readonly issueProblems = signal<string[]>([]);
  readonly issueFailure = signal<Failure | null>(null);

  /** No edit, save or issue while a request is out or the document is reloading. */
  readonly locked = computed(() => this.busy() || this.frozen());

  /** Edited since the document was loaded. Issuing uses the saved draft, so it waits for a save. */
  readonly dirty = computed(() => {
    const note = this.note();
    if (this.reason() !== note.creditReason) {
      return true;
    }
    const typed = this.quantities();
    return note.lines.some((line) => (typed[line.id] ?? '') !== this.shortQuantity(line.quantity));
  });

  /** Bumped when the document changes, so a late answer for the previous one is ignored. */
  private generation = 0;

  constructor() {
    effect(() => {
      // Each load (a different document, or this one saved or issued) starts from what it says.
      const note = this.note();
      this.companyId();
      this.generation += 1;
      this.reason.set(note.creditReason);
      this.quantities.set(
        Object.fromEntries(note.lines.map((line) => [line.id, this.shortQuantity(line.quantity)])),
      );
      this.busy.set(false);
      this.issuing.set(false);
      this.confirming.set(false);
      this.problem.set(null);
      this.saveFailure.set(null);
      this.issueProblems.set([]);
      this.issueFailure.set(null);
    });
  }

  canCredit(): boolean {
    return canAttempt(
      this.context.grants(),
      this.context.withheldPermissions(),
      this.context.mfaStepUpRequired(),
      'invoice.credit',
    );
  }

  editable(): boolean {
    return this.note().status === 'draft' && this.canCredit() && !this.issuing();
  }

  canIssue(): boolean {
    return this.note().status === 'draft' && this.canCredit();
  }

  dateLabel(value: string | null): string {
    return calendarDate(value);
  }

  shortQuantity(value: string): string {
    const units = quantityUnits(value);
    return units === null ? value : quantityText(units);
  }

  quantityFor(lineId: string): string {
    return this.quantities()[lineId] ?? '';
  }

  setReason(event: Event): void {
    this.reason.set(fieldValue(event));
  }

  setQuantity(lineId: string, event: Event): void {
    const value = fieldValue(event);
    this.quantities.update((current) => ({ ...current, [lineId]: value }));
  }

  /** `lines.2.legalNote` reads "Line 2: …"; a credit note's own wording wins where it differs. */
  problemText(code: string): string {
    const line = /^lines\.(\d+)\.([A-Za-z]+)$/.exec(code);
    const params = line ? { position: line[1] } : {};
    const suffix = line ? `line.${line[2] ?? ''}` : code.replace(/\./g, '_');
    for (const key of [`invoices.creditNote.fields.${suffix}`, `invoices.issue.fields.${suffix}`]) {
      const translated = text(this.transloco.translate(key, params));
      if (translated.length > 0 && translated !== key) {
        return translated;
      }
    }
    return text(this.transloco.translate('invoices.issue.fields.unknown', { code }));
  }

  save(): void {
    if (!this.editable() || !this.dirty() || this.locked()) {
      return;
    }
    const note = this.note();
    const reason = this.reason();
    if (!/\S/.test(reason)) {
      this.problem.set('invoices.credit.rules.reason');
      return;
    }
    const lines: { id: string; quantity: string }[] = [];
    for (const line of note.lines) {
      const typed = this.quantityFor(line.id);
      if (typed === this.shortQuantity(line.quantity)) {
        continue;
      }
      const units = quantityUnits(typed);
      if (units === null || units <= 0n) {
        this.problem.set('invoices.credit.rules.quantity');
        return;
      }
      lines.push({ id: line.id, quantity: decimalInput(typed) });
    }
    this.problem.set(null);
    this.saveFailure.set(null);
    this.busy.set(true);
    const generation = this.generation;
    this.http
      .patch<{ creditNote: InvoiceView }>(`/api/c/${this.companyId()}/credit-notes/${note.id}`, {
        expectedVersion: note.version,
        ...(reason !== note.creditReason ? { reason } : {}),
        ...(lines.length > 0 ? { lines } : {}),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation === this.generation) {
            this.changed.emit(response.creditNote);
          }
        },
        error: (error: unknown) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          const body = error instanceof HttpErrorResponse ? readApiError(error) : null;
          if (isVersionConflict(error)) {
            this.conflicted.emit(body?.correlationId ?? null);
            return;
          }
          this.saveFailure.set({
            key: SAVE_ERRORS[body?.code ?? ''] ?? 'invoices.creditNote.errors.saveFailed',
            correlationId: body?.correlationId ?? null,
          });
        },
      });
  }

  startIssue(): void {
    if (!this.canIssue() || this.dirty() || this.locked()) {
      return;
    }
    this.issueProblems.set([]);
    this.issueFailure.set(null);
    this.confirming.set(true);
  }

  cancelIssue(): void {
    if (!this.busy()) {
      this.confirming.set(false);
    }
  }

  confirmIssue(): void {
    if (!this.canIssue() || this.dirty() || this.locked()) {
      return;
    }
    const note = this.note();
    const generation = this.generation;
    this.issueProblems.set([]);
    this.issueFailure.set(null);
    this.busy.set(true);
    this.issuing.set(true);
    this.http
      .post<{ creditNote: InvoiceView }>(
        `/api/c/${this.companyId()}/credit-notes/${note.id}/issue`,
        {
          expectedVersion: note.version,
        },
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation === this.generation) {
            this.changed.emit(response.creditNote);
          }
        },
        error: (error: unknown) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          this.issuing.set(false);
          this.confirming.set(false);
          const body = error instanceof HttpErrorResponse ? readApiError(error) : null;
          if (isVersionConflict(error)) {
            this.conflicted.emit(body?.correlationId ?? null);
            return;
          }
          if (body?.code === 'invoice_incomplete' && body.fields.length > 0) {
            this.issueProblems.set(body.fields);
            return;
          }
          this.issueFailure.set({
            key: ISSUE_ERRORS[body?.code ?? ''] ?? 'invoices.creditNote.errors.issueFailed',
            correlationId: body?.correlationId ?? null,
          });
        },
      });
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
