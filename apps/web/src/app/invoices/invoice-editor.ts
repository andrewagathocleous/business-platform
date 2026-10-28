import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { Tag } from 'primeng/tag';
import { Subject, combineLatest, debounceTime, of } from 'rxjs';
import { isVersionConflict, readApiError } from '../core/api-error';
import { CompanyContextStore } from '../core/company-context.store';
import type { Locale } from '../core/models';
import { canAttempt } from '../core/nav';
import { NAVIGATE_ON_DENIED } from '../core/navigate-on-denied';
import { dropNavigationKey, navigationRunning, navigationState } from '../core/navigation-state';
import { fieldValue } from '../orders/field-value';
import { type CreditNoteDetail, CreditNoteView } from './credit-note-view';
import { type CreditNoteLink, type CreditableLine, CreditPanel } from './credit-panel';
import { type DeadlineState, companyToday, deadlineState } from './delivery-deadline';
import { calendarDate } from './invoice-query';
import { type DeliveryView, type InvoicePrintJob, IssuedActions } from './issued-actions';
import { type LineDraft, type LineKind, emptyLine, lineRequests, moveLine } from './invoice-lines';
import type { InvoiceView } from './invoice-view';

export const PREVIEW_DEBOUNCE_MS = 400;

type Totals = {
  subtotal: string;
  discountTotal: string;
  netTotal: string;
  taxTotal: string;
  total: string;
  lines: {
    position: number;
    taxCode: string;
    lineSubtotal: string;
    lineDiscount: string;
    lineNet: string;
    lineGross: string;
  }[];
  taxSummary: { taxCode: string; net: string; tax: string; gross: string }[];
};

type ProductOption = {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  unit: string;
  unitPrice: string;
  taxCodeId: string;
};

type TaxOption = { id: string; code: string; name: string };

type ClientOption = {
  id: string;
  displayName: string;
  defaultLanguage: string | null;
  defaultCurrency: string | null;
};

type PreviewState = 'invalid' | 'pending' | 'ready';

type CarriedInvoice = {
  id: string;
  version: number;
  status: string;
  currency: string;
  documentType: 'quote' | 'invoice';
  pricesIncludeTax: boolean;
  issueDate: string;
  dueDate: string;
  supplyDate: string;
  reference: string;
  notes: string;
  terms: string;
  client: ClientOption | null;
  lines: LineDraft[];
};

/** API error codes of the issue call, and the message each shows. */
const ISSUE_ERRORS: Readonly<Record<string, string>> = {
  issuance_disabled: 'invoices.issue.errors.disabled',
  currency_not_supported: 'invoices.issue.errors.currency',
  number_taken: 'invoices.issue.errors.numberTaken',
  series_unavailable: 'invoices.issue.errors.series',
  tax_code_changed: 'invoices.issue.errors.taxCodeChanged',
  not_draft: 'invoices.issue.errors.notDraft',
};

/** API error codes of converting a quote, and the message each shows. */
const CONVERT_ERRORS: Readonly<Record<string, string>> = {
  already_converted: 'invoices.convert.errors.already',
  currency_not_supported: 'invoices.convert.errors.currency',
  tax_code_inactive: 'invoices.convert.errors.taxCodeInactive',
  not_draft: 'invoices.convert.errors.notDraft',
};

