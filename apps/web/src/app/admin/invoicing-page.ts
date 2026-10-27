import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { forkJoin, of, type Observable } from 'rxjs';
import { isVersionConflict, readApiError } from '../core/api-error';
import { CompanyContextStore } from '../core/company-context.store';
import { NAVIGATE_ON_DENIED } from '../core/navigate-on-denied';
import { canAttempt } from '../core/nav';
import { fieldValue } from '../orders/field-value';

export const TAX_KINDS = [
  'standard',
  'reduced',
  'zero',
  'exempt',
  'reverse_charge',
  'out_of_scope',
] as const;
export const DEADLINE_RULES = ['days_30', 'next_month_15'] as const;
export const DOCUMENT_TYPES = ['invoice', 'credit_note', 'quote'] as const;

type TaxKind = (typeof TAX_KINDS)[number];
type DeadlineRule = (typeof DEADLINE_RULES)[number];
type DocumentType = (typeof DOCUMENT_TYPES)[number];

export type TaxCodeView = {
  id: string;
  code: string;
  name: string;
  ratePercent: string;
  kind: TaxKind;
  noteEn: string | null;
  noteEl: string | null;
  deadlineRule: DeadlineRule;
  isExample: boolean;
  active: boolean;
  inUse: boolean;
  version: number;
};

export type SeriesView = {
  id: string;
  code: string;
  documentType: DocumentType;
  prefix: string;
  nextNumber: number;
  padding: number;
  active: boolean;
  hasIssued: boolean;
  version: number;
};

export type BankAccountView = {
  id: string;
  bankName: string;
  accountHolder: string;
  iban: string;
  bic: string | null;
  shownOnInvoices: boolean;
  active: boolean;
  version: number;
};

type CompanyTerms = {
  version: number;
  invoiceTermsEn: string | null;
  invoiceTermsEl: string | null;
  defaultInvoiceSeriesId: string | null;
  defaultCreditNoteSeriesId: string | null;
  defaultQuoteSeriesId: string | null;
};

type TaxForm = {
  id: string | null;
  version: number;
  inUse: boolean;
  code: string;
  name: string;
  ratePercent: string;
  kind: TaxKind;
  noteEn: string;
  noteEl: string;
  deadlineRule: DeadlineRule;
  active: boolean;
};

type SeriesForm = {
  id: string | null;
  version: number;
  hasIssued: boolean;
  code: string;
  documentType: DocumentType;
  prefix: string;
  nextNumber: string;
  padding: string;
  active: boolean;
};

type BankForm = {
  id: string | null;
  version: number;
  bankName: string;
  accountHolder: string;
  iban: string;
  bic: string;
  shownOnInvoices: boolean;
  active: boolean;
};

type TermsForm = {
  invoiceTermsEn: string;
  invoiceTermsEl: string;
  defaultInvoiceSeriesId: string;
  defaultCreditNoteSeriesId: string;
  defaultQuoteSeriesId: string;
};

type Section = 'tax' | 'series' | 'bank' | 'terms';

/** Error codes the page explains in words. Anything else shows the server message. */
const KNOWN_ERRORS = new Set([
  'code_taken',
  'tax_code_in_use',
  'series_in_use',
  'series_is_default',
  'next_number_lowered',
  'account_inactive',
  'series_type_mismatch',
  'series_inactive',
]);

