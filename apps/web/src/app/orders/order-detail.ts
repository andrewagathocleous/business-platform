import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { combineLatest, forkJoin, of } from 'rxjs';
import { isVersionConflict, readApiError } from '../core/api-error';
import { CompanyContextStore } from '../core/company-context.store';
import { NAVIGATE_ON_DENIED } from '../core/navigate-on-denied';
import { SessionStore } from '../core/session.store';
import { ActiveLang } from '../format/active-lang';
import { CompanyDatePipe } from '../format/company-date.pipe';
import { MoneyPipe } from '../format/money.pipe';
import { fieldValue } from './field-value';
import { GiftMessageComponent } from './gift-message';
import { translateCode } from './labels';
import type { ActivityEvent, AssignedTo, OrderDetail, StoreFilter, TransitionDecision } from './models';
import { partyLines } from './party';
import { PrintPanelComponent } from './print-panel';
import { StatusTagsComponent } from './status-tags';

type DetailResponse = { order: OrderDetail };
type ActivityResponse = { events: ActivityEvent[] };

@Component({
  selector: 'bp-order-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TranslocoPipe,
    RouterLink,
    Button,
    MoneyPipe,
    CompanyDatePipe,
    GiftMessageComponent,
    StatusTagsComponent,
    PrintPanelComponent,
  ],
  template: `
    @if (conflict(); as item) {
      <div class="app-toast" role="alert">
        <p>{{ 'orders.conflict.message' | transloco }}</p>
        @if (item.correlationId) {
          <p>{{ 'errors.correlation' | transloco }}: {{ item.correlationId }}</p>
        }
        <p-button type="button" [label]="'orders.conflict.reload' | transloco" (onClick)="reload()" />
      </div>
    }
    @if (loading()) {
      <p role="status">{{ 'orders.detailLoading' | transloco }}</p>
    }
    @if (error()) {
      <p role="alert">{{ 'orders.detailError' | transloco }}</p>
    }
    @if (order(); as current) {
      <article class="order-detail">
        <p><a [routerLink]="['/c', companyId(), 'orders']">{{ 'orders.title' | transloco }}</a></p>
        <header class="order-header card">
          <div class="order-heading">
            <h1>{{ current.externalNumber }}</h1>
            <p>{{ storeName(current.storeId) }}</p>
            <p>{{ current.sourceCreatedAt | companyDate: context.timezone() : lang.code() }}</p>
            <p class="order-total">{{ current.total | money: current.currency : lang.code() }}</p>
            <bp-status-tags
              [paymentStatus]="current.paymentStatus"
              [fulfilmentStatus]="current.fulfilmentStatus"
              [integrationStatus]="current.integrationStatus"
            />
            <p>{{ label('orders.delivery', current.deliveryMethod) }}</p>
            <p>{{ current.assignedTo?.displayName ?? ('orders.unassigned' | transloco) }}</p>
          </div>
          <div class="order-actions">
            <div class="transition-stack">
            <div class="transition-group">
              @for (decision of allowedForward(); track decision.to) {
                <p-button
                  type="button"
                  [label]="'orders.markAs' | transloco: { status: label('orders.fulfilment', decision.to) }"
                  [disabled]="busy()"
                  (onClick)="transition(decision)"
                />
              }
              @if (allowedCancel(); as decision) {
                <p-button
                  type="button"
                  severity="danger"
                  [label]="'orders.cancel.button' | transloco"
                  [disabled]="busy()"
                  (onClick)="transition(decision)"
                />
              }
            </div>
            @if (blockedTransitions().length > 0) {
              <ul class="not-available">
                @for (decision of blockedTransitions(); track decision.to) {
                  <li>
                    {{
                      'orders.notAvailable'
                        | transloco
                          : {
                              status: label('orders.fulfilment', decision.to),
                              reason: label('orders.transitionErrors', decision.error ?? 'transition_not_allowed'),
                            }
                    }}
                  </li>
                }
              </ul>
            }
            </div>
          </div>
        </header>

        <div class="order-columns">
          <div class="order-main">
            <div class="party-grid">
              <section class="card">
                <h2>{{ 'orders.customer' | transloco }}</h2>
                @for (line of lines(current.customer); track $index) {
                  <p>{{ line }}</p>
                }
              </section>
              <section class="card">
                <h2>{{ 'orders.recipient' | transloco }}</h2>
                @for (line of lines(current.recipient); track $index) {
                  <p>{{ line }}</p>
                }
              </section>
              <section class="card">
                <h2>{{ 'orders.billing' | transloco }}</h2>
                @for (line of lines(current.billingAddress); track $index) {
                  <p>{{ line }}</p>
                }
              </section>
            </div>

            <section class="card">
              <h2>{{ 'orders.items' | transloco }}</h2>
              @if (current.lines.length === 0) {
                <p>{{ 'orders.noItems' | transloco }}</p>
              } @else {
                <div class="table-scroll">
                  <table class="items">
                    <thead>
                      <tr>
                        <th>{{ 'orders.sku' | transloco }}</th>
                        <th>{{ 'orders.itemTitle' | transloco }}</th>
                        <th>{{ 'orders.variant' | transloco }}</th>
                        <th class="num">{{ 'orders.quantity' | transloco }}</th>
                        <th class="num">{{ 'orders.unitPrice' | transloco }}</th>
                        <th class="num">{{ 'orders.lineTotal' | transloco }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (line of current.lines; track line.id) {
                        <tr>
                          <td>{{ line.sku }}</td>
                          <td>{{ line.title }}</td>
                          <td>{{ line.variantTitle }}</td>
                          <td class="num">{{ line.quantity }}</td>
                          <td class="num">{{ line.unitPrice | money: current.currency : lang.code() }}</td>
                          <td class="num">{{ line.total | money: current.currency : lang.code() }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
              <div class="totals">
                <p><span>{{ 'orders.subtotal' | transloco }}</span><span>{{ current.subtotal | money: current.currency : lang.code() }}</span></p>
                <p><span>{{ 'orders.shipping' | transloco }}</span><span>{{ current.shippingTotal | money: current.currency : lang.code() }}</span></p>
                <p><span>{{ 'orders.tax' | transloco }}</span><span>{{ current.taxTotal | money: current.currency : lang.code() }}</span></p>
                <p><span>{{ 'orders.columns.total' | transloco }}</span><span>{{ current.total | money: current.currency : lang.code() }}</span></p>
              </div>
            </section>

            <section class="card">
              <h2>{{ 'orders.gift.title' | transloco }}</h2>
              <bp-gift-message [message]="current.giftMessage" />
              @if (current.giftMessage !== null && current.can.downloadDocuments) {
                <a [href]="documentHref('gift-message.pdf')" target="_blank" rel="noopener">
                  {{ 'orders.gift.preview' | transloco }}
                </a>
              }
            </section>

            <section class="card">
              <h2>{{ 'orders.customerNote.title' | transloco }}</h2>
              @if (current.customerNote === null) {
                <p>{{ 'orders.customerNote.none' | transloco }}</p>
              } @else {
                <div class="exact-text">{{ current.customerNote }}</div>
              }
            </section>

            <section class="card">
              <h2>{{ 'orders.notes.title' | transloco }}</h2>
              @if (current.notes.length === 0) {
                <p>{{ 'orders.notes.none' | transloco }}</p>
              }
              @for (note of current.notes; track note.id) {
                <article>
                  <p>{{ note.authorDisplayName ?? label('orders.actor', 'user') }}</p>
                  <p>{{ note.createdAt | companyDate: context.timezone() : lang.code() }}</p>
                  <div class="exact-text">{{ note.body }}</div>
                </article>
              }
              @if (current.can.edit) {
                <label>
                  {{ 'orders.notes.label' | transloco }}
                  <textarea class="control" [value]="draft()" (input)="onDraft($event)"></textarea>
                </label>
                <p-button
                  type="button"
                  severity="secondary"
                  [label]="'orders.notes.add' | transloco"
                  [disabled]="busy() || draft() === ''"
                  (onClick)="addNote()"
                />
              }
            </section>
          </div>

          <div class="order-side">
            <section class="card">
              <h2>{{ 'orders.assignment.title' | transloco }}</h2>
              @if (current.can.claim) {
                <p-button
                  type="button"
                  severity="secondary"
                  [label]="'orders.assignment.claim' | transloco"
                  [disabled]="busy()"
                  (onClick)="claim()"
                />
              }
              @if (current.can.assign) {
                <label>
                  {{ 'orders.assignment.assignTo' | transloco }}
                  <select class="control" (change)="assigneeId.set(fieldValue($event))">
                    <option value="" [selected]="assigneeId() === ''">{{ 'orders.assignment.choose' | transloco }}</option>
                    @for (user of assignees(); track user.userId) {
                      <option [value]="user.userId" [selected]="user.userId === assigneeId()">{{ user.displayName }}</option>
                    }
                  </select>
                </label>
                <p-button
                  type="button"
                  severity="secondary"
                  [label]="'orders.assignment.assign' | transloco"
                  [disabled]="busy() || assigneeId() === ''"
                  (onClick)="assignSelected()"
                />
                <p-button
                  type="button"
                  severity="secondary"
                  [label]="'orders.assignment.unassign' | transloco"
                  [disabled]="busy()"
                  (onClick)="assign(null)"
                />
              }
            </section>

            <section class="card">
              <h2>{{ 'orders.print.title' | transloco }}</h2>
              <bp-print-panel
                [companyId]="companyId()"
                [orderId]="orderId()"
                [documentType]="'packing_slip'"
                [job]="current.printJobs.packing_slip"
                [firstPrintAvailable]="current.firstPrintAvailable.packing_slip"
                [canSubmit]="current.can.printSubmit"
                [canReprint]="current.can.printReprint"
                [canConfirm]="current.can.printConfirm"
                [canPreview]="current.can.downloadDocuments"
                [zone]="context.timezone()"
                [lang]="lang.code()"
                (changed)="reload()"
              />
              @if (current.giftMessage !== null) {
                <bp-print-panel
                  [companyId]="companyId()"
                  [orderId]="orderId()"
                  [documentType]="'gift_message'"
                  [job]="current.printJobs.gift_message"
                  [firstPrintAvailable]="current.firstPrintAvailable.gift_message"
                  [canSubmit]="current.can.printSubmit"
                  [canReprint]="current.can.printReprint"
                  [canConfirm]="current.can.printConfirm"
                  [canPreview]="current.can.downloadDocuments"
                  [zone]="context.timezone()"
                  [lang]="lang.code()"
                  (changed)="reload()"
                />
              }
            </section>

            <section class="card">
              <h2>{{ 'orders.activity.title' | transloco }}</h2>
              @if (events().length === 0) {
                <p>{{ 'orders.activity.none' | transloco }}</p>
              }
              <ol class="activity">
                @for (event of events(); track event.id) {
                  <li [class.outcome-bad]="event.outcome === 'denied' || event.outcome === 'failure'">
                    <span>{{ event.occurredAt | companyDate: context.timezone() : lang.code() }}</span>
                    <span>{{ actor(event) }}</span>
                    <span>{{ label('orders.activity', event.action) }}</span>
                    @if (transitionChange(event); as change) {
                      <span>{{ change }}</span>
                    }
                    @if (transitionReason(event); as reason) {
                      <span>{{ reason }}</span>
                    }
                    @if (assignmentName(event); as name) {
                      <span>{{ name }}</span>
                    }
                    <span>{{ label('orders.outcome', event.outcome) }}</span>
                  </li>
                }
              </ol>
            </section>
          </div>
        </div>

        @if (cancelOpen()) {
          <div class="dialog" role="dialog" [attr.aria-label]="'orders.cancel.title' | transloco">
            <p>{{ 'orders.cancel.prompt' | transloco }}</p>
            <label>
              {{ 'orders.cancel.reason' | transloco }}
              <textarea class="control" [value]="cancelReason()" (input)="onCancelReason($event)"></textarea>
            </label>
            <p-button
              type="button"
              severity="danger"
              [label]="'orders.cancel.confirm' | transloco"
              [disabled]="busy()"
              (onClick)="confirmCancel()"
            />
            <p-button
              type="button"
              severity="secondary"
              [label]="'orders.cancel.back' | transloco"
              (onClick)="cancelOpen.set(false)"
            />
          </div>
        }
      </article>
    }
  `,
})
export class OrderDetailPage {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly transloco = inject(TranslocoService);
  private readonly session = inject(SessionStore);
  readonly context = inject(CompanyContextStore);
  readonly lang = inject(ActiveLang);