@Component({
  selector: 'bp-invoice-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, RouterLink, Button, Tag, IssuedActions, CreditNoteView, CreditPanel],
  template: `
    <section class="screen">
      @if (conflict(); as item) {
        <div class="app-toast" role="alert">
          <p>{{ 'invoices.conflict' | transloco }}</p>
          @if (item.correlationId) {
            <p>{{ 'errors.correlation' | transloco }}: {{ item.correlationId }}</p>
          }
          <p-button type="button" [label]="'common.reload' | transloco" (onClick)="reload()" />
        </div>
      }
      <p>
        <a [routerLink]="['/c', companyId(), 'invoices']">{{ 'invoices.title' | transloco }}</a>
      </p>
      <h1>{{ pageTitle() | transloco }}</h1>
      @if (loading()) {
        <p role="status">{{ 'invoices.loading' | transloco }}</p>
      }
      @if (loadError()) {
        <p role="alert">{{ 'invoices.error' | transloco }}</p>
      }
      @if (!loading() && !loadError()) {
        @if (readOnly() && !creditNote()) {
          <p>{{ 'invoices.readOnly' | transloco }}</p>
        }
        @if (status() === 'issued') {
          <section class="card" data-testid="issued-summary">
            <h2>
              {{
                (creditNote() ? 'invoices.creditNote.title' : 'invoices.issued.title')
                  | transloco: { number: number() ?? '' }
              }}
            </h2>
            <p>
              {{ 'invoices.issued.deadline' | transloco: { date: dateLabel(deliveryDeadline()) } }}
              @switch (deadline()) {
                @case ('overdue') {
                  <p-tag severity="danger" [value]="'invoices.deadline.overdue' | transloco" />
                }
                @case ('soon') {
                  <p-tag severity="warn" [value]="'invoices.deadline.soon' | transloco" />
                }
              }
            </p>
            @if (lastDeliveredOn(); as delivered) {
              <p>{{ 'invoices.issued.delivered' | transloco: { date: dateLabel(delivered) } }}</p>
            }
            @for (warning of issueWarnings(); track warning) {
              <p role="status">{{ 'invoices.issue.warnings.' + warning | transloco }}</p>
            }
          </section>
        }
        @if (creditNote(); as note) {
          <div class="form-grid">
            <bp-credit-note
              [companyId]="companyId()"
              [note]="note"
              [frozen]="refreshing()"
              (changed)="applySaved($event)"
              (conflicted)="showConflict($event)"
            />
            <div class="actions span-all">
              <a class="text-action" [href]="pdfHref()" target="_blank" rel="noopener">{{
                (status() === 'issued' ? 'invoices.openIssuedPdf' : 'invoices.openPdf') | transloco
              }}</a>
              @if (status() !== 'issued') {
                <p-tag severity="warn" [value]="'invoices.draftNotice' | transloco" />
              }
            </div>
            @if (status() === 'issued' && invoiceId(); as id) {
              <bp-issued-actions
                [companyId]="companyId()"
                [invoiceId]="id"
                [deliveries]="deliveries()"
                [printJobs]="printJobs()"
                [firstPrintJobId]="firstPrintJobId()"
                (changed)="reload()"
              />
            }
          </div>
        } @else {
          <form class="form-grid" (submit)="$event.preventDefault()">
            @if (sourceQuoteId(); as quoteId) {
              <p class="span-all" data-testid="source-quote">
                {{ 'invoices.convert.fromQuote' | transloco }}
                <a [routerLink]="['/c', companyId(), 'invoices', quoteId]">{{
                  'invoices.convert.openQuote' | transloco
                }}</a>
              </p>
            }
            @if (client(); as chosen) {
              <div class="client-chip">
                <span>{{ chosen.displayName }}</span>
                @if (!readOnly()) {
                  <p-button
                    type="button"
                    size="small"
                    severity="secondary"
                    [label]="'invoices.changeClient' | transloco"
                    (onClick)="changeClient()"
                  />
                }
              </div>
            } @else {
              <label class="span-all">
                {{ 'invoices.fields.client' | transloco }}
                <input
                  [disabled]="readOnly()"
                  [value]="clientQuery()"
                  (input)="onClientQuery($event)"
                />
              </label>
              @if (clientMatches().length > 0) {
                <ul class="client-results">
                  @for (match of clientMatches(); track match.id) {
                    <li>
                      <p-button
                        type="button"
                        severity="secondary"
                        [label]="match.displayName"
                        (onClick)="chooseClient(match)"
                      />
                    </li>
                  }
                </ul>
              }
            }
            @if (errorFor('client'); as key) {
              <p class="field-error" role="alert">{{ key | transloco }}</p>
            }
            <p data-testid="document-language">{{ languageText() }}</p>
            <label>
              {{ 'invoices.fields.type' | transloco }}
              <!-- A saved draft keeps its type (the API refuses a change with 409). -->
              <select [disabled]="readOnly() || invoiceId() !== null" (change)="setType($event)">
                <option value="invoice" [selected]="documentType() === 'invoice'">
                  {{ 'invoices.type.invoice' | transloco }}
                </option>
                <option value="quote" [selected]="documentType() === 'quote'">
                  {{ 'invoices.type.quote' | transloco }}
                </option>
              </select>
            </label>
            <label class="check">
              <input
                type="checkbox"
                [disabled]="readOnly()"
                [checked]="pricesIncludeTax()"
                (change)="setTaxIncluded($event)"
              />
              {{ 'invoices.fields.pricesIncludeTax' | transloco }}
            </label>
            <label>
              {{ 'invoices.fields.issueDate' | transloco }}
              <input
                type="date"
                [disabled]="readOnly() || datesSetAtIssue()"
                [value]="issueDate()"
                (change)="setIssueDate($event)"
              />
            </label>
            <label>
              {{ 'invoices.fields.dueDate' | transloco }}
              <input
                type="date"
                [disabled]="readOnly() || datesSetAtIssue()"
                [value]="dueDate()"
                (change)="setDueDate($event)"
              />
            </label>
            @if (datesSetAtIssue()) {
              <p class="span-all">{{ 'invoices.datesAtIssue' | transloco }}</p>
            }
            <label>
              {{ 'invoices.fields.supplyDate' | transloco }}
              <input
                type="date"
                [disabled]="readOnly()"
                [value]="supplyDate()"
                (change)="setSupplyDate($event)"
              />
            </label>
            <label class="span-all">
              {{ 'invoices.fields.reference' | transloco }}
              <textarea
                [disabled]="readOnly()"
                [value]="reference()"
                (input)="setReference($event)"
              ></textarea>
            </label>
            <label class="span-all">
              {{ 'invoices.fields.notes' | transloco }}
              <textarea
                [disabled]="readOnly()"
                [value]="notes()"
                (input)="setNotes($event)"
              ></textarea>
            </label>
            <label class="span-all">
              {{ 'invoices.fields.terms' | transloco }}
              <textarea
                [disabled]="readOnly()"
                [value]="terms()"
                (input)="setTerms($event)"
              ></textarea>
            </label>

            <h2 class="span-all">{{ 'invoices.lines' | transloco }}</h2>
            @for (line of lines(); track line.key; let index = $index) {
              <article class="repeat-item span-all">
                <header class="repeat-head">
                  <h3>{{ 'invoices.lineNumber' | transloco: { position: index + 1 } }}</h3>
                  @if (!readOnly()) {
                    <div class="row-actions">
                      <p-button
                        type="button"
                        size="small"
                        severity="secondary"
                        [label]="'invoices.moveUp' | transloco"
                        [disabled]="index === 0"
                        (onClick)="move(index, -1)"
                      />
                      <p-button
                        type="button"
                        size="small"
                        severity="secondary"
                        [label]="'invoices.moveDown' | transloco"
                        [disabled]="index === lines().length - 1"
                        (onClick)="move(index, 1)"
                      />
                      <p-button
                        type="button"
                        size="small"
                        severity="danger"
                        [label]="'invoices.removeLine' | transloco"
                        (onClick)="removeLine(index)"
                      />
                    </div>
                  }
                </header>
                <div class="form-grid">
                  <label>
                    {{ 'invoices.fields.product' | transloco }}
                    <select [disabled]="readOnly()" (change)="pickProduct(index, $event)">
                      <option value="" [selected]="line.productId === ''">
                        {{ 'invoices.chooseProduct' | transloco }}
                      </option>
                      @for (product of products(); track product.id) {
                        <option [value]="product.id" [selected]="product.id === line.productId">
                          {{ product.name }}
                        </option>
                      }
                    </select>
                  </label>
                  <label class="span-all">
                    {{ 'invoices.fields.description' | transloco }}
                    <textarea
                      [disabled]="readOnly()"
                      [value]="line.description"
                      (input)="setLineText(index, 'description', $event)"
                    ></textarea>
                  </label>
                  <label>
                    {{ 'invoices.fields.quantity' | transloco }}
                    <input
                      [disabled]="readOnly()"
                      [value]="line.quantity"
                      (input)="setLineText(index, 'quantity', $event)"
                    />
                  </label>
                  <label>
                    {{ 'invoices.fields.unit' | transloco }}
                    <input
                      [disabled]="readOnly()"
                      [value]="line.unit"
                      (input)="setLineText(index, 'unit', $event)"
                    />
                  </label>
                  <label>
                    {{ 'invoices.fields.unitPrice' | transloco }}
                    <input
                      [disabled]="readOnly()"
                      [value]="line.unitPrice"
                      (input)="setLineText(index, 'unitPrice', $event)"
                    />
                  </label>
                  <label>
                    {{ 'invoices.fields.discount' | transloco }}
                    <input
                      [disabled]="readOnly()"
                      [value]="line.discountPercent"
                      (input)="setLineText(index, 'discountPercent', $event)"
                    />
                  </label>
                  <label>
                    {{ 'invoices.fields.tax' | transloco }}
                    <select
                      [disabled]="readOnly()"
                      (change)="setLineText(index, 'taxCodeId', $event)"
                    >
                      <option value="" [selected]="line.taxCodeId === ''">
                        {{ 'invoices.chooseTax' | transloco }}
                      </option>
                      @for (tax of taxCodes(); track tax.id) {
                        <option [value]="tax.id" [selected]="tax.id === line.taxCodeId">
                          {{ tax.code }}
                        </option>
                      }
                    </select>
                  </label>
                  <label>
                    {{ 'invoices.fields.kind' | transloco }}
                    <select [disabled]="readOnly()" (change)="setKind(index, $event)">
                      <option value="item" [selected]="line.kind === 'item'">
                        {{ 'invoices.kind.item' | transloco }}
                      </option>
                      <option value="shipping" [selected]="line.kind === 'shipping'">
                        {{ 'invoices.kind.shipping' | transloco }}
                      </option>
                    </select>
                  </label>
                  @if (lineTotal(index + 1); as amounts) {
                    <p class="line-amounts span-all">
                      @if (pricesIncludeTax()) {
                        {{
                          'invoices.totals.lineInclusive'
                            | transloco
                              : {
                                  subtotal: amounts.lineSubtotal,
                                  discount: amounts.lineDiscount,
                                  gross: amounts.lineGross,
                                  net: amounts.lineNet,
                                }
                        }}
                      } @else {
                        {{
                          'invoices.totals.lineExclusive'
                            | transloco
                              : {
                                  subtotal: amounts.lineSubtotal,
                                  discount: amounts.lineDiscount,
                                  net: amounts.lineNet,
                                }
                        }}
                      }
                    </p>
                  }
                </div>
              </article>
            }
            @if (!readOnly()) {
              <div class="form-actions">
                <p-button
                  type="button"
                  severity="secondary"
                  icon="pi pi-plus"
                  [label]="'invoices.addLine' | transloco"
                  [ariaLabel]="'invoices.addLine' | transloco"
                  (onClick)="addLine()"
                />
              </div>
            }
            @if (errorFor('lines'); as key) {
              <p class="field-error" role="alert">{{ key | transloco }}</p>
            }

            <section class="card invoice-totals" data-testid="invoice-totals">
              <h2>{{ 'invoices.totalsTitle' | transloco }}</h2>
              @if (previewState() === 'ready' && preview(); as totals) {
                <dl class="totals-list">
                  <div>
                    <dt>{{ 'invoices.totals.subtotal' | transloco }}</dt>
                    <dd data-testid="subtotal">{{ totals.subtotal }}</dd>
                  </div>
                  <div>
                    <dt>{{ 'invoices.totals.discount' | transloco }}</dt>
                    <dd data-testid="discount">{{ totals.discountTotal }}</dd>
                  </div>
                  <div>
                    <dt>{{ 'invoices.totals.net' | transloco }}</dt>
                    <dd data-testid="net">{{ totals.netTotal }}</dd>
                  </div>
                  <div>
                    <dt>{{ 'invoices.totals.tax' | transloco }}</dt>
                    <dd data-testid="tax">{{ totals.taxTotal }}</dd>
                  </div>
                  <div class="totals-grand">
                    <dt>{{ 'invoices.totals.total' | transloco }}</dt>
                    <dd>
                      <span data-testid="total">{{ totals.total }}</span> {{ moneyCurrency() }}
                    </dd>
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
                    @for (group of totals.taxSummary; track group.taxCode) {
                      <tr>
                        <td>{{ group.taxCode }}</td>
                        <td>{{ group.net }}</td>
                        <td>{{ group.tax }}</td>
                        <td>{{ group.gross }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <p data-testid="totals-pending">{{ 'invoices.totalsPending' | transloco }}</p>
              }
            </section>

            @if (!readOnly()) {
              <div class="form-actions">
                <p-button
                  type="button"
                  [label]="'invoices.save' | transloco"
                  [disabled]="busy()"
                  (onClick)="save()"
                />
              </div>
            }
            @if (invoiceId()) {
              <div class="actions">
                <a class="text-action" [href]="pdfHref()" target="_blank" rel="noopener">{{
                  (status() === 'issued' ? 'invoices.openIssuedPdf' : 'invoices.openPdf')
                    | transloco
                }}</a>
                @if (status() !== 'issued') {
                  <p-tag severity="warn" [value]="'invoices.draftNotice' | transloco" />
                }
              </div>
            }
            @if (status() === 'issued' && invoiceId(); as id) {
              <bp-issued-actions
                [companyId]="companyId()"
                [invoiceId]="id"
                [deliveries]="deliveries()"
                [printJobs]="printJobs()"
                [firstPrintJobId]="firstPrintJobId()"
                (changed)="reload()"
              />
              @if (documentType() === 'invoice') {
                <bp-credit-panel
                  [companyId]="companyId()"
                  [invoiceId]="id"
                  [currency]="savedCurrency()"
                  [lines]="creditableLines()"
                  [creditNotes]="creditNotes()"
                />
              }
            }
            @if (documentType() === 'quote' && status() === 'draft' && invoiceId()) {
              <section class="card span-all" data-testid="convert-panel">
                <h2>{{ 'invoices.convert.title' | transloco }}</h2>
                @if (convertedInvoiceId(); as converted) {
                  <p>
                    {{ 'invoices.convert.done' | transloco }}
                    <a [routerLink]="['/c', companyId(), 'invoices', converted]">{{
                      'invoices.convert.open' | transloco
                    }}</a>
                  </p>
                } @else if (canDraft()) {
                  <p>{{ 'invoices.convert.explain' | transloco }}</p>
                  @if (dirty()) {
                    <p>{{ 'invoices.convert.saveFirst' | transloco }}</p>
                  }
                  <p-button
                    type="button"
                    [label]="'invoices.convert.action' | transloco"
                    [disabled]="busy() || dirty() || converting()"
                    (onClick)="convert()"
                  />
                }
                @if (convertError(); as failure) {
                  <p role="alert">{{ failure.key | transloco }}</p>
                  @if (failure.correlationId) {
                    <p>{{ 'errors.correlation' | transloco }}: {{ failure.correlationId }}</p>
                  }
                }
              </section>
            }
            @if (canIssue()) {
              <section class="card span-all" data-testid="issue-panel">
                <h2>{{ 'invoices.issue.title' | transloco }}</h2>
                @if (dirty()) {
                  <p>{{ 'invoices.issue.saveFirst' | transloco }}</p>
                }
                @if (confirmingIssue()) {
                  <p role="alert">{{ 'invoices.issue.confirmText' | transloco }}</p>
                  <div class="form-actions">
                    <p-button
                      type="button"
                      [label]="'invoices.issue.confirm' | transloco"
                      [disabled]="busy() || dirty()"
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
                    [label]="'invoices.issue.action' | transloco"
                    [disabled]="busy() || dirty()"
                    (onClick)="startIssue()"
                  />
                }
                @if (issueProblems().length > 0) {
                  <div role="alert">
                    <p>{{ 'invoices.issue.incomplete' | transloco }}</p>
                    <ul>
                      @for (problem of issueProblems(); track problem) {
                        <li>{{ problemText(problem) }}</li>
                      }
                    </ul>
                  </div>
                }
                @if (issueError(); as failure) {
                  <p role="alert">{{ failure.key | transloco }}</p>
                  @if (failure.correlationId) {
                    <p>{{ 'errors.correlation' | transloco }}: {{ failure.correlationId }}</p>
                  }
                }
              </section>
            }
          </form>
        }
      }
    </section>
  `,
})
export class InvoiceEditorPage {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly transloco = inject(TranslocoService);
  private readonly context = inject(CompanyContextStore);
  private readonly clientSearch = new Subject<string>();
  private previewGen = 0;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private clientSeq = 0;
  private generation = 0;
  private clientLoad = 0;
  private draftRevision = 0;
  private storedPreview: Totals | null = null;
  private keySeq = 0;
  private version: number | null = null;

