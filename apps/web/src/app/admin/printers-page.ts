import { HttpClient, HttpContext } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { of } from 'rxjs';
import { CompanyContextStore } from '../core/company-context.store';
import { NAVIGATE_ON_DENIED } from '../core/navigate-on-denied';
import { ActiveLang } from '../format/active-lang';
import { CompanyDatePipe } from '../format/company-date.pipe';
import { fieldValue } from '../orders/field-value';

const DOCUMENT_TYPES = ['invoice', 'packing_slip', 'gift_message', 'shipping_label'] as const;
type DocumentType = (typeof DOCUMENT_TYPES)[number];

type LocationRow = { id: string; name: string };
type PrinterRow = {
  id: string;
  locationId: string;
  provider: string;
  name: string;
  paperSizes: string[];
  status: string;
  lastSeenAt: string | null;
  simulationLabel: string | null;
};
type MappingRow = {
  locationId: string;
  documentType: string;
  printerId: string;
  paperSize: string;
  copies: number;
};
type MappingDraft = {
  locationId: string;
  documentType: DocumentType;
  printerId: string;
  paperSize: string;
  copies: string;
};

const COPY_COUNTS: Record<string, number> = { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 };

@Component({
  selector: 'bp-printers-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, Button, CompanyDatePipe],
  template: `
    <section class="screen">
      <h1>{{ 'printers.title' | transloco }}</h1>
      @if (loading()) {
        <p role="status">{{ 'printers.loading' | transloco }}</p>
      }
      @if (loadError()) {
        <p role="alert">{{ 'printers.error' | transloco }}</p>
      }
      <div class="table-scroll">
        <table class="items">
          <thead>
            <tr>
              <th>{{ 'printers.columns.name' | transloco }}</th>
              <th>{{ 'printers.columns.location' | transloco }}</th>
              <th>{{ 'printers.columns.provider' | transloco }}</th>
              <th>{{ 'printers.columns.status' | transloco }}</th>
              <th>{{ 'printers.columns.paper' | transloco }}</th>
              <th>{{ 'printers.columns.lastSeen' | transloco }}</th>
            </tr>
          </thead>
          <tbody>
            @for (printer of printers(); track printer.id) {
              <tr>
                <td>
                  {{ printer.name }}
                  @if (printer.provider === 'mock' || printer.simulationLabel) {
                    <span class="simulated-badge">{{ 'orders.print.simulated' | transloco }}</span>
                  }
                </td>
                <td>{{ locationName(printer.locationId) }}</td>
                <td>{{ printer.provider }}</td>
                <td>{{ printer.status }}</td>
                <td>{{ printer.paperSizes.join(', ') }}</td>
                <td>{{ printer.lastSeenAt | companyDate: context.timezone() : lang.code() }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <form class="form-grid" (submit)="$event.preventDefault(); discover()">
        <p class="span-all">{{ 'printers.discoverNote' | transloco }}</p>
        <label>
          {{ 'printers.fields.location' | transloco }}
          <select (change)="discoverLocation.set(field($event))">
            <option value="" [selected]="discoverLocation() === ''">{{ 'printers.anyLocation' | transloco }}</option>
            @for (location of locations(); track location.id) {
              <option [value]="location.id" [selected]="location.id === discoverLocation()">{{ location.name }}</option>
            }
          </select>
        </label>
        <div class="form-actions">
          <p-button type="button" [label]="'printers.discover' | transloco" [disabled]="busy()" (onClick)="discover()" />
        </div>
      </form>
      <h2>{{ 'printers.mappings' | transloco }}</h2>
      <div class="table-scroll table-fit mapping-table">
        <table class="items">
          <thead>
            <tr>
              <th>{{ 'printers.columns.location' | transloco }}</th>
              <th>{{ 'printers.fields.printer' | transloco }}</th>
              <th>{{ 'printers.fields.paper' | transloco }}</th>
              <th>{{ 'printers.fields.copies' | transloco }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (row of mappings(); track row.locationId + row.documentType) {
              <tr>
                <td>{{ mappingTitle(row) }}</td>
                <td>
                  <select [attr.aria-label]="'printers.fields.printer' | transloco" (change)="setPrinter(row, $event)">
                    <option value="" [selected]="row.printerId === ''">{{ 'printers.choosePrinter' | transloco }}</option>
                    @for (printer of printersAt(row.locationId); track printer.id) {
                      <option [value]="printer.id" [selected]="printer.id === row.printerId">{{ printer.name }}</option>
                    }
                  </select>
                </td>
                <td>
                  <select [attr.aria-label]="'printers.fields.paper' | transloco" (change)="setPaper(row, $event)">
                    @for (size of paperSizes(row); track size) {
                      <option [value]="size" [selected]="size === row.paperSize">{{ size }}</option>
                    }
                  </select>
                </td>
                <td>
                  <select [attr.aria-label]="'printers.fields.copies' | transloco" (change)="setCopies(row, $event)">
                    @for (count of copyChoices; track count) {
                      <option [value]="count" [selected]="count === row.copies">{{ count }}</option>
                    }
                  </select>
                </td>
                <td>
                  <p-button
                    type="button"
                    size="small"
                    [label]="'printers.saveMapping' | transloco"
                    [disabled]="!mappingCanSave(row)"
                    (onClick)="saveMapping(row)"
                  />
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <div class="mapping-cards">
        @for (row of mappings(); track row.locationId + row.documentType) {
          <article class="repeat-item">
            <header class="repeat-head">
              <h3>{{ mappingTitle(row) }}</h3>
              <p-button
                type="button"
                size="small"
                [label]="'printers.saveMapping' | transloco"
                [disabled]="!mappingCanSave(row)"
                (onClick)="saveMapping(row)"
              />
            </header>
            <label>
              {{ 'printers.fields.printer' | transloco }}
              <select (change)="setPrinter(row, $event)">
                <option value="" [selected]="row.printerId === ''">{{ 'printers.choosePrinter' | transloco }}</option>
                @for (printer of printersAt(row.locationId); track printer.id) {
                  <option [value]="printer.id" [selected]="printer.id === row.printerId">{{ printer.name }}</option>
                }
              </select>
            </label>
            <label>
              {{ 'printers.fields.paper' | transloco }}
              <select (change)="setPaper(row, $event)">
                @for (size of paperSizes(row); track size) {
                  <option [value]="size" [selected]="size === row.paperSize">{{ size }}</option>
                }
              </select>
            </label>
            <label>
              {{ 'printers.fields.copies' | transloco }}
              <select (change)="setCopies(row, $event)">
                @for (count of copyChoices; track count) {
                  <option [value]="count" [selected]="count === row.copies">{{ count }}</option>
                }
              </select>
            </label>
          </article>
        }
      </div>
    </section>
  `,
})
export class PrintersPage {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly transloco = inject(TranslocoService);
  readonly context = inject(CompanyContextStore);
  readonly lang = inject(ActiveLang);
  readonly field = fieldValue;
  readonly copyChoices = ['1', '2', '3', '4', '5'] as const;