  readonly companyId = signal('');
  readonly orderId = signal('');
  readonly order = signal<OrderDetail | null>(null);
  readonly events = signal<ActivityEvent[]>([]);
  readonly stores = signal<StoreFilter[]>([]);
  readonly assignees = signal<AssignedTo[]>([]);
  readonly loading = signal(false);
  readonly error = signal(false);
  readonly draft = signal('');
  readonly assigneeId = signal('');
  readonly cancelOpen = signal(false);
  readonly cancelReason = signal('');
  readonly conflict = signal<{ correlationId: string | null } | null>(null);
  readonly mutating = signal(false);
  readonly refreshing = signal(false);
  readonly busy = computed(() => this.mutating() || this.refreshing());
  readonly fieldValue = fieldValue;
  /** Changes only when a different order is opened. A refresh of the same order does not bump it. */
  private orderToken = 0;
  /** Changes on every detail fetch so an older response cannot overwrite a newer one. */
  private fetchToken = 0;
  private storesFor: string | null = null;

  constructor() {
    const companyId$ = this.route.parent?.paramMap ?? of(emptyParams());
    combineLatest([companyId$, this.route.paramMap])
      .pipe(takeUntilDestroyed())
      .subscribe(([company, order]) => {
        this.open(company.get('companyId') ?? '', order.get('orderId') ?? '');
      });
  }