@Component({
  selector: 'bp-invoicing-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, Button],
  template: `
    <section class="screen">
      <h1>{{ 'invoicing.title' | transloco }}</h1>
      <p>{{ 'invoicing.intro' | transloco }}</p>
      @if (loading()) {
        <p role="status">{{ 'invoicing.loading' | transloco }}</p>
      }
      @if (loadError()) {
        <p role="alert">{{ 'invoicing.error' | transloco }}</p>
      }
      @if (loaded()) {
        <h2>{{ 'invoicing.tax.title' | transloco }}</h2>
        @if (errorIn('tax'); as message) {
          <p role="alert" data-testid="tax-error">{{ message }}</p>
        }
        <table class="items" data-testid="tax-table">
          <thead>
            <tr>
              <th>{{ 'invoicing.tax.code' | transloco }}</th>
              <th>{{ 'invoicing.tax.name' | transloco }}</th>
              <th>{{ 'invoicing.tax.rate' | transloco }}</th>
              <th>{{ 'invoicing.tax.kind' | transloco }}</th>
              <th>{{ 'invoicing.tax.deadline' | transloco }}</th>
              <th>{{ 'invoicing.status' | transloco }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (tax of taxCodes(); track tax.id) {
              <tr>
                <td>{{ tax.code }}</td>
                <td>
                  {{ tax.name }}
                  @if (tax.isExample) {
                    <br /><small>{{ 'invoicing.tax.example' | transloco }}</small>
                  }
                </td>
                <td>{{ tax.ratePercent }} %</td>
                <td>{{ 'invoicing.tax.kinds.' + tax.kind | transloco }}</td>
                <td>{{ 'invoicing.tax.deadlines.' + tax.deadlineRule | transloco }}</td>
                <td>
                  {{ (tax.active ? 'invoicing.active' : 'invoicing.inactive') | transloco }}
                  @if (tax.inUse) {
                    <br /><small>{{ 'invoicing.tax.inUse' | transloco }}</small>
                  }
                </td>
                <td>
                  @if (canTax()) {
                    <p-button
                      type="button"
                      [text]="true"
                      [label]="'invoicing.edit' | transloco"
                      [disabled]="busy()"
                      (onClick)="editTax(tax)"
                    />
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
        @if (canTax() && !taxForm()) {
          <p-button
            type="button"
            [label]="'invoicing.tax.add' | transloco"
            [disabled]="busy()"
            (onClick)="newTax()"
          />
        }
        @if (taxForm(); as form) {
          <form class="form-grid" data-testid="tax-form" (submit)="$event.preventDefault()">
            <!-- Locked while a save runs: its completion closes this form. -->
            <fieldset style="display: contents" [disabled]="busy()">
              <label>
                {{ 'invoicing.tax.code' | transloco }}
                <input [value]="form.code" (input)="setTax('code', $event)" />
              </label>
              <label>
                {{ 'invoicing.tax.name' | transloco }}
                <input [value]="form.name" (input)="setTax('name', $event)" />
              </label>
              <label>
                {{ 'invoicing.tax.rate' | transloco }}
                <input
                  inputmode="decimal"
                  [value]="form.ratePercent"
                  [disabled]="form.inUse"
                  (input)="setTax('ratePercent', $event)"
                />
              </label>
              <label>
                {{ 'invoicing.tax.kind' | transloco }}
                <select [disabled]="form.inUse" (change)="setTax('kind', $event)">
                  @for (kind of taxKinds; track kind) {
                    <option [value]="kind" [selected]="form.kind === kind">
                      {{ 'invoicing.tax.kinds.' + kind | transloco }}
                    </option>
                  }
                </select>
              </label>
              <label>
                {{ 'invoicing.tax.deadline' | transloco }}
                <select (change)="setTax('deadlineRule', $event)">
                  @for (rule of deadlineRules; track rule) {
                    <option [value]="rule" [selected]="form.deadlineRule === rule">
                      {{ 'invoicing.tax.deadlines.' + rule | transloco }}
                    </option>
                  }
                </select>
              </label>
              <label class="span-all">
                {{ 'invoicing.tax.noteEn' | transloco }}
                <textarea
                  rows="2"
                  [value]="form.noteEn"
                  [disabled]="form.inUse"
                  (input)="setTax('noteEn', $event)"
                ></textarea>
              </label>
              <label class="span-all">
                {{ 'invoicing.tax.noteEl' | transloco }}
                <textarea
                  rows="2"
                  [value]="form.noteEl"
                  [disabled]="form.inUse"
                  (input)="setTax('noteEl', $event)"
                ></textarea>
              </label>
              @if (form.id) {
                <label class="check">
                  <input type="checkbox" [checked]="form.active" (change)="setTaxActive($event)" />
                  {{ 'invoicing.active' | transloco }}
                </label>
              }
              @if (form.inUse) {
                <p class="span-all">{{ 'invoicing.tax.inUse' | transloco }}</p>
              }
              <div class="form-actions">
                <p-button
                  type="button"
                  [label]="'invoicing.save' | transloco"
                  [disabled]="busy()"
                  (onClick)="saveTax()"
                />
                <p-button
                  type="button"
                  [text]="true"
                  [label]="'invoicing.cancel' | transloco"
                  [disabled]="busy()"
                  (onClick)="taxForm.set(null)"
                />
              </div>
            </fieldset>
          </form>
        }

        <h2>{{ 'invoicing.series.title' | transloco }}</h2>
        @if (errorIn('series'); as message) {
          <p role="alert" data-testid="series-error">{{ message }}</p>
        }
        <table class="items" data-testid="series-table">
          <thead>
            <tr>
              <th>{{ 'invoicing.series.code' | transloco }}</th>
              <th>{{ 'invoicing.series.documentType' | transloco }}</th>
              <th>{{ 'invoicing.series.next' | transloco }}</th>
              <th>{{ 'invoicing.status' | transloco }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (item of series(); track item.id) {
              <tr>
                <td>{{ item.code }}</td>
                <td>{{ 'invoicing.series.types.' + item.documentType | transloco }}</td>
                <td>{{ preview(item.prefix, item.nextNumber, item.padding) }}</td>
                <td>
                  {{ (item.active ? 'invoicing.active' : 'invoicing.inactive') | transloco }}
                  @if (item.hasIssued) {
                    <br /><small>{{ 'invoicing.series.hasIssued' | transloco }}</small>
                  }
                </td>
                <td>
                  @if (canSeries()) {
                    <p-button
                      type="button"
                      [text]="true"
                      [label]="'invoicing.edit' | transloco"
                      [disabled]="busy()"
                      (onClick)="editSeries(item)"
                    />
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
        @if (canSeries() && !seriesForm()) {
          <p-button
            type="button"
            [label]="'invoicing.series.add' | transloco"
            [disabled]="busy()"
            (onClick)="newSeries()"
          />
        }
        @if (seriesForm(); as form) {
          <form class="form-grid" data-testid="series-form" (submit)="$event.preventDefault()">
            <!-- Locked while a save runs: its completion closes this form. -->
            <fieldset style="display: contents" [disabled]="busy()">
              <label>
                {{ 'invoicing.series.code' | transloco }}
                <input [value]="form.code" (input)="setSeries('code', $event)" />
              </label>
              <label>
                {{ 'invoicing.series.documentType' | transloco }}
                <select [disabled]="form.id !== null" (change)="setSeries('documentType', $event)">
                  @for (type of documentTypes; track type) {
                    <option [value]="type" [selected]="form.documentType === type">
                      {{ 'invoicing.series.types.' + type | transloco }}
                    </option>
                  }
                </select>
              </label>
              <label>
                {{ 'invoicing.series.prefix' | transloco }}
                <input
                  [value]="form.prefix"
                  [disabled]="form.hasIssued"
                  (input)="setSeries('prefix', $event)"
                />
              </label>
              <label>
                {{ 'invoicing.series.nextNumber' | transloco }}
                <input
                  inputmode="numeric"
                  [value]="form.nextNumber"
                  [disabled]="form.hasIssued"
                  (input)="setSeries('nextNumber', $event)"
                />
              </label>
              <label>
                {{ 'invoicing.series.padding' | transloco }}
                <input
                  inputmode="numeric"
                  [value]="form.padding"
                  [disabled]="form.hasIssued"
                  (input)="setSeries('padding', $event)"
                />
              </label>
              <p>{{ 'invoicing.series.next' | transloco }}: {{ formPreview() }}</p>
              @if (form.id) {
                <label class="check">
                  <input
                    type="checkbox"
                    [checked]="form.active"
                    (change)="setSeriesActive($event)"
                  />
                  {{ 'invoicing.active' | transloco }}
                </label>
              }
              @if (form.hasIssued) {
                <p class="span-all">{{ 'invoicing.series.hasIssued' | transloco }}</p>
              }
              <div class="form-actions">
                <p-button
                  type="button"
                  [label]="'invoicing.save' | transloco"
                  [disabled]="busy()"
                  (onClick)="saveSeries()"
                />
                <p-button
                  type="button"
                  [text]="true"
                  [label]="'invoicing.cancel' | transloco"
                  [disabled]="busy()"
                  (onClick)="seriesForm.set(null)"
                />
              </div>
            </fieldset>
          </form>
        }

        @if (canViewBank()) {
          <h2>{{ 'invoicing.bank.title' | transloco }}</h2>
          @if (errorIn('bank'); as message) {
            <p role="alert" data-testid="bank-error">{{ message }}</p>
          }
          <table class="items" data-testid="bank-table">
            <thead>
              <tr>
                <th>{{ 'invoicing.bank.bankName' | transloco }}</th>
                <th>{{ 'invoicing.bank.iban' | transloco }}</th>
                <th>{{ 'invoicing.status' | transloco }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (account of bankAccounts(); track account.id) {
                <tr>
                  <td>
                    {{ account.bankName }}<br /><small>{{ account.accountHolder }}</small>
                  </td>
                  <td>
                    {{ groupedIban(account.iban) }}
                    @if (account.bic) {
                      <br /><small>{{ account.bic }}</small>
                    }
                  </td>
                  <td>
                    {{ (account.active ? 'invoicing.active' : 'invoicing.inactive') | transloco }}
                    @if (account.shownOnInvoices) {
                      <br /><strong>{{ 'invoicing.bank.shown' | transloco }}</strong>
                    }
                  </td>
                  <td>
                    @if (canBank()) {
                      <p-button
                        type="button"
                        [text]="true"
                        [label]="'invoicing.edit' | transloco"
                        [disabled]="busy()"
                        (onClick)="editBank(account)"
                      />
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
          @if (canBank() && !bankForm()) {
            <p-button
              type="button"
              [label]="'invoicing.bank.add' | transloco"
              [disabled]="busy()"
              (onClick)="newBank()"
            />
          }
          @if (bankForm(); as form) {
            <form class="form-grid" data-testid="bank-form" (submit)="$event.preventDefault()">
              <!-- Locked while a save runs: its completion closes this form. -->
              <fieldset style="display: contents" [disabled]="busy()">
                <label>
                  {{ 'invoicing.bank.bankName' | transloco }}
                  <input [value]="form.bankName" (input)="setBank('bankName', $event)" />
                </label>
                <label>
                  {{ 'invoicing.bank.accountHolder' | transloco }}
                  <input [value]="form.accountHolder" (input)="setBank('accountHolder', $event)" />
                </label>
                <label>
                  {{ 'invoicing.bank.iban' | transloco }}
                  <input autocomplete="off" [value]="form.iban" (input)="setBank('iban', $event)" />
                </label>
                <label>
                  {{ 'invoicing.bank.bic' | transloco }}
                  <input autocomplete="off" [value]="form.bic" (input)="setBank('bic', $event)" />
                </label>
                <label class="check">
                  <input
                    type="checkbox"
                    [checked]="form.shownOnInvoices"
                    [disabled]="!form.active"
                    (change)="setBankFlag('shownOnInvoices', $event)"
                  />
                  {{ 'invoicing.bank.shown' | transloco }}
                </label>
                @if (form.id) {
                  <label class="check">
                    <input
                      type="checkbox"
                      [checked]="form.active"
                      (change)="setBankFlag('active', $event)"
                    />
                    {{ 'invoicing.active' | transloco }}
                  </label>
                }
                <div class="form-actions">
                  <p-button
                    type="button"
                    [label]="'invoicing.save' | transloco"
                    [disabled]="busy()"
                    (onClick)="saveBank()"
                  />
                  <p-button
                    type="button"
                    [text]="true"
                    [label]="'invoicing.cancel' | transloco"
                    [disabled]="busy()"
                    (onClick)="bankForm.set(null)"
                  />
                </div>
              </fieldset>
            </form>
          }
        }

        <h2>{{ 'invoicing.terms.title' | transloco }}</h2>
        @if (errorIn('terms'); as message) {
          <p role="alert" data-testid="terms-error">{{ message }}</p>
        }
        @if (termsForm(); as form) {
          <form class="form-grid" data-testid="terms-form" (submit)="$event.preventDefault()">
            @for (slot of seriesSlots; track slot.field) {
              <label>
                {{ slot.label | transloco }}
                <select [disabled]="!canTerms() || busy()" (change)="setTerms(slot.field, $event)">
                  <option value="" [selected]="form[slot.field] === ''">
                    {{ 'invoicing.terms.none' | transloco }}
                  </option>
                  @for (item of activeSeries(slot.type); track item.id) {
                    <option [value]="item.id" [selected]="form[slot.field] === item.id">
                      {{ item.code }} ({{ preview(item.prefix, item.nextNumber, item.padding) }})
                    </option>
                  }
                </select>
              </label>
            }
            <label class="span-all">
              {{ 'invoicing.terms.en' | transloco }}
              <textarea
                rows="3"
                [value]="form.invoiceTermsEn"
                [disabled]="!canTerms() || busy()"
                (input)="setTerms('invoiceTermsEn', $event)"
              ></textarea>
            </label>
            <label class="span-all">
              {{ 'invoicing.terms.el' | transloco }}
              <textarea
                rows="3"
                [value]="form.invoiceTermsEl"
                [disabled]="!canTerms() || busy()"
                (input)="setTerms('invoiceTermsEl', $event)"
              ></textarea>
            </label>
            @if (canTerms()) {
              <div class="form-actions">
                <p-button
                  type="button"
                  [label]="'invoicing.save' | transloco"
                  [disabled]="busy() || !termsDirty()"
                  (onClick)="saveTerms()"
                />
              </div>
            }
          </form>
        }
      }
    </section>
  `,
})
export class InvoicingPage {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly context = inject(CompanyContextStore);
  private readonly transloco = inject(TranslocoService);