  readonly field = fieldValue;
  readonly companyId = signal('');
  readonly invoiceId = signal<string | null>(null);
  readonly status = signal<string | null>(null);
  readonly documentType = signal<'quote' | 'invoice'>('invoice');
  readonly pricesIncludeTax = signal(false);
  readonly issueDate = signal('');
  readonly dueDate = signal('');
  readonly supplyDate = signal('');
  readonly number = signal<string | null>(null);
  readonly deliveryDeadline = signal<string | null>(null);
  readonly lastDeliveredOn = signal<string | null>(null);
  readonly deliveries = signal<DeliveryView[]>([]);
  readonly printJobs = signal<InvoicePrintJob[]>([]);
  readonly firstPrintJobId = signal<string | null>(null);
  /** An issue request is in flight: the draft cannot change under it. */
  readonly issuing = signal(false);
  /** A quote is being converted: it cannot change under the request. */
  readonly converting = signal(false);
  /** A saved document is being loaded again; a credit note's view waits for it. */
  readonly refreshing = signal(false);
  /** Edited since the last save or load. Issuing uses the saved draft, so it waits for a save. */
  readonly dirty = signal(false);
  readonly confirmingIssue = signal(false);
  readonly issueProblems = signal<string[]>([]);
  readonly issueError = signal<{ key: string; correlationId: string | null } | null>(null);
  readonly issueWarnings = signal<string[]>([]);
  /** Set when the document is a credit note: it has its own view instead of the form. */
  readonly creditNote = signal<CreditNoteDetail | null>(null);
  /** An issued invoice: its lines with what is credited, and its credit notes. */
  readonly creditableLines = signal<CreditableLine[]>([]);
  readonly creditNotes = signal<CreditNoteLink[]>([]);
  readonly sourceQuoteId = signal<string | null>(null);
  readonly convertedInvoiceId = signal<string | null>(null);
  readonly convertError = signal<{ key: string; correlationId: string | null } | null>(null);
  readonly reference = signal('');
  readonly notes = signal('');
  readonly terms = signal('');
  readonly lines = signal<LineDraft[]>([]);
  readonly client = signal<ClientOption | null>(null);
  readonly clientQuery = signal('');
  readonly clientMatches = signal<ClientOption[]>([]);
  readonly products = signal<ProductOption[]>([]);
  readonly taxCodes = signal<TaxOption[]>([]);
  readonly preview = signal<Totals | null>(null);
  readonly previewState = signal<PreviewState>('invalid');
  readonly savedCurrency = signal('');
  readonly conflict = signal<{ correlationId: string | null } | null>(null);
  readonly errors = signal<Record<string, string>>({});
  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly busy = signal(false);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.previewTimer !== null) {
        clearTimeout(this.previewTimer);
      }
    });
    this.clientSearch.pipe(debounceTime(300), takeUntilDestroyed()).subscribe((q) => {
      this.searchClients(q);
    });
    const companyId$ = this.route.parent?.paramMap ?? of(emptyParams());
    combineLatest([companyId$, this.route.paramMap])
      .pipe(takeUntilDestroyed())
      .subscribe(([company, params]) => {
        this.open(company.get('companyId') ?? '', params.get('invoiceId'));
      });
  }

  open(companyId: string, invoiceId: string | null): void {
    const changed = companyId !== this.companyId() || invoiceId !== this.invoiceId();
    this.companyId.set(companyId);
    this.invoiceId.set(invoiceId);
    if (companyId.length === 0) {
      this.loading.set(false);
      return;
    }
    if (changed) {
      this.generation += 1;
      this.resetDraft();
    }
    this.loadCatalog(companyId);
    if (!invoiceId) {
      if (this.lines().length === 0) {
        this.lines.set([emptyLine(this.nextKey())]);
      }
      this.loading.set(false);
      this.schedulePreview();
      return;
    }
    const carried = this.consumeCarriedInvoice(invoiceId);
    if (carried) {
      this.restoreCarriedInvoice(carried);
      return;
    }
    this.fetch();
  }

  readOnly(): boolean {
    // A credit note changes only through its own view (reason and quantities).
    if (!this.canDraft() || this.issuing() || this.converting() || this.creditNote() !== null) {
      return true;
    }
    const status = this.status();
    return status !== null && status !== 'draft';
  }

  canDraft(): boolean {
    return canAttempt(
      this.context.grants(),
      this.context.withheldPermissions(),
      this.context.mfaStepUpRequired(),
      'invoice.draft',
    );
  }

  canIssue(): boolean {
    return (
      this.invoiceId() !== null &&
      this.status() === 'draft' &&
      this.documentType() === 'invoice' &&
      this.creditNote() === null &&
      canAttempt(
        this.context.grants(),
        this.context.withheldPermissions(),
        this.context.mfaStepUpRequired(),
        'invoice.issue',
      )
    );
  }

  pageTitle(): string {
    if (this.creditNote()) {
      return 'invoices.creditNote.pageTitle';
    }
    return this.invoiceId() ? 'invoices.editTitle' : 'invoices.newTitle';
  }

  /** A credit note saved or issued in its view: show what the API returned. */
  applySaved(saved: InvoiceView): void {
    if (saved.id === this.invoiceId()) {
      this.apply(saved);
    }
  }

  showConflict(correlationId: string | null): void {
    this.conflict.set({ correlationId });
  }

  /** Makes a new draft invoice from this saved quote, then opens it. A quote converts once. */
  convert(): void {
    const quoteId = this.invoiceId();
    if (
      !quoteId ||
      this.documentType() !== 'quote' ||
      this.status() !== 'draft' ||
      this.dirty() ||
      this.converting() ||
      !this.canDraft() ||
      !this.begin()
    ) {
      return;
    }
    const generation = this.generation;
    const companyId = this.companyId();
    this.convertError.set(null);
    this.converting.set(true);
    this.http
      .post<{ invoice: { id: string } }>(`/api/c/${companyId}/quotes/${quoteId}/convert`, {})
      // A left editor never navigates on a late answer.
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          if (navigationRunning(this.router)) {
            // Another navigation (a company switch) is under way: the quote is loaded again
            // instead, and links to its new invoice if the user stays.
            this.fetch();
            return;
          }
          void this.router.navigate(['/c', companyId, 'invoices', response.invoice.id]);
        },
        error: (error: unknown) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          const body = error instanceof HttpErrorResponse ? readApiError(error) : null;
          this.convertError.set({
            key: CONVERT_ERRORS[body?.code ?? ''] ?? 'invoices.convert.errors.failed',
            correlationId: body?.correlationId ?? null,
          });
          if (body?.code === 'already_converted') {
            // The quote now shows the invoice it was converted to. It stays frozen until then.
            this.fetch();
            return;
          }
          this.converting.set(false);
        },
      });
  }

  /** An invoice draft's issue and due dates are set when it is issued, so they are not edited. */
  datesSetAtIssue(): boolean {
    return (
      this.documentType() === 'invoice' && (this.status() === null || this.status() === 'draft')
    );
  }

  deadline(): DeadlineState {
    if (this.status() !== 'issued') {
      return 'none';
    }
    return deadlineState(
      this.deliveryDeadline(),
      this.lastDeliveredOn() !== null,
      companyToday(this.context.timezone()),
    );
  }

  dateLabel(value: string | null): string {
    return calendarDate(value);
  }

  /** `lines.2.legalNote` reads "Line 2: …"; other codes have a message each. */
  problemText(code: string): string {
    const line = /^lines\.(\d+)\.([A-Za-z]+)$/.exec(code);
    const key = line
      ? `invoices.issue.fields.line.${line[2] ?? ''}`
      : `invoices.issue.fields.${code.replace(/\./g, '_')}`;
    const translated = text(this.transloco.translate(key, line ? { position: line[1] } : {}));
    if (translated.length > 0 && translated !== key) {
      return translated;
    }
    return text(this.transloco.translate('invoices.issue.fields.unknown', { code }));
  }

  startIssue(): void {
    if (!this.canIssue() || this.dirty() || this.busy()) {
      return;
    }
    this.issueProblems.set([]);
    this.issueError.set(null);
    this.confirmingIssue.set(true);
  }

  cancelIssue(): void {
    if (!this.busy()) {
      this.confirmingIssue.set(false);
    }
  }

  confirmIssue(): void {
    const invoiceId = this.invoiceId();
    if (!invoiceId || !this.canIssue() || this.dirty() || !this.begin()) {
      return;
    }
    const generation = this.generation;
    this.issueProblems.set([]);
    this.issueError.set(null);
    this.issuing.set(true);
    this.http
      .post<{ invoice: InvoiceView; warnings: string[] }>(
        `/api/c/${this.companyId()}/invoices/${invoiceId}/issue`,
        { expectedVersion: this.version ?? 0 },
      )
      .subscribe({
        next: (response) => {
          if (generation !== this.generation) {
            return;
          }
          this.issuing.set(false);
          this.busy.set(false);
          this.confirmingIssue.set(false);
          this.apply(response.invoice);
          this.issueWarnings.set(response.warnings);
        },
        error: (error: unknown) => {
          if (generation !== this.generation) {
            return;
          }
          this.issuing.set(false);
          this.confirmingIssue.set(false);
          if (isVersionConflict(error)) {
            this.fail(generation, error);
            return;
          }
          this.busy.set(false);
          const body = error instanceof HttpErrorResponse ? readApiError(error) : null;
          if (body?.code === 'invoice_incomplete' && body.fields.length > 0) {
            this.issueProblems.set(body.fields);
            return;
          }
          this.issueError.set({
            key: ISSUE_ERRORS[body?.code ?? ''] ?? 'invoices.issue.errors.failed',
            correlationId: body?.correlationId ?? null,
          });
        },
      });
  }

  errorFor(field: string): string | null {
    return this.errors()[field] ?? null;
  }

  languageText(): string {
    const chosen = this.client();
    const clientLanguage = chosen?.defaultLanguage;
    const fromClient = clientLanguage === 'en' || clientLanguage === 'el';
    const language: Locale = fromClient ? clientLanguage : this.context.documentLanguage();
    const languageName = text(
      this.transloco.translate(
        language === 'el' ? 'invoices.languageName.el' : 'invoices.languageName.en',
      ),
    );
    const source = text(
      this.transloco.translate(fromClient ? 'invoices.source.client' : 'invoices.source.company'),
    );
    return text(
      this.transloco.translate('invoices.documentLanguage', { language: languageName, source }),
    );
  }

  moneyCurrency(): string {
    if (this.readOnly()) {
      return this.savedCurrency() || this.context.currency();
    }
    const client = this.client();
    if (client) {
      return client.defaultCurrency || this.context.currency();
    }
    return this.savedCurrency() || this.context.currency();
  }

  lineTotal(position: number): Totals['lines'][number] | null {
    if (this.previewState() !== 'ready') {
      return null;
    }
    return this.preview()?.lines.find((line) => line.position === position) ?? null;
  }

  pdfHref(): string {
    return `/api/c/${this.companyId()}/invoices/${this.invoiceId() ?? ''}/pdf`;
  }

  setType(event: Event): void {
    this.touch();
    const value = fieldValue(event);
    this.documentType.set(value === 'quote' ? 'quote' : 'invoice');
  }

  setTaxIncluded(event: Event): void {
    this.touch();
    const target = event.target;
    this.pricesIncludeTax.set(target instanceof HTMLInputElement && target.checked);
    this.schedulePreview();
  }

  setIssueDate(event: Event): void {
    this.touch();
    this.issueDate.set(fieldValue(event));
  }

  setDueDate(event: Event): void {
    this.touch();
    this.dueDate.set(fieldValue(event));
  }

  setSupplyDate(event: Event): void {
    this.touch();
    this.supplyDate.set(fieldValue(event));
  }

  setReference(event: Event): void {
    this.touch();
    this.reference.set(fieldValue(event));
  }

  setNotes(event: Event): void {
    this.touch();
    this.notes.set(fieldValue(event));
  }

  setTerms(event: Event): void {
    this.touch();
    this.terms.set(fieldValue(event));
  }

  onClientQuery(event: Event): void {
    this.touch();
    const value = fieldValue(event);
    this.clientQuery.set(value);
    this.clientSearch.next(value);
  }

  changeClient(): void {
    if (this.readOnly()) {
      return;
    }
    this.touch();
    this.clientLoad += 1;
    this.client.set(null);
    this.clientQuery.set('');
    this.clientMatches.set([]);
  }

  chooseClient(client: ClientOption): void {
    this.touch();
    this.clientLoad += 1;
    this.client.set(client);
    this.clientQuery.set('');
    this.clientMatches.set([]);
  }

  pickProduct(index: number, event: Event): void {
    this.touch();
    const productId = fieldValue(event);
    const product = this.products().find((item) => item.id === productId);
    this.lines.update((lines) =>
      lines.map((line, item) => {
        if (item !== index) {
          return line;
        }
        if (!product) {
          return { ...line, productId: '' };
        }
        return {
          ...line,
          productId: product.id,
          description: product.description ?? product.name,
          unit: product.unit,
          unitPrice: product.unitPrice,
          taxCodeId: product.taxCodeId,
          kind: product.kind === 'shipping' ? 'shipping' : 'item',
        };
      }),
    );
    this.schedulePreview();
  }

  setLineText(
    index: number,
    field: 'description' | 'quantity' | 'unit' | 'unitPrice' | 'discountPercent' | 'taxCodeId',
    event: Event,
  ): void {
    this.touch();
    const value = fieldValue(event);
    this.lines.update((lines) =>
      lines.map((line, item) => (item === index ? { ...line, [field]: value } : line)),
    );
    this.schedulePreview();
  }

  setKind(index: number, event: Event): void {
    this.touch();
    const kind: LineKind = fieldValue(event) === 'shipping' ? 'shipping' : 'item';
    this.lines.update((lines) =>
      lines.map((line, item) => (item === index ? { ...line, kind } : line)),
    );
    this.schedulePreview();
  }

  addLine(): void {
    this.touch();
    this.lines.update((lines) => [...lines, emptyLine(this.nextKey())]);
    this.schedulePreview();
  }

  removeLine(index: number): void {
    this.touch();
    this.lines.update((lines) => lines.filter((_, item) => item !== index));
    this.schedulePreview();
  }

  move(index: number, direction: -1 | 1): void {
    this.touch();
    this.lines.update((lines) => moveLine(lines, index, direction));
    this.schedulePreview();
  }

  save(): void {
    if (this.readOnly() || !this.begin()) {
      return;
    }
    const requests = lineRequests(this.lines());
    const errors: Record<string, string> = {};
    if (!this.client()) {
      errors['client'] = 'invoices.rules.client';
    }
    if (!requests) {
      errors['lines'] = 'invoices.rules.lines';
    }
    this.errors.set(errors);
    if (!requests || !this.client()) {
      this.busy.set(false);
      return;
    }
    const body = {
      documentType: this.documentType(),
      clientId: this.client()?.id ?? '',
      pricesIncludeTax: this.pricesIncludeTax(),
      issueDate: this.issueDate().length > 0 ? this.issueDate() : null,
      dueDate: this.dueDate().length > 0 ? this.dueDate() : null,
      supplyDate: this.supplyDate().length > 0 ? this.supplyDate() : null,
      reference: this.reference().length > 0 ? this.reference() : null,
      notes: this.notes().length > 0 ? this.notes() : null,
      terms: this.terms().length > 0 ? this.terms() : null,
      lines: requests,
    };
    const generation = this.generation;
    const revision = this.draftRevision;
    const invoiceId = this.invoiceId();
    const request = invoiceId
      ? this.http.patch<{ invoice: InvoiceView }>(
          `/api/c/${this.companyId()}/invoices/${invoiceId}`,
          {
            expectedVersion: this.version ?? 0,
            ...body,
          },
        )
      : this.http.post<{ invoice: InvoiceView }>(`/api/c/${this.companyId()}/invoices`, body);
    request.subscribe({
      next: (response) => {
        if (generation !== this.generation) {
          return;
        }
        this.busy.set(false);
        if (!invoiceId) {
          this.openCreated(response.invoice, revision);
          return;
        }
        if (revision === this.draftRevision) {
          this.apply(response.invoice);
          return;
        }
        this.version = response.invoice.version;
        this.status.set(response.invoice.status);
        this.savedCurrency.set(response.invoice.currency);
      },
      error: (error: unknown) => {
        this.fail(generation, error);
      },
    });
  }

  reload(): void {
    this.conflict.set(null);
    if (this.invoiceId()) {
      this.fetch();
    }
  }

  private openCreated(invoice: InvoiceView, revision: number): void {
    const commands = ['/c', this.companyId(), 'invoices', invoice.id];
    if (revision === this.draftRevision) {
      void this.router.navigate(commands);
      return;
    }
    const client = this.client();
    void this.router.navigate(commands, {
      state: {
        carriedInvoice: {
          id: invoice.id,
          version: invoice.version,
          status: invoice.status,
          currency: invoice.currency,
          documentType: this.documentType(),
          pricesIncludeTax: this.pricesIncludeTax(),
          issueDate: this.issueDate(),
          dueDate: this.dueDate(),
          supplyDate: this.supplyDate(),
          reference: this.reference(),
          notes: this.notes(),
          terms: this.terms(),
          client: client ? { ...client } : null,
          lines: this.lines().map((line) => ({ ...line })),
        },
      },
    });
  }

  private consumeCarriedInvoice(invoiceId: string): CarriedInvoice | null {
    const state = navigationState(this.router);
    const carried = carriedInvoiceFrom(state?.['carriedInvoice']);
    if (!carried || carried.id !== invoiceId) {
      return null;
    }
    dropNavigationKey(state, 'carriedInvoice');
    return carried;
  }

  private restoreCarriedInvoice(carried: CarriedInvoice): void {
    this.status.set(carried.status);
    this.documentType.set(carried.documentType);
    this.pricesIncludeTax.set(carried.pricesIncludeTax);
    this.issueDate.set(carried.issueDate);
    this.dueDate.set(carried.dueDate);
    this.supplyDate.set(carried.supplyDate);
    this.reference.set(carried.reference);
    this.notes.set(carried.notes);
    this.terms.set(carried.terms);
    this.savedCurrency.set(carried.currency);
    this.version = carried.version;
    this.client.set(carried.client);
    this.clientQuery.set(carried.client?.displayName ?? '');
    this.lines.set(carried.lines.map((line) => ({ ...line })));
    // The carried draft has edits made while it was being created; they are not saved yet.
    this.dirty.set(true);
    this.loading.set(false);
    this.loadError.set(false);
    this.schedulePreview();
  }

  private resetDraft(): void {
    this.status.set(null);
    this.documentType.set('invoice');
    this.pricesIncludeTax.set(false);
    this.issueDate.set('');
    this.dueDate.set('');
    this.supplyDate.set('');
    this.number.set(null);
    this.deliveryDeadline.set(null);
    this.lastDeliveredOn.set(null);
    this.deliveries.set([]);
    this.printJobs.set([]);
    this.firstPrintJobId.set(null);
    this.issuing.set(false);
    this.converting.set(false);
    this.refreshing.set(false);
    this.dirty.set(false);
    this.confirmingIssue.set(false);
    this.issueProblems.set([]);
    this.issueError.set(null);
    this.issueWarnings.set([]);
    this.creditNote.set(null);
    this.creditableLines.set([]);
    this.creditNotes.set([]);
    this.sourceQuoteId.set(null);
    this.convertedInvoiceId.set(null);
    this.convertError.set(null);
    this.reference.set('');
    this.notes.set('');
    this.terms.set('');
    this.lines.set([]);
    this.client.set(null);
    this.clientQuery.set('');
    this.clientMatches.set([]);
    this.preview.set(null);
    this.previewState.set('invalid');
    this.savedCurrency.set('');
    this.storedPreview = null;
    this.draftRevision = 0;
    this.clientLoad += 1;
    this.conflict.set(null);
    this.errors.set({});
    this.loadError.set(false);
    this.busy.set(false);
    this.version = null;
    this.previewGen += 1;
  }

  private schedulePreview(): void {
    this.previewGen += 1;
    if (this.previewTimer !== null) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    if (this.readOnly()) {
      this.preview.set(this.storedPreview);
      this.previewState.set(this.storedPreview ? 'ready' : 'invalid');
      return;
    }
    this.preview.set(null);
    if (!lineRequests(this.lines())) {
      this.previewState.set('invalid');
      return;
    }
    this.previewState.set('pending');
    const gen = this.previewGen;
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      this.sendPreview(gen);
    }, PREVIEW_DEBOUNCE_MS);
  }

  private sendPreview(gen: number): void {
    if (gen !== this.previewGen) {
      return;
    }
    const requests = lineRequests(this.lines());
    if (!requests) {
      this.preview.set(null);
      this.previewState.set('invalid');
      return;
    }
    this.http
      .post<{ totals: Totals }>(`/api/c/${this.companyId()}/invoices/preview-totals`, {
        pricesIncludeTax: this.pricesIncludeTax(),
        lines: requests,
      })
      .subscribe({
        next: (body) => {
          if (gen !== this.previewGen) {
            return;
          }
          this.preview.set(body.totals);
          this.previewState.set('ready');
        },
        error: () => {
          if (gen !== this.previewGen) {
            return;
          }
          this.preview.set(null);
          this.previewState.set('invalid');
        },
      });
  }

  private searchClients(q: string): void {
    if (q.trim().length === 0) {
      this.clientMatches.set([]);
      return;
    }
    const seq = ++this.clientSeq;
    this.http
      .get<{ clients: ClientOption[] }>(`/api/c/${this.companyId()}/clients`, { params: { q } })
      .subscribe({
        next: (body) => {
          if (seq === this.clientSeq) {
            this.clientMatches.set(body.clients);
          }
        },
        error: () => {
          if (seq === this.clientSeq) {
            this.clientMatches.set([]);
          }
        },
      });
  }

  private fetch(): void {
    const invoiceId = this.invoiceId();
    if (!invoiceId) {
      return;
    }
    const generation = ++this.generation;
    this.loading.set(this.version === null);
    this.refreshing.set(true);
    this.http
      .get<{ invoice: InvoiceView }>(`/api/c/${this.companyId()}/invoices/${invoiceId}`, {
        context: new HttpContext().set(NAVIGATE_ON_DENIED, true),
      })
      .subscribe({
        next: (body) => {
          if (generation !== this.generation) {
            return;
          }
          this.apply(body.invoice);
          this.loading.set(false);
          this.refreshing.set(false);
          this.loadClient(body.invoice.clientId);
        },
        error: () => {
          if (generation !== this.generation) {
            return;
          }
          this.loading.set(false);
          this.refreshing.set(false);
          this.converting.set(false);
          if (this.version === null) {
            this.loadError.set(true);
          }
        },
      });
  }

  private apply(invoice: InvoiceView): void {
    this.status.set(invoice.status);
    this.documentType.set(invoice.documentType === 'quote' ? 'quote' : 'invoice');
    this.pricesIncludeTax.set(invoice.pricesIncludeTax);
    this.issueDate.set(invoice.issueDate ?? '');
    this.dueDate.set(invoice.dueDate ?? '');
    this.supplyDate.set(invoice.supplyDate ?? '');
    this.number.set(invoice.number ?? null);
    this.deliveryDeadline.set(invoice.deliveryDeadline ?? null);
    this.lastDeliveredOn.set(invoice.lastDeliveredOn ?? null);
    this.deliveries.set(invoice.deliveries ?? []);
    this.printJobs.set(invoice.printJobs ?? []);
    this.firstPrintJobId.set(invoice.firstPrintJobId ?? null);
    this.creditNote.set(creditNoteOf(invoice));
    this.creditableLines.set(
      invoice.documentType === 'invoice' && invoice.status === 'issued'
        ? creditableLinesOf(invoice)
        : [],
    );
    this.creditNotes.set(invoice.creditNotes ?? []);
    this.sourceQuoteId.set(invoice.sourceQuoteId ?? null);
    this.convertedInvoiceId.set(invoice.convertedInvoiceId ?? null);
    this.converting.set(false);
    this.dirty.set(false);
    this.reference.set(invoice.reference ?? '');
    this.notes.set(invoice.notes ?? '');
    this.terms.set(invoice.terms ?? '');
    this.savedCurrency.set(invoice.currency);
    this.storedPreview = storedTotals(invoice);
    this.version = invoice.version;
    const current = this.client();
    const kept = current !== null && current.id === invoice.clientId ? current : null;
    this.client.set({
      id: invoice.clientId,
      displayName: invoice.clientDisplayName,
      defaultLanguage: kept?.defaultLanguage ?? null,
      defaultCurrency: kept?.defaultCurrency ?? null,
    });
    this.clientQuery.set(invoice.clientDisplayName);
    this.lines.set(
      [...invoice.lines]
        .sort((left, right) => left.position - right.position)
        .map((line) => ({
          key: this.nextKey(),
          productId: line.productId ?? '',
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
          discountPercent: line.discountPercent,
          taxCodeId: line.taxCodeId,
          kind: line.kind,
        })),
    );
    this.conflict.set(null);
    this.errors.set({});
    this.schedulePreview();
  }

  private loadClient(clientId: string): void {
    const generation = this.generation;
    const load = ++this.clientLoad;
    this.http
      .get<{ client: ClientOption }>(`/api/c/${this.companyId()}/clients/${clientId}`)
      .subscribe({
        next: (body) => {
          if (
            generation !== this.generation ||
            load !== this.clientLoad ||
            this.client()?.id !== clientId
          ) {
            return;
          }
          this.client.set(body.client);
          this.clientQuery.set(body.client.displayName);
        },
        error: () => undefined,
      });
  }

  private touch(): void {
    this.draftRevision += 1;
    this.dirty.set(true);
  }

  private loadCatalog(companyId: string): void {
    this.http.get<{ products: ProductOption[] }>(`/api/c/${companyId}/products`).subscribe({
      next: (body) => {
        if (this.companyId() === companyId) {
          this.products.set(body.products);
        }
      },
      error: () => undefined,
    });
    this.http.get<{ taxCodes: TaxOption[] }>(`/api/c/${companyId}/tax-codes`).subscribe({
      next: (body) => {
        if (this.companyId() === companyId) {
          this.taxCodes.set(body.taxCodes);
        }
      },
      error: () => undefined,
    });
  }

  private fail(generation: number, error: unknown): void {
    if (generation !== this.generation) {
      return;
    }
    this.busy.set(false);
    if (isVersionConflict(error)) {
      const body = error instanceof HttpErrorResponse ? readApiError(error) : null;
      this.conflict.set({ correlationId: body?.correlationId ?? null });
    }
  }

  private begin(): boolean {
    if (this.busy()) {
      return false;
    }
    this.busy.set(true);
    return true;
  }

  private nextKey(): string {
    this.keySeq += 1;
    return `line-${String(this.keySeq)}`;
  }
}