  open(companyId: string, orderId: string): void {
    const changed = companyId !== this.companyId() || orderId !== this.orderId();
    this.companyId.set(companyId);
    this.orderId.set(orderId);
    if (companyId.length === 0 || orderId.length === 0) {
      this.loading.set(false);
      return;
    }
    if (changed) {
      this.orderToken += 1;
      this.order.set(null);
      this.events.set([]);
      this.assignees.set([]);
      this.draft.set('');
      this.assigneeId.set('');
      this.conflict.set(null);
      this.cancelOpen.set(false);
      this.cancelReason.set('');
      this.error.set(false);
      this.loading.set(true);
      this.mutating.set(false);
    }
    this.loadStores(companyId);
    this.fetch();
  }

  reload(): void {
    this.conflict.set(null);
    this.fetch();
  }

  lines(value: unknown): string[] {
    return partyLines(value);
  }

  label(prefix: string, code: string): string {
    return translateCode(this.transloco, prefix, code);
  }

  storeName(storeId: string): string {
    return this.stores().find((store) => store.id === storeId)?.name ?? '';
  }

  actor(event: ActivityEvent): string {
    if (event.actorLabel && event.actorLabel.length > 0) {
      return event.actorLabel;
    }
    return this.label('orders.actor', event.actorType);
  }