  readonly taxKinds = TAX_KINDS;
  readonly deadlineRules = DEADLINE_RULES;
  readonly documentTypes = DOCUMENT_TYPES;
  readonly seriesSlots = [
    { field: 'defaultInvoiceSeriesId', type: 'invoice', label: 'invoicing.terms.defaultInvoice' },
    {
      field: 'defaultCreditNoteSeriesId',
      type: 'credit_note',
      label: 'invoicing.terms.defaultCreditNote',
    },
    { field: 'defaultQuoteSeriesId', type: 'quote', label: 'invoicing.terms.defaultQuote' },
  ] as const;

  readonly companyId = signal('');
  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly loadError = signal(false);
  readonly busy = signal(false);
  readonly errors = signal<Partial<Record<Section, string>>>({});
  readonly taxCodes = signal<TaxCodeView[]>([]);
  readonly series = signal<SeriesView[]>([]);
  readonly bankAccounts = signal<BankAccountView[]>([]);
  readonly taxForm = signal<TaxForm | null>(null);
  readonly seriesForm = signal<SeriesForm | null>(null);
  readonly bankForm = signal<BankForm | null>(null);
  readonly termsForm = signal<TermsForm | null>(null);
  private terms: CompanyTerms | null = null;
  private generation = 0;

  readonly canTax = computed(() => this.attempt('tax.manage'));
  readonly canSeries = computed(() => this.attempt('invoice.series.manage'));
  readonly canViewBank = computed(() => this.context.has('company.bank.view'));
  readonly canBank = computed(() => this.attempt('company.bank.manage'));
  readonly canTerms = computed(() => this.context.has('company.manage'));
  readonly formPreview = computed(() => {
    const form = this.seriesForm();
    if (!form) {
      return '';
    }
    const next = Number(form.nextNumber);
    const padding = Number(form.padding);
    if (
      !Number.isInteger(next) ||
      next < 1 ||
      !Number.isInteger(padding) ||
      padding < 1 ||
      padding > 12
    ) {
      return '';
    }
    return this.preview(form.prefix, next, padding);
  });
  readonly termsDirty = computed(() => {
    const form = this.termsForm();
    return (
      form !== null &&
      this.terms !== null &&
      JSON.stringify(form) !== JSON.stringify(termsFormOf(this.terms))
    );
  });