  readonly companyId = signal('');
  readonly locations = signal<LocationRow[]>([]);
  readonly printers = signal<PrinterRow[]>([]);
  readonly mappings = signal<MappingDraft[]>([]);
  readonly discoverLocation = signal('');
  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly busy = signal(false);
  private generation = 0;

  constructor() {
    const companyId$ = this.route.parent?.paramMap ?? of(emptyParams());
    companyId$.pipe(takeUntilDestroyed()).subscribe((params) => {
      this.open(params.get('companyId') ?? '');
    });
  }

  open(companyId: string): void {
    this.companyId.set(companyId);
    if (companyId.length === 0) {
      this.loading.set(false);
      return;
    }
    this.load();
  }

  locationName(id: string): string {
    return this.locations().find((location) => location.id === id)?.name ?? '';
  }

  documentLabel(documentType: string): string {
    return `printers.documents.${documentType}`;
  }

  mappingTitle(row: MappingDraft): string {
    const place = this.locationName(row.locationId);
    const document = this.transloco.translate(this.documentLabel(row.documentType));
    return place.length > 0 ? `${place} · ${document}` : document;
  }

  printersAt(locationId: string): PrinterRow[] {
    return this.printers().filter((printer) => printer.locationId === locationId);
  }

  mappingCanSave(row: MappingDraft): boolean {
    if (this.busy() || row.printerId.length === 0 || row.paperSize.length === 0) {
      return false;
    }
    const saved = this.savedMappings.find(
      (mapping) => mapping.locationId === row.locationId && mapping.documentType === row.documentType,
    );
    if (!saved) {
      return true;
    }
    return saved.printerId !== row.printerId || saved.paperSize !== row.paperSize || copyLabel(saved.copies) !== row.copies;
  }

  paperSizes(row: MappingDraft): string[] {
    const printer = this.printers().find((item) => item.id === row.printerId);
    return printer?.paperSizes ?? [];
  }

  setPrinter(row: MappingDraft, event: Event): void {
    const printerId = fieldValue(event);
    const printer = this.printers().find((item) => item.id === printerId);
    const paperSize = printer?.paperSizes.includes(row.paperSize) ? row.paperSize : (printer?.paperSizes[0] ?? '');
    this.patch(row, { printerId, paperSize });
  }

