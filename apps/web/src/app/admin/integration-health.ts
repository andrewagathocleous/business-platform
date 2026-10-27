import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { Tag } from 'primeng/tag';
import { CompanyContextStore } from '../core/company-context.store';
import { ActiveLang } from '../format/active-lang';
import { CompanyDatePipe } from '../format/company-date.pipe';
import type { TagSeverity } from '../orders/status-tags';

export const HEALTH_REFRESH_MS = 60_000;

type HealthLevel = 'ok' | 'warning' | 'error' | 'paused';

type StoreHealth = {
  storeId: string;
  storeName: string;
  connection: null | {
    id: string;
    status: string;
    keySet: boolean;
    lastSyncAt: string | null;
    lastErrorClass: string | null;
    lastErrorAt: string | null;
    pollIntervalSeconds: number | null;
    health: { level: HealthLevel; reason: string };
    failedImports: number;
    waitingImports: number;
    reviewRequired: number;
  };
};

type MappedPrinter = { printerName: string; paper: string; printerStatus: string } | null;

export type HealthView = {
  now: string;
  prestashop: StoreHealth[];
  printing: {
    printNodeKeySet: boolean;
    printNodeKeySetAt: string | null;
    printers: {
      id: string;
      name: string;
      provider: string;
      status: string;
      lastSeenAt: string | null;
      locationName: string;
    }[];
    lastDiscoveryAt: string | null;
    mappings: {
      locationId: string;
      locationName: string;
      giftMessage: MappedPrinter;
      packingSlip: MappedPrinter;
    }[];
    failedLast24h: number;
  };
};

/**
 * Read-only status of store connections and printing. It reads the database through the API
 * only, refreshes every minute while the page is visible, and drops answers for a company
 * that is no longer shown.
 */
@Component({
  selector: 'bp-integration-health',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, Button, Tag, CompanyDatePipe, RouterLink],
  template: `
    <section data-testid="health" aria-labelledby="health-title">
      <h2 id="health-title">{{ 'integrations.health.title' | transloco }}</h2>
      <p-button
        type="button"
        [label]="'integrations.health.refresh' | transloco"
        [disabled]="loading()"
        (onClick)="refresh()"
      />
      @if (error()) {
        <p role="alert">{{ error() }}</p>
      }
      @if (health(); as view) {
        <h3>{{ 'integrations.health.prestashop' | transloco }}</h3>
        @if (view.prestashop.length === 0) {
          <p>{{ 'integrations.health.noStores' | transloco }}</p>
        }
        <ul data-testid="health-stores">
          @for (row of view.prestashop; track row.storeId) {
            <li [attr.data-store]="row.storeId">
              <strong>{{ row.storeName }}</strong>
              @if (row.connection; as connection) {
                <p-tag
                  [severity]="severity(connection.health.level)"
                  [value]="levelLabel(connection.health.level)"
                />
                <span data-testid="health-sentence">{{ sentence(view, row) }}</span>
                <span>
                  {{ 'integrations.health.lastSync' | transloco }}:
                  @if (connection.lastSyncAt) {
                    {{ connection.lastSyncAt | companyDate: context.timezone() : lang.code() }}
                  } @else {
                    {{ 'integrations.health.never' | transloco }}
                  }
                </span>
                @if (!connection.keySet) {
                  <span>{{ 'integrations.health.keyNotSet' | transloco }}</span>
                }
                @if (connection.reviewRequired > 0) {
                  @if (canSeeOrders()) {
                    <a
                      data-testid="health-review"
                      [routerLink]="['/c', companyId(), 'orders']"
                      [queryParams]="{ fulfilmentStatus: 'review_required', storeId: row.storeId }"
                      >{{
                        'integrations.health.reviewRequired'
                          | transloco: { count: connection.reviewRequired }
                      }}</a
                    >
                  } @else {
                    <span>{{
                      'integrations.health.reviewRequired' | transloco: { count: connection.reviewRequired }
                    }}</span>
                  }
                }
                @if (connection.failedImports > 0 || connection.waitingImports > 0) {
                  @if (canSeeAutomation()) {
                    <a
                      data-testid="health-imports"
                      [routerLink]="['/c', companyId(), 'admin', 'automation']"
                      [queryParams]="{ jobStatus: 'failed' }"
                      >{{ importsText(connection.failedImports, connection.waitingImports) }}</a
                    >
                  } @else {
                    <span data-testid="health-imports">{{
                      importsText(connection.failedImports, connection.waitingImports)
                    }}</span>
                  }
                }
              } @else {
                <span>{{ 'integrations.health.notConnected' | transloco }}</span>
              }
            </li>
          }
        </ul>

        <h3>{{ 'integrations.health.printing' | transloco }}</h3>
        <p data-testid="health-printnode">
          @if (view.printing.printNodeKeySet) {
            {{ 'integrations.health.printNodeKeySet' | transloco }}
          } @else {
            {{ 'integrations.health.printNodeKeyNotSet' | transloco }}
          }
        </p>
        @if (view.printing.printers.length === 0) {
          <p>{{ 'integrations.health.noPrinters' | transloco }}</p>
        }
        <ul data-testid="health-printers">
          @for (printer of view.printing.printers; track printer.id) {
            <li>
              {{ printer.name }} ({{ printer.locationName }})
              @if (printer.provider === 'mock') {
                <p-tag severity="secondary" [value]="'integrations.health.simulated' | transloco" />
              }
              <p-tag
                [severity]="printer.status === 'online' ? 'success' : printer.status === 'offline' ? 'danger' : 'secondary'"
                [value]="'integrations.health.printer.' + printer.status | transloco"
              />
              @if (printer.lastSeenAt) {
                <span>
                  {{ 'integrations.health.lastSeen' | transloco }}:
                  {{ printer.lastSeenAt | companyDate: context.timezone() : lang.code() }}
                </span>
              }
            </li>
          }
        </ul>
        <ul data-testid="health-mappings">
          @for (location of view.printing.mappings; track location.locationId) {
            <li>
              <strong>{{ location.locationName }}</strong>
              <span>
                {{ 'integrations.health.giftCards' | transloco }}:
                {{ mappedText(location.giftMessage) }}
              </span>
              <span>
                {{ 'integrations.health.packingSlips' | transloco }}:
                {{ mappedText(location.packingSlip) }}
              </span>
            </li>
          }
        </ul>
        @if (canManagePrinters()) {
          <a data-testid="health-printers-link" [routerLink]="['/c', companyId(), 'admin', 'printers']">{{
            'integrations.health.printersLink' | transloco
          }}</a>
        }
        @if (view.printing.failedLast24h > 0) {
          @if (canSeeAutomation()) {
            <a
              data-testid="health-failed-prints"
              [routerLink]="['/c', companyId(), 'admin', 'automation']"
              [queryParams]="{ printStatus: 'failed' }"
              >{{ 'integrations.health.failedPrints' | transloco: { count: view.printing.failedLast24h } }}</a
            >
          } @else {
            <span data-testid="health-failed-prints">{{
              'integrations.health.failedPrints' | transloco: { count: view.printing.failedLast24h }
            }}</span>
          }
        }
      }
    </section>
  `,
})
export class IntegrationHealthPanel {
  readonly companyId = input.required<string>();