  constructor() {
    const companyId$ = this.route.parent?.paramMap ?? of(emptyParams());
    companyId$.pipe(takeUntilDestroyed()).subscribe((params) => {
      this.open(params.get('companyId') ?? '');
    });
  }

  open(companyId: string): void {
    this.companyId.set(companyId);
    this.generation += 1;
    // A save still in flight for the previous company is ignored, so it must not keep Save disabled.
    this.busy.set(false);
    this.loaded.set(false);
    this.taxForm.set(null);
    this.seriesForm.set(null);
    this.bankForm.set(null);
    this.termsForm.set(null);
    this.errors.set({});
    this.load(this.generation);
  }

  preview(prefix: string, nextNumber: number, padding: number): string {
    return `${prefix}${String(nextNumber).padStart(padding, '0')}`;
  }

  groupedIban(iban: string): string {
    return iban.replace(/(.{4})(?=.)/g, '$1 ');
  }

  activeSeries(type: DocumentType): SeriesView[] {
    const form = this.termsForm();
    const chosen = form ? Object.values(form) : [];
    // An inactive series stays listed while it is the saved default, so the select shows it.
    return this.series().filter(
      (item) => item.documentType === type && (item.active || chosen.includes(item.id)),
    );
  }

  errorIn(section: Section): string {
    return this.errors()[section] ?? '';
  }