function storedTotals(invoice: InvoiceView): Totals | null {
  if (
    invoice.subtotal === undefined ||
    invoice.discountTotal === undefined ||
    invoice.netTotal === undefined ||
    invoice.taxTotal === undefined ||
    invoice.total === undefined
  ) {
    return null;
  }
  return {
    subtotal: invoice.subtotal,
    discountTotal: invoice.discountTotal,
    netTotal: invoice.netTotal,
    taxTotal: invoice.taxTotal,
    total: invoice.total,
    lines: invoice.lines.map((line) => ({
      position: line.position,
      taxCode: line.taxCode ?? '',
      lineSubtotal: line.lineSubtotal ?? '',
      lineDiscount: line.lineDiscount ?? '',
      lineNet: line.lineNet ?? '',
      lineGross: line.lineGross ?? '',
    })),
    taxSummary: invoice.taxSummary ?? [],
  };
}

/** A credit note's view, or null for any other document. */
function creditNoteOf(invoice: InvoiceView): CreditNoteDetail | null {
  if (invoice.documentType !== 'credit_note') {
    return null;
  }
  return {
    id: invoice.id,
    status: invoice.status,
    number: invoice.number ?? null,
    version: invoice.version,
    currency: invoice.currency,
    creditReason: invoice.creditReason ?? '',
    creditedInvoice: invoice.creditedInvoice ?? null,
    netTotal: invoice.netTotal ?? '',
    taxTotal: invoice.taxTotal ?? '',
    total: invoice.total ?? '',
    lines: [...invoice.lines]
      .sort((left, right) => left.position - right.position)
      .map((line) => ({
        id: line.id ?? '',
        position: line.position,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        discountPercent: line.discountPercent,
        taxCode: line.taxCode ?? '',
        lineNet: line.lineNet ?? '',
      })),
    taxSummary: invoice.taxSummary ?? [],
  };
}