  private readonly http = inject(HttpClient);
  private readonly transloco = inject(TranslocoService);
  private readonly destroyRef = inject(DestroyRef);
  readonly context = inject(CompanyContextStore);
  readonly lang = inject(ActiveLang);

  readonly health = signal<HealthView | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');

  /** Changes with the company. An answer for an earlier company is dropped. */
  private generation = 0;
  private loadedFor = '';

  constructor() {
    effect(() => {
      const companyId = this.companyId();
      if (companyId === this.loadedFor) {
        return;
      }
      this.loadedFor = companyId;
      this.generation += 1;
      this.health.set(null);
      this.error.set('');
      this.loading.set(false);
      this.load();
    });
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        this.load();
      }
    }, HEALTH_REFRESH_MS);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
    });
  }

  refresh(): void {
    this.load();
  }

  canSeeOrders(): boolean {
    return this.context.has('order.view');
  }

  canSeeAutomation(): boolean {
    return this.context.has('automation.view');
  }

  canManagePrinters(): boolean {
    return this.context.has('printer.manage');
  }

  severity(level: HealthLevel): TagSeverity {
    switch (level) {
      case 'ok':
        return 'success';
      case 'warning':
        return 'warn';
      case 'error':
        return 'danger';
      default:
        return 'secondary';
    }
  }

  levelLabel(level: HealthLevel): string {
    return this.transloco.translate(`integrations.health.level.${level}`);
  }

  sentence(view: HealthView, row: StoreHealth): string {
    const connection = row.connection;
    if (!connection) {
      return '';
    }
    const reason = connection.health.reason;
    if (reason === 'sync_late' || reason === 'sync_stale') {
      return this.transloco.translate(`integrations.health.reason.${reason}`, {
        minutes: minutesBetween(connection.lastSyncAt, view.now),
      });
    }
    if (reason === 'last_run_failed') {
      return this.transloco.translate('integrations.health.reason.last_run_failed', {
        errorClass: connection.lastErrorClass ?? '',
      });
    }
    return this.transloco.translate(`integrations.health.reason.${reason}`);
  }

  importsText(failed: number, waiting: number): string {
    const parts: string[] = [];
    if (failed > 0) {
      parts.push(this.transloco.translate('integrations.health.failedImports', { count: failed }));
    }
    if (waiting > 0) {
      parts.push(this.transloco.translate('integrations.health.waitingImports', { count: waiting }));
    }
    return parts.join(', ');
  }

  mappedText(mapped: MappedPrinter): string {
    if (!mapped) {
      return this.transloco.translate('integrations.health.notMapped');
    }
    const status = this.transloco.translate(`integrations.health.printer.${mapped.printerStatus}`);
    return `${mapped.printerName} (${mapped.paper}, ${status})`;
  }

  private load(): void {
    const companyId = this.companyId();
    if (!companyId || this.loading()) {
      return;
    }
    const generation = this.generation;
    this.loading.set(true);
    this.http
      .get<HealthView>(`/api/c/${companyId}/integrations/health`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (view) => {
          if (generation !== this.generation) {
            return;
          }
          this.loading.set(false);
          this.error.set('');
          this.health.set(view);
        },
        error: (error: unknown) => {
          if (generation !== this.generation) {
            return;
          }
          this.loading.set(false);
          this.error.set(
            error instanceof HttpErrorResponse && error.status === 403
              ? this.transloco.translate('integrations.forbidden')
              : this.transloco.translate('integrations.health.loadError'),
          );
        },
      });
  }
}

function minutesBetween(from: string | null, to: string): number {
  if (!from) {
    return 0;
  }
  return Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 60_000));
}