  newTax(): void {
    if (this.busy()) {
      return;
    }
    this.clearError('tax');
    this.taxForm.set({
      id: null,
      version: 0,
      inUse: false,
      code: '',
      name: '',
      ratePercent: '',
      kind: 'standard',
      noteEn: '',
      noteEl: '',
      deadlineRule: 'days_30',
      active: true,
    });
  }

  editTax(tax: TaxCodeView): void {
    if (this.busy()) {
      return;
    }
    this.clearError('tax');
    this.taxForm.set({
      id: tax.id,
      version: tax.version,
      inUse: tax.inUse,
      code: tax.code,
      name: tax.name,
      ratePercent: tax.ratePercent,
      kind: tax.kind,
      noteEn: tax.noteEn ?? '',
      noteEl: tax.noteEl ?? '',
      deadlineRule: tax.deadlineRule,
      active: tax.active,
    });
  }

  setTax(
    field: 'code' | 'name' | 'ratePercent' | 'kind' | 'noteEn' | 'noteEl' | 'deadlineRule',
    event: Event,
  ): void {
    const value = fieldValue(event);
    this.taxForm.update((form) => (form ? { ...form, [field]: value } : form));
  }

  setTaxActive(event: Event): void {
    const checked = isChecked(event);
    this.taxForm.update((form) => (form ? { ...form, active: checked } : form));
  }

