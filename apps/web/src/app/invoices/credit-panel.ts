import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { readApiError } from '../core/api-error';
import { CompanyContextStore } from '../core/company-context.store';
import { canAttempt } from '../core/nav';
import { navigationRunning } from '../core/navigation-state';
import { fieldValue } from '../orders/field-value';
import { quantityText, quantityUnits, remainingUnits } from './credit-quantities';
import { decimalInput } from './decimal-input';

/** A line of an issued invoice, with what issued credit notes have credited of it. */
export type CreditableLine = {
  id: string;
  position: number;
  description: string;
  quantity: string;
  unit: string;
  creditedQuantity: string;
};

export type CreditNoteLink = {
  id: string;
  number: string | null;
  status: string;
  total: string;
  issueDate: string | null;
};

type Failure = { key: string; correlationId: string | null };

/** API error codes of creating a credit note, and the message each shows. */
const CREATE_ERRORS: Readonly<Record<string, string>> = {
  over_credit: 'invoices.credit.errors.overCredit',
  nothing_to_credit: 'invoices.credit.errors.nothingLeft',
  invalid_credit_line: 'invoices.credit.errors.invalidLine',
  not_issued: 'invoices.credit.errors.notCreditable',
  not_creditable: 'invoices.credit.errors.notCreditable',
  quantity_not_positive: 'invoices.credit.errors.quantity',
  quantity_scale: 'invoices.credit.errors.quantity',
  invalid_quantity: 'invoices.credit.errors.quantity',
};

/**
 * The credit notes of an issued invoice, and a form that drafts a new one: either everything
 * not yet credited, or chosen quantities. A draft credits nothing until it is issued.
 */
@Component({
  selector: 'bp-credit-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The editor is a grid; the panel spans it like the other full-width sections.
  host: { class: 'span-all' },
  imports: [TranslocoPipe, RouterLink, Button],
  template: `
    <section class="card span-all" data-testid="credit-panel">
      <h2>{{ 'invoices.credit.title' | transloco }}</h2>
      @if (creditNotes().length > 0) {
        <ul class="credit-list">
          @for (note of creditNotes(); track note.id) {
            <li>
              <a [routerLink]="['/c', companyId(), 'invoices', note.id]">{{
                note.number ?? ('invoices.credit.unnumbered' | transloco)
              }}</a>
              · {{ 'invoices.status.' + note.status | transloco }} · {{ note.total }}
              {{ currency() }}
            </li>
          }
        </ul>
      } @else {
        <p>{{ 'invoices.credit.none' | transloco }}</p>
      }
      @if (created(); as noteId) {
        <p role="status">
          {{ 'invoices.credit.created' | transloco }}
          <a [routerLink]="['/c', companyId(), 'invoices', noteId]">{{
            'invoices.credit.openCreated' | transloco
          }}</a>
        </p>
      }
      @if (canCredit()) {
        @if (!anythingLeft()) {
          <p>{{ 'invoices.credit.allCredited' | transloco }}</p>
        } @else if (!open()) {
          <p-button
            type="button"
            severity="secondary"
            [label]="'invoices.credit.start' | transloco"
            (onClick)="start()"
          />
        } @else {
          <div class="form-grid">
            <label class="span-all">
              {{ 'invoices.credit.reason' | transloco }}
              <!-- Disabled while the draft is created: it is made from what was sent. -->
              <textarea
                [disabled]="busy()"
                [value]="reason()"
                (input)="setReason($event)"
              ></textarea>
            </label>
            <fieldset class="span-all">
              <legend>{{ 'invoices.credit.what' | transloco }}</legend>
              <label class="check">
                <input
                  type="radio"
                  name="credit-mode"
                  [disabled]="busy()"
                  [checked]="mode() === 'full'"
                  (change)="setMode('full')"
                />
                {{ 'invoices.credit.full' | transloco }}
              </label>
              <label class="check">
                <input
                  type="radio"
                  name="credit-mode"
                  [disabled]="busy()"
                  [checked]="mode() === 'lines'"
                  (change)="setMode('lines')"
                />
                {{ 'invoices.credit.someLines' | transloco }}
              </label>
            </fieldset>
          </div>
          @if (mode() === 'lines') {
            <div class="table-scroll">
              <table class="credit-lines">
                <thead>
                  <tr>
                    <th>{{ 'invoices.credit.columns.line' | transloco }}</th>
                    <th>{{ 'invoices.credit.columns.invoiced' | transloco }}</th>
                    <th>{{ 'invoices.credit.columns.credited' | transloco }}</th>
                    <th>{{ 'invoices.credit.columns.toCredit' | transloco }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (line of lines(); track line.id) {
                    <tr>
                      <td>{{ line.position }}. {{ line.description }}</td>
                      <td>{{ shortQuantity(line.quantity) }} {{ line.unit }}</td>
                      <td>{{ shortQuantity(line.creditedQuantity) }}</td>
                      <td>
                        <input
                          inputmode="decimal"
                          [attr.aria-label]="
                            'invoices.credit.quantityFor' | transloco: { position: line.position }
                          "
                          [disabled]="busy() || !hasLeft(line)"
                          [value]="quantityFor(line.id)"
                          (input)="setQuantity(line.id, $event)"
                        />
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
          <p>{{ 'invoices.credit.draftNote' | transloco }}</p>
          @if (problem(); as key) {
            <p class="field-error" role="alert">{{ key | transloco }}</p>
          }
          <div class="form-actions">
            <p-button
              type="button"
              [label]="'invoices.credit.create' | transloco"
              [disabled]="busy()"
              (onClick)="create()"
            />
            <p-button
              type="button"
              severity="secondary"
              [label]="'invoices.issue.cancel' | transloco"
              [disabled]="busy()"
              (onClick)="cancel()"
            />
          </div>
          @if (failure(); as item) {
            <p role="alert">{{ item.key | transloco }}</p>
            @if (item.correlationId) {
              <p>{{ 'errors.correlation' | transloco }}: {{ item.correlationId }}</p>
            }
          }
        }
      }
    </section>
  `,
})
export class CreditPanel {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly context = inject(CompanyContextStore);
  private readonly destroyRef = inject(DestroyRef);