  allowedForward(): TransitionDecision[] {
    return (this.order()?.allowedTransitions ?? []).filter(
      (decision) => decision.to !== 'cancelled' && decision.allowed,
    );
  }

  allowedCancel(): TransitionDecision | null {
    const current = this.order();
    if (!current?.can.cancel) {
      return null;
    }
    const decision = current.allowedTransitions.find((item) => item.to === 'cancelled') ?? null;
    return decision?.allowed ? decision : null;
  }

  blockedTransitions(): TransitionDecision[] {
    return (this.order()?.allowedTransitions ?? []).filter((decision) => !decision.allowed);
  }

  transitionChange(event: ActivityEvent): string | null {
    if (event.action !== 'order.transition') {
      return null;
    }
    const from = detailField(event.details, 'from');
    const to = detailField(event.details, 'to');
    if (!from || !to) {
      return null;
    }
    return `${this.label('orders.fulfilment', from)} → ${this.label('orders.fulfilment', to)}`;
  }

  transitionReason(event: ActivityEvent): string | null {
    if (event.action !== 'order.transition') {
      return null;
    }
    const reason = detailField(event.details, 'reason');
    return reason && reason.length > 0 ? reason : null;
  }

  assignmentName(event: ActivityEvent): string | null {
    if (event.action !== 'order.assigned' && event.action !== 'order.claimed') {
      return null;
    }
    const userId = detailField(event.details, 'userId');
    if (!userId) {
      return null;
    }
    const id = userId.toLowerCase();
    const assigned = this.order()?.assignedTo;
    if (assigned && assigned.userId.toLowerCase() === id) {
      return assigned.displayName;
    }
    return this.assignees().find((user) => user.userId.toLowerCase() === id)?.displayName ?? null;
  }

  documentHref(file: string): string {
    return `/api/c/${this.companyId()}/orders/${this.orderId()}/documents/${file}`;
  }

  onDraft(event: Event): void {
    this.draft.set(fieldValue(event));
  }

  onCancelReason(event: Event): void {
    this.cancelReason.set(fieldValue(event));
  }

  addNote(): void {
    const body = this.draft();
    if (body === '' || !this.begin()) {
      return;
    }
    const orderToken = this.orderToken;
    this.http.post(`/api/c/${this.companyId()}/orders/${this.orderId()}/notes`, { body }).subscribe({
      next: () => {
        if (orderToken !== this.orderToken) {
          return;
        }
        this.draft.set('');
        this.mutating.set(false);
        this.fetch();
      },
      error: (error: unknown) => {
        this.fail(orderToken, error);
      },
    });
  }

  claim(): void {
    const userId = this.session.user()?.id;
    if (!userId) {
      return;
    }
    this.assign(userId);
  }

  assignSelected(): void {
    if (this.assigneeId() === '') {
      return;
    }
    this.assign(this.assigneeId());
  }