  saveTax(): void {
    const form = this.taxForm();
    if (!form || this.busy()) {
      return;
    }
    const original = form.id ? this.taxCodes().find((tax) => tax.id === form.id) : undefined;
    const body: Record<string, unknown> = form.id ? { expectedVersion: form.version } : {};
    putText(body, 'code', form.code, original?.code);
    putText(body, 'name', form.name, original?.name);
    if (!form.inUse) {
      putText(body, 'ratePercent', form.ratePercent, original?.ratePercent);
      putChoice(body, 'kind', form.kind, original?.kind);
      putNote(body, 'noteEn', form.noteEn, original?.noteEn ?? null, form.id !== null);
      putNote(body, 'noteEl', form.noteEl, original?.noteEl ?? null, form.id !== null);
    }
    putChoice(body, 'deadlineRule', form.deadlineRule, original?.deadlineRule);
    if (original && form.active !== original.active) {
      body['active'] = form.active;
    }
    this.write(
      'tax',
      form.id ? 'patch' : 'post',
      form.id ? `tax-codes/${form.id}` : 'tax-codes',
      body,
      () => {
        this.taxForm.set(null);
      },
    );
  }

  newSeries(): void {
    if (this.busy()) {
      return;
    }
    this.clearError('series');
    this.seriesForm.set({
      id: null,
      version: 0,
      hasIssued: false,
      code: '',
      documentType: 'invoice',
      prefix: '',
      nextNumber: '1',
      padding: '4',
      active: true,
    });
  }

  editSeries(item: SeriesView): void {
    if (this.busy()) {
      return;
    }
    this.clearError('series');
    this.seriesForm.set({
      id: item.id,
      version: item.version,
      hasIssued: item.hasIssued,
      code: item.code,
      documentType: item.documentType,
      prefix: item.prefix,
      nextNumber: String(item.nextNumber),
      padding: String(item.padding),
      active: item.active,
    });
  }

  setSeries(
    field: 'code' | 'documentType' | 'prefix' | 'nextNumber' | 'padding',
    event: Event,
  ): void {
    const value = fieldValue(event);
    this.seriesForm.update((form) => (form ? { ...form, [field]: value } : form));
  }

  setSeriesActive(event: Event): void {
    const checked = isChecked(event);
    this.seriesForm.update((form) => (form ? { ...form, active: checked } : form));
  }

  saveSeries(): void {
    const form = this.seriesForm();
    if (!form || this.busy()) {
      return;
    }
    const nextNumber = wholeNumber(form.nextNumber);
    const padding = wholeNumber(form.padding);
    if (nextNumber === null || padding === null) {
      this.setError('series', this.transloco.translate('invoicing.series.numbersInvalid'));
      return;
    }
    const original = form.id ? this.series().find((item) => item.id === form.id) : undefined;
    const body: Record<string, unknown> = form.id ? { expectedVersion: form.version } : {};
    putText(body, 'code', form.code, original?.code);
    if (!original) {
      body['documentType'] = form.documentType;
      body['prefix'] = form.prefix;
      body['nextNumber'] = nextNumber;
      body['padding'] = padding;
    } else if (!form.hasIssued) {
      if (form.prefix !== original.prefix) {
        body['prefix'] = form.prefix;
      }
      if (nextNumber !== original.nextNumber) {
        body['nextNumber'] = nextNumber;
      }
      if (padding !== original.padding) {
        body['padding'] = padding;
      }
    }
    if (original && form.active !== original.active) {
      body['active'] = form.active;
    }
    this.write(
      'series',
      form.id ? 'patch' : 'post',
      form.id ? `invoice-series/${form.id}` : 'invoice-series',
      body,
      () => {
        this.seriesForm.set(null);
      },
    );
  }

  newBank(): void {
    if (this.busy()) {
      return;
    }
    this.clearError('bank');
    this.bankForm.set({
      id: null,
      version: 0,
      bankName: '',
      accountHolder: '',
      iban: '',
      bic: '',
      shownOnInvoices: this.bankAccounts().every((account) => !account.shownOnInvoices),
      active: true,
    });
  }

  editBank(account: BankAccountView): void {
    if (this.busy()) {
      return;
    }
    this.clearError('bank');
    this.bankForm.set({
      id: account.id,
      version: account.version,
      bankName: account.bankName,
      accountHolder: account.accountHolder,
      iban: this.groupedIban(account.iban),
      bic: account.bic ?? '',
      shownOnInvoices: account.shownOnInvoices,
      active: account.active,
    });
  }

  setBank(field: 'bankName' | 'accountHolder' | 'iban' | 'bic', event: Event): void {
    const value = fieldValue(event);
    this.bankForm.update((form) => (form ? { ...form, [field]: value } : form));
  }

  setBankFlag(field: 'shownOnInvoices' | 'active', event: Event): void {
    const checked = isChecked(event);
    this.bankForm.update((form) => {
      if (!form) {
        return form;
      }
      // A deactivated account is never shown on invoices; the API clears it too.
      const next = { ...form, [field]: checked };
      return next.active ? next : { ...next, shownOnInvoices: false };
    });
  }

