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
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoPipe } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { Observable, Subject, switchMap, takeUntil } from 'rxjs';
import { CompanyContextStore } from '../core/company-context.store';
import { canAttempt } from '../core/nav';
import { downloadFileName, saveExport, type Failure } from '../reports/report-view';
import { csvFailure, type ClientImport, type ImportCounts } from './client-csv-view';

@Component({
  selector: 'bp-client-csv-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, Button],
  templateUrl: './client-csv-panel.html',
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .card {
      margin-bottom: 1rem;
    }
    .customer-text {
      white-space: pre-wrap;
      max-width: 24rem;
      overflow-wrap: anywhere;
    }
    .file-name {
      overflow-wrap: anywhere;
    }
  `,
})
export class ClientCsvPanel {
  private readonly http = inject(HttpClient);
  private readonly context = inject(CompanyContextStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly stopExport = new Subject<void>();
  private readonly stopImport = new Subject<void>();
  private exportSequence = 0;
  private importSequence = 0;
  private activeCompany = '';
  private activeImportId = '';
  private importAllowed = false;
  private exportAllowed = false;
  readonly companyId = input.required<string>();
  readonly importId = input('');
  readonly importIdChange = output<string>();
  readonly imported = output();
  readonly exporting = signal(false);
  readonly importing = signal(false);
  readonly exportError = signal<Failure | null>(null);
  readonly importError = signal<Failure | null>(null);
  readonly preview = signal<ClientImport | null>(null);
  readonly confirmBlocked = signal(false);
  readonly created = signal<number | null>(null);
  readonly page = signal(0);
  readonly pageSize = 50;
  readonly orderedRows = computed(() => {
    const priority = { error: 0, duplicate: 1, new: 2 };
    return [...(this.preview()?.rows ?? [])].sort(
      (a, b) => priority[a.status] - priority[b.status] || a.number - b.number,
    );
  });
  readonly visibleRows = computed(() =>
    this.orderedRows().slice(this.page() * this.pageSize, (this.page() + 1) * this.pageSize),
  );
  readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.orderedRows().length / this.pageSize)),
  );

  constructor() {
    effect(() => {
      const company = this.companyId();
      const id = this.importId();
      const importAllowed = this.can('client.import');
      const exportAllowed = this.can('client.export');
      const companyChanged = company !== this.activeCompany;
      if (companyChanged || (!exportAllowed && this.exportAllowed)) {
        this.activeCompany = company;
        this.activeImportId = '';
        this.exportSequence++;
        this.stopExport.next();
        this.exporting.set(false);
        this.exportError.set(null);
        this.resetImport();
      }
      this.exportAllowed = exportAllowed;
      if (id === this.activeImportId && importAllowed === this.importAllowed) return;
      this.importAllowed = importAllowed;
      this.resetImport();
      this.activeImportId = id;
      if (id && company && importAllowed) this.restore(id);
    });
  }

  can(permission: 'client.import' | 'client.export'): boolean {
    return canAttempt(
      this.context.grants(),
      this.context.withheldPermissions(),
      this.context.mfaStepUpRequired(),
      permission,
    );
  }
  stepUp(permission: 'client.import' | 'client.export'): boolean {
    return (
      this.context.mfaStepUpRequired() && this.context.withheldPermissions().includes(permission)
    );
  }

  download(): void {
    if (this.exporting() || !this.companyId() || !this.can('client.export')) return;
    const seq = ++this.exportSequence;
    this.exporting.set(true);
    this.exportError.set(null);
    this.http
      .get(`/api/c/${this.companyId()}/clients/export.csv`, {
        responseType: 'blob',
        observe: 'response',
      })
      .pipe(takeUntil(this.stopExport), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (seq !== this.exportSequence) return;
          this.exporting.set(false);
          if (response.body)
            saveExport(
              response.body,
              downloadFileName(response.headers.get('Content-Disposition'), 'clients.csv'),
            );
          else
            this.exportError.set({
              key: 'clients.csv.errors.failed',
              correlationId: response.headers.get('X-Correlation-Id'),
            });
        },
        error: (error: unknown) => {
          void this.refused(error, seq, 'export');
        },
      });
  }

  selectFile(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.importing() || !this.companyId() || !this.can('client.import')) return;
    this.resetImport();
    this.activeImportId = '';
    this.importIdChange.emit('');
    if (file.size > 4 * 1024 * 1024) {
      this.importError.set({ key: 'clients.csv.errors.file_too_large', correlationId: null });
      return;
    }
    if (!/\.csv$/i.test(file.name)) {
      this.importError.set({ key: 'clients.csv.errors.file_type', correlationId: null });
      return;
    }
    const seq = this.importSequence;
    const company = this.companyId();
    this.importing.set(true);
    readUtf8(file)
      .pipe(
        switchMap((content) =>
          this.http.post<{ import: ClientImport }>(`/api/c/${company}/clients/imports`, {
            fileName: file.name,
            content,
          }),
        ),
        takeUntil(this.stopImport),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (body) => {
          if (seq !== this.importSequence) return;
          this.showPreview(body.import);
          this.activeImportId = body.import.id;
          this.importIdChange.emit(body.import.id);
        },
        error: (error: unknown) => {
          void this.refused(error, seq, 'import');
        },
      });
  }

  confirm(): void {
    const preview = this.preview();
    if (this.importing() || !preview || !this.can('client.import')) return;
    this.checkPreview(preview);
    if (this.confirmBlocked() || preview.counts.new === 0) return;
    const seq = ++this.importSequence;
    this.importing.set(true);
    this.importError.set(null);
    this.http
      .post<{ appliedCount: number; counts: ImportCounts }>(
        `/api/c/${this.companyId()}/clients/imports/${preview.id}/confirm`,
        { expectedSha256: preview.sha256 },
      )
      .pipe(takeUntil(this.stopImport), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (body) => {
          if (seq !== this.importSequence) return;
          this.importing.set(false);
          this.created.set(body.appliedCount);
          this.preview.set(null);
          this.activeImportId = '';
          this.importIdChange.emit('');
          this.imported.emit();
        },
        error: (error: unknown) => {
          void this.refused(error, seq, 'import');
        },
      });
  }

  private restore(id: string): void {
    const seq = this.importSequence;
    this.importing.set(true);
    this.http
      .get<{ import: ClientImport }>(`/api/c/${this.companyId()}/clients/imports/${id}`)
      .pipe(takeUntil(this.stopImport), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (body) => {
          if (seq !== this.importSequence) return;
          this.showPreview(body.import);
        },
        error: (error: unknown) => {
          void this.refused(error, seq, 'import');
        },
      });
  }

  private showPreview(preview: ClientImport): void {
    this.preview.set(preview);
    this.importing.set(false);
    this.page.set(0);
    this.checkPreview(preview);
  }
  private checkPreview(preview: ClientImport): void {
    if (this.confirmBlocked()) return;
    if (
      preview.status !== 'previewed' ||
      Date.now() - Date.parse(preview.createdAt) > 24 * 60 * 60 * 1000
    ) {
      this.confirmBlocked.set(true);
      this.importError.set({
        key: `clients.csv.errors.${preview.status === 'applied' ? 'already_applied' : 'preview_expired'}`,
        correlationId: null,
      });
    }
  }
  private resetImport(): void {
    this.importSequence++;
    this.stopImport.next();
    this.importing.set(false);
    this.preview.set(null);
    this.confirmBlocked.set(false);
    this.importError.set(null);
    this.created.set(null);
    this.page.set(0);
  }
  private async refused(
    error: unknown,
    seq: number,
    operation: 'export' | 'import',
  ): Promise<void> {
    const failure = await csvFailure(
      error,
      this.stepUp(operation === 'export' ? 'client.export' : 'client.import'),
      operation,
    );
    if (
      this.destroyRef.destroyed ||
      seq !== (operation === 'export' ? this.exportSequence : this.importSequence)
    )
      return;
    if (operation === 'export') {
      this.exportError.set(failure);
      this.exporting.set(false);
    } else {
      if (
        ['preview_expired', 'preview_changed', 'already_applied'].some(
          (code) => failure.key === `clients.csv.errors.${code}`,
        )
      )
        this.confirmBlocked.set(true);
      this.importError.set(failure);
      this.importing.set(false);
    }
  }
}

/** FileReader accepts an explicit encoding and aborts when this page/request closes. */
function readUtf8(file: File): Observable<string> {
  return new Observable((subscriber) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        subscriber.next(reader.result);
        subscriber.complete();
      } else subscriber.error(new Error('CSV file read failed'));
    };
    reader.onerror = () => {
      subscriber.error(new Error('CSV file read failed'));
    };
    reader.readAsText(file, 'UTF-8');
    return () => {
      reader.onload = null;
      reader.onerror = null;
      if (reader.readyState === FileReader.LOADING) reader.abort();
    };
  });
}