  assign(userId: string | null): void {
    const current = this.order();
    if (!current || !this.begin()) {
      return;
    }
    const orderToken = this.orderToken;
    this.http
      .post(`/api/c/${this.companyId()}/orders/${this.orderId()}/assign`, {
        userId,
        expectedVersion: current.version,
      })
      .subscribe({
        next: () => {
          if (orderToken !== this.orderToken) {
            return;
          }
          this.mutating.set(false);
          this.fetch();
        },
        error: (error: unknown) => {
          this.fail(orderToken, error);
        },
      });
  }

  transition(decision: TransitionDecision): void {
    if (!decision.allowed || this.mutating()) {
      return;
    }
    if (decision.to === 'cancelled') {
      this.cancelOpen.set(true);
      return;
    }
    this.postTransition(decision.to);
  }

  confirmCancel(): void {
    const reason = this.cancelReason();
    this.cancelOpen.set(false);
    this.postTransition('cancelled', reason.length > 0 ? reason : undefined);
  }

  private postTransition(to: string, reason?: string): void {
    const current = this.order();
    if (!current || !this.begin()) {
      return;
    }
    const orderToken = this.orderToken;
    this.http
      .post(`/api/c/${this.companyId()}/orders/${this.orderId()}/transitions`, {
        to,
        expectedVersion: current.version,
        ...(reason !== undefined ? { reason } : {}),
      })
      .subscribe({
        next: () => {
          if (orderToken !== this.orderToken) {
            return;
          }
          this.cancelReason.set('');
          this.mutating.set(false);
          this.fetch();
        },
        error: (error: unknown) => {
          this.fail(orderToken, error);
        },
      });
  }

  private begin(): boolean {
    if (this.mutating()) {
      return false;
    }
    this.mutating.set(true);
    return true;
  }

  private fail(orderToken: number, error: unknown): void {
    if (orderToken !== this.orderToken) {
      return;
    }
    this.mutating.set(false);
    if (isVersionConflict(error)) {
      const body = error instanceof HttpErrorResponse ? readApiError(error) : null;
      this.conflict.set({ correlationId: body?.correlationId ?? null });
    }
  }

  private fetch(): void {
    const companyId = this.companyId();
    const orderId = this.orderId();
    const orderToken = this.orderToken;
    const fetchToken = ++this.fetchToken;
    this.refreshing.set(true);
    this.loading.set(this.order() === null);
    this.error.set(false);
    forkJoin({
      detail: this.http.get<DetailResponse>(`/api/c/${companyId}/orders/${orderId}`, {
        context: new HttpContext().set(NAVIGATE_ON_DENIED, true),
      }),
      activity: this.http.get<ActivityResponse>(`/api/c/${companyId}/orders/${orderId}/activity`),
    }).subscribe({
      next: (body) => {
        if (orderToken !== this.orderToken || fetchToken !== this.fetchToken) {
          return;
        }
        this.order.set(body.detail.order);
        this.events.set(body.activity.events);
        this.loading.set(false);
        this.refreshing.set(false);
        if (body.detail.order.can.assign) {
          this.loadAssignees(companyId, orderId);
        } else {
          this.assignees.set([]);
        }
      },
      error: () => {
        if (orderToken !== this.orderToken || fetchToken !== this.fetchToken) {
          return;
        }
        this.loading.set(false);
        this.refreshing.set(false);
        if (this.order() === null) {
          this.error.set(true);
        }
      },
    });
  }

  private loadStores(companyId: string): void {
    if (this.storesFor === companyId) {
      return;
    }
    this.storesFor = companyId;
    this.http.get<{ stores: StoreFilter[] }>(`/api/c/${companyId}/order-filters`).subscribe({
      next: (body) => {
        if (this.companyId() === companyId) {
          this.stores.set(body.stores);
        }
      },
      error: () => {
        if (this.companyId() === companyId) {
          this.stores.set([]);
        }
      },
    });
  }

  private loadAssignees(companyId: string, orderId: string): void {
    this.http.get<{ users: AssignedTo[] }>(`/api/c/${companyId}/orders/${orderId}/assignees`).subscribe({
      next: (body) => {
        if (this.orderId() === orderId) {
          this.assignees.set(body.users);
        }
      },
      error: () => {
        if (this.orderId() === orderId) {
          this.assignees.set([]);
        }
      },
    });
  }
}

function detailField(details: unknown, key: string): string | null {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    return null;
  }
  const value = (details as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function emptyParams(): { get: (name: string) => string | null } {
  return { get: () => null };
}