  saveBank(): void {
    const form = this.bankForm();
    if (!form || this.busy()) {
      return;
    }
    const original = form.id
      ? this.bankAccounts().find((account) => account.id === form.id)
      : undefined;
    const body: Record<string, unknown> = form.id ? { expectedVersion: form.version } : {};
    putText(body, 'bankName', form.bankName, original?.bankName);
    putText(body, 'accountHolder', form.accountHolder, original?.accountHolder);
    const iban = form.iban.replace(/\s+/g, '').toUpperCase();
    if (!original || iban !== original.iban) {
      body['iban'] = iban;
    }
    const bic = form.bic.trim().toUpperCase();
    if (!original ? bic.length > 0 : bic !== (original.bic ?? '')) {
      body['bic'] = bic.length > 0 ? bic : null;
    }
    if (!original || form.shownOnInvoices !== original.shownOnInvoices) {
      body['shownOnInvoices'] = form.shownOnInvoices;
    }
    if (original && form.active !== original.active) {
      body['active'] = form.active;
    }
    this.write(
      'bank',
      form.id ? 'patch' : 'post',
      form.id ? `bank-accounts/${form.id}` : 'bank-accounts',
      body,
      () => {
        this.bankForm.set(null);
      },
    );
  }

  setTerms(field: keyof TermsForm, event: Event): void {
    const value = fieldValue(event);
    this.termsForm.update((form) => (form ? { ...form, [field]: value } : form));
  }

  saveTerms(): void {
    const form = this.termsForm();
    const saved = this.terms;
    if (!form || !saved || this.busy()) {
      return;
    }
    const current = termsFormOf(saved);
    const body: Record<string, unknown> = { expectedVersion: saved.version };
    for (const key of Object.keys(form) as (keyof TermsForm)[]) {
      if (form[key] !== current[key]) {
        const trimmed = form[key].trim();
        body[key] = trimmed.length > 0 ? trimmed : null;
      }
    }
    this.write('terms', 'patch', 'company', body, () => undefined);
  }

  private attempt(permission: string): boolean {
    return canAttempt(
      this.context.grants(),
      this.context.withheldPermissions(),
      this.context.mfaStepUpRequired(),
      permission,
    );
  }

  private load(generation: number): void {
    const companyId = this.companyId();
    if (!companyId) {
      return;
    }
    const denied = { context: new HttpContext().set(NAVIGATE_ON_DENIED, true) };
    const bank$: Observable<{ bankAccounts: BankAccountView[] }> = this.canViewBank()
      ? this.http.get<{ bankAccounts: BankAccountView[] }>(`/api/c/${companyId}/bank-accounts`)
      : of({ bankAccounts: [] });
    this.loading.set(true);
    this.loadError.set(false);
    forkJoin({
      tax: this.http.get<{ taxCodes: TaxCodeView[] }>(`/api/c/${companyId}/tax-codes`, denied),
      series: this.http.get<{ series: SeriesView[] }>(`/api/c/${companyId}/invoice-series`, denied),
      bank: bank$,
      context: this.http.get<{ company: CompanyTerms }>(`/api/c/${companyId}/context`, denied),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation !== this.generation) {
            return;
          }
          this.loading.set(false);
          this.taxCodes.set(response.tax.taxCodes);
          this.series.set(response.series.series);
          this.bankAccounts.set(response.bank.bankAccounts);
          this.terms = response.context.company;
          this.termsForm.set(termsFormOf(response.context.company));
          this.loaded.set(true);
        },
        error: () => {
          if (generation !== this.generation) {
            return;
          }
          this.loading.set(false);
          this.loadError.set(true);
        },
      });
  }

  private write(
    section: Section,
    method: 'post' | 'patch',
    path: string,
    body: Record<string, unknown>,
    done: () => void,
  ): void {
    const companyId = this.companyId();
    const generation = this.generation;
    this.clearError(section);
    if (method === 'patch' && Object.keys(body).every((key) => key === 'expectedVersion')) {
      // Nothing changed: the API refuses an empty patch, so just close the form.
      done();
      return;
    }
    this.busy.set(true);
    this.http
      .request(method.toUpperCase(), `/api/c/${companyId}/${path}`, { body })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response: unknown) => {
          if (generation !== this.generation) {
            return;
          }
          done();
          if (section === 'terms' && isTermsResponse(response)) {
            // The terms inputs are disabled while busy, so applying the saved values loses no typing.
            this.terms = response.company;
            this.termsForm.set(termsFormOf(response.company));
            this.busy.set(false);
            void this.context.reload(companyId).catch(() => undefined);
            return;
          }
          // Other sections refresh a list only; their forms are closed. Editing stays locked until
          // the list (and its new versions) arrives, so the next edit never starts from a stale row.
          this.refresh(section, () => {
            this.busy.set(false);
          });
        },
        error: (error: unknown) => {
          if (generation !== this.generation) {
            return;
          }
          this.setError(section, this.describe(error));
          if (!isVersionConflict(error)) {
            this.busy.set(false);
            return;
          }
          done();
          // Stay busy until the latest values arrive, so nothing typed meanwhile is replaced.
          this.refresh(section, () => {
            this.busy.set(false);
          });
        },
      });
  }

  /** Reloads one section only, so unsaved edits in the other sections stay. */
  private refresh(section: Section, settled: () => void = () => undefined): void {
    const companyId = this.companyId();
    const generation = this.generation;
    const current = (): boolean => generation === this.generation;
    const failed = (): void => {
      if (current()) {
        this.setError(section, this.transloco.translate('invoicing.error'));
        settled();
      }
    };
    const base = `/api/c/${companyId}`;
    switch (section) {
      case 'tax':
        this.http
          .get<{ taxCodes: TaxCodeView[] }>(`${base}/tax-codes`)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: (response) => {
              if (current()) {
                this.taxCodes.set(response.taxCodes);
                settled();
              }
            },
            error: failed,
          });
        return;
      case 'series':
        this.http
          .get<{ series: SeriesView[] }>(`${base}/invoice-series`)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: (response) => {
              if (current()) {
                this.series.set(response.series);
                settled();
              }
            },
            error: failed,
          });
        return;
      case 'bank':
        this.http
          .get<{ bankAccounts: BankAccountView[] }>(`${base}/bank-accounts`)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: (response) => {
              if (current()) {
                this.bankAccounts.set(response.bankAccounts);
                settled();
              }
            },
            error: failed,
          });
        return;
      case 'terms':
        this.http
          .get<{ company: CompanyTerms }>(`${base}/context`)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: (response) => {
              if (current()) {
                this.terms = response.company;
                this.termsForm.set(termsFormOf(response.company));
                settled();
              }
            },
            error: failed,
          });
        return;
    }
  }

  private describe(error: unknown): string {
    if (!(error instanceof HttpErrorResponse)) {
      return this.transloco.translate('errors.generic');
    }
    if (isVersionConflict(error)) {
      return this.transloco.translate('invoicing.conflict');
    }
    if (error.status === 403) {
      return this.transloco.translate('invoicing.forbidden');
    }
    const api = readApiError(error);
    if (api.code && KNOWN_ERRORS.has(api.code)) {
      return this.transloco.translate(`invoicing.errors.${api.code}`);
    }
    return api.message;
  }

  private setError(section: Section, message: string): void {
    this.errors.update((current) => ({ ...current, [section]: message }));
  }

  private clearError(section: Section): void {
    this.errors.update((current) => ({ ...current, [section]: '' }));
  }
}