  setPaper(row: MappingDraft, event: Event): void {
    this.patch(row, { paperSize: fieldValue(event) });
  }

  setCopies(row: MappingDraft, event: Event): void {
    this.patch(row, { copies: fieldValue(event) });
  }

  discover(): void {
    if (!this.begin()) {
      return;
    }
    const locationId = this.discoverLocation();
    const body = locationId.length > 0 ? { locationId } : {};
    this.http.post(`/api/c/${this.companyId()}/printers/discover`, body).subscribe({
      next: () => {
        this.busy.set(false);
        this.load();
      },
      error: () => {
        this.busy.set(false);
      },
    });
  }

  saveMapping(row: MappingDraft): void {
    const copies = COPY_COUNTS[row.copies];
    if (copies === undefined || row.printerId.length === 0 || row.paperSize.length === 0 || !this.begin()) {
      return;
    }
    this.http
      .put(`/api/c/${this.companyId()}/printer-mappings`, {
        locationId: row.locationId,
        documentType: row.documentType,
        printerId: row.printerId,
        paperSize: row.paperSize,
        copies,
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.load();
        },
        error: () => {
          this.busy.set(false);
        },
      });
  }

  private load(): void {
    const companyId = this.companyId();
    const generation = ++this.generation;
    this.loading.set(true);
    this.loadError.set(false);
    this.http
      .get<{ printers: PrinterRow[] }>(`/api/c/${companyId}/printers`, {
        context: new HttpContext().set(NAVIGATE_ON_DENIED, true),
      })
      .subscribe({
        next: (body) => {
          if (generation !== this.generation) {
            return;
          }
          this.printers.set(body.printers);
          this.loading.set(false);
        },
        error: () => {
          if (generation !== this.generation) {
            return;
          }
          this.loading.set(false);
          this.loadError.set(true);
        },
      });
    this.http.get<{ locations: LocationRow[] }>(`/api/c/${companyId}/locations`).subscribe({
      next: (body) => {
        if (generation !== this.generation) {
          return;
        }
        this.locations.set(body.locations);
        this.mergeMappings(this.savedMappings);
      },
      error: () => undefined,
    });
    this.http.get<{ mappings: MappingRow[] }>(`/api/c/${companyId}/printer-mappings`).subscribe({
      next: (body) => {
        if (generation !== this.generation) {
          return;
        }
        const previous = this.savedMappings;
        this.savedMappings = body.mappings;
        this.mergeMappings(previous);
      },
      error: () => undefined,
    });
  }

  private savedMappings: MappingRow[] = [];

  private mergeMappings(previous: MappingRow[]): void {
    if (this.locations().length === 0) {
      return;
    }
    const current = this.mappings();
    const drafts: MappingDraft[] = [];
    for (const location of this.locations()) {
      for (const documentType of DOCUMENT_TYPES) {
        const saved = this.savedMappings.find(
          (mapping) => mapping.locationId === location.id && mapping.documentType === documentType,
        );
        const existing = current.find(
          (row) => row.locationId === location.id && row.documentType === documentType,
        );
        const prior = previous.find(
          (mapping) => mapping.locationId === location.id && mapping.documentType === documentType,
        );
        if (existing && mappingDirty(existing, prior)) {
          drafts.push(existing);
          continue;
        }
        drafts.push({
          locationId: location.id,
          documentType,
          printerId: saved?.printerId ?? '',
          paperSize: saved?.paperSize ?? '',
          copies: saved ? copyLabel(saved.copies) : '1',
        });
      }
    }
    this.mappings.set(drafts);
  }

  private patch(row: MappingDraft, patch: Partial<MappingDraft>): void {
    this.mappings.update((rows) =>
      rows.map((item) =>
        item.locationId === row.locationId && item.documentType === row.documentType ? { ...item, ...patch } : item,
      ),
    );
  }

  private begin(): boolean {
    if (this.busy()) {
      return false;
    }
    this.busy.set(true);
    return true;
  }
}

function mappingDirty(row: MappingDraft, saved: MappingRow | undefined): boolean {
  if (!saved) {
    return row.printerId.length > 0 || row.paperSize.length > 0 || row.copies !== '1';
  }
  return row.printerId !== saved.printerId || row.paperSize !== saved.paperSize || row.copies !== copyLabel(saved.copies);
}

function copyLabel(copies: number): string {
  if (copies === 1 || copies === 2 || copies === 3 || copies === 4 || copies === 5) {
    return String(copies);
  }
  return '1';
}

function emptyParams(): { get: (name: string) => string | null } {
  return { get: () => null };
}