  readonly companyId = input.required<string>();
  readonly invoiceId = input.required<string>();
  readonly currency = input('');
  readonly lines = input<readonly CreditableLine[]>([]);
  readonly creditNotes = input<readonly CreditNoteLink[]>([]);

  readonly open = signal(false);
  readonly reason = signal('');
  readonly mode = signal<'full' | 'lines'>('full');
  readonly quantities = signal<Readonly<Record<string, string>>>({});
  readonly problem = signal<string | null>(null);
  readonly failure = signal<Failure | null>(null);
  readonly busy = signal(false);
  /** A draft made while another navigation was running: linked here instead of opened. */
  readonly created = signal<string | null>(null);

  readonly anythingLeft = computed(() => this.lines().some((line) => this.hasLeft(line)));

  /** Bumped when the invoice changes, so a late answer for the previous one is ignored. */
  private generation = 0;

  constructor() {
    effect(() => {
      // A different invoice (or company) starts with a closed, empty form.
      this.companyId();
      this.invoiceId();
      this.generation += 1;
      this.open.set(false);
      this.reason.set('');
      this.mode.set('full');
      this.quantities.set({});
      this.problem.set(null);
      this.failure.set(null);
      this.busy.set(false);
      this.created.set(null);
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

  hasLeft(line: CreditableLine): boolean {
    return remainingUnits(line.quantity, line.creditedQuantity) > 0n;
  }

  shortQuantity(value: string): string {
    const units = quantityUnits(value);
    return units === null ? value : quantityText(units);
  }

  quantityFor(lineId: string): string {
    return this.quantities()[lineId] ?? '';
  }

  start(): void {
    this.open.set(true);
    this.problem.set(null);
    this.failure.set(null);
  }

  cancel(): void {
    if (!this.busy()) {
      this.open.set(false);
    }
  }

  setReason(event: Event): void {
    this.reason.set(fieldValue(event));
  }

  setMode(mode: 'full' | 'lines'): void {
    this.mode.set(mode);
    this.problem.set(null);
  }

  setQuantity(lineId: string, event: Event): void {
    const value = fieldValue(event);
    this.quantities.update((current) => ({ ...current, [lineId]: value }));
  }

  create(): void {
    if (this.busy() || !this.canCredit()) {
      return;
    }
    this.failure.set(null);
    const reason = this.reason();
    if (!/\S/.test(reason)) {
      this.problem.set('invoices.credit.rules.reason');
      return;
    }
    const body =
      this.mode() === 'full' ? { reason, full: true as const } : this.lineRequest(reason);
    if (!body) {
      return;
    }
    this.problem.set(null);
    this.busy.set(true);
    const generation = this.generation;
    const companyId = this.companyId();
    this.http
      .post<{ creditNote: { id: string } }>(
        `/api/c/${companyId}/invoices/${this.invoiceId()}/credit-notes`,
        body,
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          if (navigationRunning(this.router)) {
            // Another navigation (a company switch) is under way: never override it.
            this.open.set(false);
            this.created.set(response.creditNote.id);
            return;
          }
          void this.router.navigate(['/c', companyId, 'invoices', response.creditNote.id]);
        },
        error: (error: unknown) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          const failure = error instanceof HttpErrorResponse ? readApiError(error) : null;
          this.failure.set({
            key: CREATE_ERRORS[failure?.code ?? ''] ?? 'invoices.credit.errors.failed',
            correlationId: failure?.correlationId ?? null,
          });
        },
      });
  }

  /** The chosen quantities, each a positive quantity no larger than what is left. */
  private lineRequest(
    reason: string,
  ): { reason: string; lines: { invoiceLineId: string; quantity: string }[] } | null {
    const chosen: { invoiceLineId: string; quantity: string }[] = [];
    for (const line of this.lines()) {
      const typed = this.quantityFor(line.id).trim();
      if (typed.length === 0) {
        continue;
      }
      const units = quantityUnits(typed);
      if (units === null || units <= 0n) {
        this.problem.set('invoices.credit.rules.quantity');
        return null;
      }
      if (units > remainingUnits(line.quantity, line.creditedQuantity)) {
        this.problem.set('invoices.credit.rules.tooMuch');
        return null;
      }
      chosen.push({ invoiceLineId: line.id, quantity: decimalInput(typed) });
    }
    if (chosen.length === 0) {
      this.problem.set('invoices.credit.rules.noLines');
      return null;
    }
    return { reason, lines: chosen };
  }
}