function isTermsResponse(value: unknown): value is { company: CompanyTerms } {
  if (typeof value !== 'object' || value === null || !('company' in value)) {
    return false;
  }
  const company = value.company;
  return (
    typeof company === 'object' &&
    company !== null &&
    'version' in company &&
    typeof company.version === 'number'
  );
}

function termsFormOf(terms: CompanyTerms): TermsForm {
  return {
    invoiceTermsEn: terms.invoiceTermsEn ?? '',
    invoiceTermsEl: terms.invoiceTermsEl ?? '',
    defaultInvoiceSeriesId: terms.defaultInvoiceSeriesId ?? '',
    defaultCreditNoteSeriesId: terms.defaultCreditNoteSeriesId ?? '',
    defaultQuoteSeriesId: terms.defaultQuoteSeriesId ?? '',
  };
}

/** Sends a trimmed text field on create, or when it changed on edit. */
function putText(
  body: Record<string, unknown>,
  key: string,
  value: string,
  original: string | undefined,
): void {
  const trimmed = value.trim();
  if (original === undefined || trimmed !== original) {
    body[key] = trimmed;
  }
}

function putChoice(
  body: Record<string, unknown>,
  key: string,
  value: string,
  original: string | undefined,
): void {
  if (original === undefined || value !== original) {
    body[key] = value;
  }
}

/** Notes are optional: empty is null, and a create leaves an empty note out. */
function putNote(
  body: Record<string, unknown>,
  key: string,
  value: string,
  original: string | null,
  editing: boolean,
): void {
  const trimmed = value.trim();
  const next = trimmed.length > 0 ? trimmed : null;
  if (editing ? next !== original : next !== null) {
    body[key] = next;
  }
}

function wholeNumber(value: string): number | null {
  const trimmed = value.trim();
  return /^\d{1,9}$/.test(trimmed) ? Number(trimmed) : null;
}

function isChecked(event: Event): boolean {
  const target = event.target;
  return target instanceof HTMLInputElement && target.checked;
}

function emptyParams(): { get: (name: string) => string | null } {
  return { get: () => null };
}