function creditableLinesOf(invoice: InvoiceView): CreditableLine[] {
  return [...invoice.lines]
    .sort((left, right) => left.position - right.position)
    .map((line) => ({
      id: line.id ?? '',
      position: line.position,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      creditedQuantity: line.creditedQuantity ?? '0',
    }));
}

function emptyParams(): { get: (name: string) => string | null } {
  return { get: () => null };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function carriedInvoiceFrom(value: unknown): CarriedInvoice | null {
  if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['version'] !== 'number') {
    return null;
  }
  if (typeof value['status'] !== 'string' || typeof value['currency'] !== 'string') {
    return null;
  }
  if (value['documentType'] !== 'quote' && value['documentType'] !== 'invoice') {
    return null;
  }
  if (typeof value['pricesIncludeTax'] !== 'boolean') {
    return null;
  }
  if (
    typeof value['issueDate'] !== 'string' ||
    typeof value['dueDate'] !== 'string' ||
    (value['supplyDate'] !== undefined && typeof value['supplyDate'] !== 'string') ||
    typeof value['reference'] !== 'string' ||
    typeof value['notes'] !== 'string' ||
    typeof value['terms'] !== 'string'
  ) {
    return null;
  }
  const client = value['client'];
  let clientOption: ClientOption | null = null;
  if (client !== null) {
    if (!isClientOption(client)) {
      return null;
    }
    clientOption = client;
  }
  const lines = value['lines'];
  if (!isLineDraftList(lines)) {
    return null;
  }
  return {
    id: value['id'],
    version: value['version'],
    status: value['status'],
    currency: value['currency'],
    documentType: value['documentType'],
    pricesIncludeTax: value['pricesIncludeTax'],
    issueDate: value['issueDate'],
    dueDate: value['dueDate'],
    // History state saved before the supply date existed has none: empty means the issue date.
    supplyDate: typeof value['supplyDate'] === 'string' ? value['supplyDate'] : '',
    reference: value['reference'],
    notes: value['notes'],
    terms: value['terms'],
    client: clientOption,
    lines,
  };
}

function isClientOption(value: unknown): value is ClientOption {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['displayName'] !== 'string'
  ) {
    return false;
  }
  const language = value['defaultLanguage'];
  const currency = value['defaultCurrency'];
  return (
    (language === null || typeof language === 'string') &&
    (currency === null || typeof currency === 'string')
  );
}

function isLineDraft(value: unknown): value is LineDraft {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['key'] === 'string' &&
    typeof value['productId'] === 'string' &&
    typeof value['description'] === 'string' &&
    typeof value['quantity'] === 'string' &&
    typeof value['unit'] === 'string' &&
    typeof value['unitPrice'] === 'string' &&
    typeof value['discountPercent'] === 'string' &&
    typeof value['taxCodeId'] === 'string' &&
    (value['kind'] === 'item' || value['kind'] === 'shipping')
  );
}

function isLineDraftList(value: unknown): value is LineDraft[] {
  return Array.isArray(value) && value.every(isLineDraft);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
