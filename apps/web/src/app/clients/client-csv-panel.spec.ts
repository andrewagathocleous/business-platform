import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyContextStore } from '../core/company-context.store';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { ClientCsvPanel } from './client-csv-panel';
import type { ClientImport } from './client-csv-view';

const id = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const base = '/api/c/company-1/clients';
const content = 'kind,display_name,notes\r\nperson,Νέος δοκιμαστικός,"  First\nSecond  "\r\n';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-29T10:00:00Z'));
  // jsdom's Blob lacks text(); browser HttpClient responses have it.
  const OriginalBlob = Blob;
  vi.stubGlobal(
    'Blob',
    class extends OriginalBlob {
      override text(): Promise<string> {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            resolve(typeof reader.result === 'string' ? reader.result : '');
          };
          reader.onerror = () => {
            reject(new Error('Blob read failed'));
          };
          reader.readAsText(this);
        });
      }
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ClientCsvPanel', () => {
  it.each([
    ['attachment; filename="clients-2026-10-29.csv"', 'clients-2026-10-29.csv'],
    ["attachment; filename*=UTF-8''%CE%94%CE%BF%CE%BA%CE%B9%CE%BC%CE%AE.csv", 'Δοκιμή.csv'],
    [null, 'clients.csv'],
  ])(
    'downloads a Blob using the server filename %s and releases its URL',
    async (disposition, name) => {
      const { fixture, component, http } = await setup();
      const create = vi.fn<() => string>().mockReturnValue('blob:csv-test');
      const revoke = vi.fn();
      const OriginalURL = URL;
      vi.stubGlobal(
        'URL',
        class extends OriginalURL {
          static override createObjectURL = create;
          static override revokeObjectURL = revoke;
        },
      );
      let saved: { name: string; href: string; anchor: HTMLAnchorElement } | undefined;
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        saved = { name: this.download, href: this.href, anchor: this };
      });
      const blob = new Blob(['\uFEFFkind,display_name\r\n'], { type: 'text/csv' });
      expect(text(fixture)).toContain('customer data');
      component.download();
      fixture.detectChanges();
      expect(
        root(fixture).querySelector<HTMLButtonElement>('[data-testid=client-csv-export] button')
          ?.disabled,
      ).toBe(true);
      component.download();
      const request = http.expectOne(`${base}/export.csv`);
      expect(request.request.method).toBe('GET');
      expect(request.request.responseType).toBe('blob');
      request.flush(blob, { headers: disposition ? { 'Content-Disposition': disposition } : {} });
      expect(create).toHaveBeenCalledWith(blob);
      expect(saved?.name).toBe(name);
      expect(saved?.href).toBe('blob:csv-test');
      expect(saved?.anchor.isConnected).toBe(false);
      await vi.waitFor(() => {
        expect(revoke).toHaveBeenCalledWith('blob:csv-test');
      });
      expect(component.exporting()).toBe(false);
      http.verify();
    },
  );

  it.each([
    ['export_too_large', 422, '20,000 clients or 64 MB'],
    ['not_found', 404, 'The client export is no longer available. Reload the page and try again.'],
    ['forbidden', 403, 'do not have permission'],
    ['mfa_required', 403, 'Sign out from the account menu'],
    ['unauthorized', 401, 'Sign in again'],
    ['internal_error', 500, 'could not be completed'],
  ])(
    'explains export Blob refusal %s and retains its correlation id',
    async (code, status, message) => {
      const { fixture, component, http } = await setup();
      component.download();
      http
        .expectOne(`${base}/export.csv`)
        .flush(new Blob([JSON.stringify({ error: { code, correlationId: 'csv-corr' } })]), {
          status,
          statusText: 'Refused',
        });
      await vi.waitFor(() => {
        expect(component.exporting()).toBe(false);
      });
      fixture.detectChanges();
      expect(text(fixture)).toContain(message);
      expect(text(fixture)).toContain('csv-corr');
      expect(text(fixture)).not.toContain('This import preview was not found');
      expect(text(fixture)).not.toContain('Choose the CSV file again');
      http.verify();
    },
  );

  it('handles an unreadable export error and an empty download with the correlation header', async () => {
    const { fixture, component, http } = await setup();
    component.download();
    http.expectOne(`${base}/export.csv`).flush(new Blob(['bad JSON']), {
      status: 502,
      statusText: 'Failed',
      headers: { 'X-Correlation-Id': 'header-corr' },
    });
    await vi.waitFor(() => {
      expect(component.exporting()).toBe(false);
    });
    fixture.detectChanges();
    expect(text(fixture)).toContain('could not be completed');
    expect(text(fixture)).toContain('header-corr');
    component.download();
    http
      .expectOne(`${base}/export.csv`)
      .flush(null, { headers: { 'X-Correlation-Id': 'empty-corr' } });
    expect(component.exportError()?.correlationId).toBe('empty-corr');
    http.verify();
  });

  it('refuses files above 4 MiB before reading and refuses other extensions', async () => {
    const { fixture, component, http } = await setup();
    const read = vi.spyOn(FileReader.prototype, 'readAsText');
    selectFile(fixture, new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'large.csv'));
    expect(read).not.toHaveBeenCalled();
    fixture.detectChanges();
    expect(text(fixture)).toContain('exceeds 4 MB');
    expect(component.importing()).toBe(false);
    selectFile(fixture, new File(['text'], 'clients.txt'));
    expect(component.importError()?.key).toBe('clients.csv.errors.file_type');
    expect(read).not.toHaveBeenCalled();
    http.verify();
  });

  it('reads UTF-8 without rewriting customer text, renders classifications and confirms once by hash', async () => {
    const { fixture, component, http } = await setup();
    const changed = vi.fn();
    const imported = vi.fn();
    component.importIdChange.subscribe(changed);
    component.imported.subscribe(imported);
    const read = vi.spyOn(FileReader.prototype, 'readAsText');
    selectFile(fixture, new File([content], 'clients.csv', { type: 'text/csv' }));
    const request = await vi.waitFor(() => http.expectOne(`${base}/imports`));
    expect(read).toHaveBeenCalledWith(expect.any(File), 'UTF-8');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ fileName: 'clients.csv', content });
    expect(root(fixture).querySelector<HTMLInputElement>('input[type=file]')?.value).toBe('');
    request.flush({ import: preview() });
    fixture.detectChanges();
    expect(text(fixture)).toContain('New: 1 · Duplicate: 1 · Error: 1');
    const rows = root(fixture).querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('Error');
    expect(rows[0]?.textContent).toContain('email (invalid_email): email: invalid_email');
    expect(rows[1]?.textContent).toContain('Duplicate');
    expect(rows[1]?.textContent).toContain('Matches client fictional-client-id');
    expect(rows[1]?.textContent).toContain('Matches row 2');
    expect(rows[2]?.textContent).toContain('<img src=x onerror=alert(1)>Νέος');
    expect(root(fixture).querySelector('img')).toBeNull();
    expect(changed).toHaveBeenLastCalledWith(id);
    // The route echoes the id after upload; do not reload or replace that preview.
    fixture.componentRef.setInput('importId', id);
    fixture.detectChanges();
    http.expectNone(`${base}/imports/${id}`);
    component.confirm();
    fixture.detectChanges();
    const confirm = http.expectOne(`${base}/imports/${id}/confirm`);
    expect(confirm.request.method).toBe('POST');
    expect(confirm.request.body).toEqual({ expectedSha256: 'a'.repeat(64) });
    expect(
      Array.from(root(fixture).querySelectorAll('button')).find((button) =>
        button.textContent.includes('Import 1 new clients'),
      )?.disabled,
    ).toBe(true);
    component.confirm();
    http.expectNone(`${base}/imports/${id}/confirm`);
    confirm.flush({ appliedCount: 1, counts: { new: 1, duplicate: 1, error: 1 } });
    component.confirm();
    fixture.detectChanges();
    expect(text(fixture)).toContain('Created 1 clients.');
    expect(root(fixture).querySelector('[data-testid=client-csv-preview]')).toBeNull();
    expect(changed).toHaveBeenLastCalledWith('');
    expect(imported).toHaveBeenCalledOnce();
    http.verify();
  });

  it('uses the created count returned after confirm rechecks duplicates', async () => {
    const { fixture, component, http } = await setup(id);
    http.expectOne(`${base}/imports/${id}`).flush({ import: preview() });
    component.confirm();
    http
      .expectOne(`${base}/imports/${id}/confirm`)
      .flush({ appliedCount: 0, counts: { new: 0, duplicate: 2, error: 1 } });
    fixture.detectChanges();
    expect(text(fixture)).toContain('Created 0 clients.');
    http.verify();
  });

  it('restores by URL id, pages 5,000 rows with issues first, and does not confirm when no rows are new', async () => {
    const { fixture, component, http } = await setup(id);
    const data = preview();
    data.rows = Array.from({ length: 4998 }, (_, index) => ({
      number: index + 2,
      status: 'new',
      values: { display_name: `Fictional ${String(index)}`, notes: '' },
      messages: [],
    }));
    data.rows.push({
      number: 5000,
      status: 'duplicate',
      values: { display_name: 'Duplicate', notes: '' },
      messages: [{ field: 'email', code: 'duplicate', message: 'Matches row 2' }],
    });
    data.rows.push({
      number: 5001,
      status: 'error',
      values: { display_name: 'Error', notes: '' },
      messages: [],
    });
    data.counts = { new: 4998, duplicate: 1, error: 1 };
    data.rowCount = 5000;
    http.expectOne(`${base}/imports/${id}`).flush({ import: data });
    fixture.detectChanges();
    expect(component.visibleRows()).toHaveLength(50);
    expect(root(fixture).querySelectorAll('tbody tr')).toHaveLength(50);
    expect(
      component
        .visibleRows()
        .slice(0, 3)
        .map((row) => row.number),
    ).toEqual([5001, 5000, 2]);
    expect(text(fixture)).toContain('Page 1 of 100');
    button(fixture, 'Next rows').click();
    fixture.detectChanges();
    expect(component.visibleRows()[0]?.number).toBe(50);
    button(fixture, 'Previous rows').click();
    expect(component.page()).toBe(0);
    fixture.componentRef.setInput('importId', secondId);
    fixture.detectChanges();
    http.expectOne(`${base}/imports/${secondId}`).flush({
      import: { ...preview(), id: secondId, counts: { new: 0, duplicate: 2, error: 1 } },
    });
    fixture.detectChanges();
    expect(button(fixture, 'Import 0 new clients').disabled).toBe(true);
    component.confirm();
    http.verify();
  });

  it.each([
    ['preview_expired', 409, 'expired after 24 hours'],
    ['preview_changed', 409, 'file hash no longer matches'],
    ['already_applied', 409, 'already been imported'],
    ['too_many_rows', 422, 'more than 5,000 data rows'],
    ['preview_too_large', 422, 'preview exceeds 16 MB'],
    ['invalid_csv', 422, 'Check quoting, row column counts'],
    ['header_required', 422, 'needs a header row'],
    ['unknown_columns', 422, 'unknown column names'],
    ['duplicate_columns', 422, 'repeats a column name'],
    ['missing_columns', 422, 'must include both kind and display_name'],
    ['invalid_body', 400, 'file name of 1–255 characters'],
    ['not_found', 404, 'not found in this company'],
    ['payload_too_large', 413, 'exceeds 4 MB'],
    ['version_conflict', 409, 'Reload it and review it'],
    ['forbidden', 403, 'do not have permission'],
    ['mfa_required', 403, 'Sign out from the account menu'],
    ['unauthorized', 401, 'Sign in again'],
    ['internal_error', 500, 'could not be completed'],
  ])('explains import refusal %s with a correlation id', async (code, status, message) => {
    const { fixture, component, http } = await setup(id);
    http
      .expectOne(`${base}/imports/${id}`)
      .flush({ error: { code, correlationId: 'import-corr' } }, { status, statusText: 'Refused' });
    await vi.waitFor(() => {
      expect(component.importing()).toBe(false);
    });
    fixture.detectChanges();
    expect(text(fixture)).toContain(message);
    expect(text(fixture)).toContain('import-corr');
    http.verify();
  });

  it.each(['restore', 'confirm'])(
    'explains the API missing-preview response on %s and asks for the file again',
    async (operation) => {
      const { fixture, component, http } = await setup(id);
      const restore = http.expectOne(`${base}/imports/${id}`);
      if (operation === 'confirm') {
        restore.flush({ import: preview() });
        component.confirm();
      }
      const request =
        operation === 'restore' ? restore : http.expectOne(`${base}/imports/${id}/confirm`);
      request.flush(
        {
          error: { code: 'not_found', message: 'Not found', correlationId: 'missing-preview-corr' },
        },
        { status: 404, statusText: 'Not Found' },
      );
      await vi.waitFor(() => {
        expect(component.importing()).toBe(false);
      });
      fixture.detectChanges();
      expect(text(fixture)).toContain(
        'This import preview was not found in this company. Choose the CSV file again.',
      );
      expect(text(fixture)).toContain('missing-preview-corr');
      expect(text(fixture)).not.toContain('The client export is no longer available');
      if (operation === 'restore') {
        expect(root(fixture).querySelector('[data-testid=client-csv-preview]')).toBeNull();
        component.confirm();
        http.expectNone(`${base}/imports/${id}/confirm`);
      }
      http.verify();
    },
  );

  it.each(['restore', 'upload'])(
    'blocks a preview older than 24 hours on %s even when its status is previewed',
    async (source) => {
      vi.mocked(Date.now).mockReturnValue(Date.parse('2026-10-30T09:00:00.001Z'));
      const { fixture, component, http } = await setup(source === 'restore' ? id : '');
      if (source === 'restore') {
        http.expectOne(`${base}/imports/${id}`).flush({ import: preview() });
      } else {
        selectFile(fixture, new File([content], 'clients.csv'));
        (await vi.waitFor(() => http.expectOne(`${base}/imports`))).flush({ import: preview() });
      }
      fixture.detectChanges();
      expect(text(fixture)).toContain(
        'This preview has expired after 24 hours. Choose the CSV file again to create a fresh preview.',
      );
      expect(button(fixture, 'Import 1 new clients').disabled).toBe(true);
      component.confirm();
      fixture.detectChanges();
      expect(button(fixture, 'Import 1 new clients').disabled).toBe(true);
      expect(component.created()).toBeNull();
      http.expectNone(`${base}/imports/${id}/confirm`);
      http.verify();
    },
  );

  it('checks the clock again on confirm when an open preview becomes older than 24 hours', async () => {
    const { fixture, component, http } = await setup(id);
    http.expectOne(`${base}/imports/${id}`).flush({ import: preview() });
    fixture.detectChanges();
    expect(button(fixture, 'Import 1 new clients').disabled).toBe(false);
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-10-30T09:00:00.001Z'));
    button(fixture, 'Import 1 new clients').click();
    fixture.detectChanges();
    expect(text(fixture)).toContain('expired after 24 hours');
    expect(text(fixture)).toContain('Choose the CSV file again');
    expect(button(fixture, 'Import 1 new clients').disabled).toBe(true);
    component.confirm();
    http.expectNone(`${base}/imports/${id}/confirm`);
    http.verify();
  });

  it('allows confirm at exactly 24 hours, matching the API boundary', async () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-10-30T09:00:00.000Z'));
    const { fixture, component, http } = await setup(id);
    http.expectOne(`${base}/imports/${id}`).flush({ import: preview() });
    fixture.detectChanges();
    expect(button(fixture, 'Import 1 new clients').disabled).toBe(false);
    button(fixture, 'Import 1 new clients').click();
    http
      .expectOne(`${base}/imports/${id}/confirm`)
      .flush({ appliedCount: 1, counts: { new: 1, duplicate: 1, error: 1 } });
    expect(component.created()).toBe(1);
    http.verify();
  });

  it.each(['preview_expired', 'preview_changed', 'already_applied'])(
    'explains a confirm refusal %s and keeps confirmation blocked',
    async (code) => {
      const { fixture, component, http } = await setup(id);
      http.expectOne(`${base}/imports/${id}`).flush({ import: preview() });
      component.confirm();
      http
        .expectOne(`${base}/imports/${id}/confirm`)
        .flush(
          { error: { code, correlationId: 'confirm-corr' } },
          { status: 409, statusText: 'Refused' },
        );
      await vi.waitFor(() => {
        expect(component.importing()).toBe(false);
      });
      fixture.detectChanges();
      expect(component.importError()?.key).toBe(`clients.csv.errors.${code}`);
      expect(button(fixture, 'Import 1 new clients').disabled).toBe(true);
      component.confirm();
      fixture.detectChanges();
      expect(button(fixture, 'Import 1 new clients').disabled).toBe(true);
      expect(component.importError()?.key).toBe(`clients.csv.errors.${code}`);
      expect(text(fixture)).toContain('confirm-corr');
      expect(component.created()).toBeNull();
      http.expectNone(`${base}/imports/${id}/confirm`);
      http.verify();
    },
  );

  it.each(['applied', 'expired'] as const)('restores %s previews as read only', async (status) => {
    const { fixture, component, http } = await setup(id);
    http
      .expectOne(`${base}/imports/${id}`)
      .flush({ import: { ...preview(), status, appliedCount: status === 'applied' ? 1 : null } });
    fixture.detectChanges();
    expect(button(fixture, 'Import 1 new clients').disabled).toBe(true);
    component.confirm();
    expect(component.importError()?.key).toBe(
      `clients.csv.errors.${status === 'applied' ? 'already_applied' : 'preview_expired'}`,
    );
    http.expectNone(`${base}/imports/${id}/confirm`);
    http.verify();
  });

  it('allows a fresh upload after a terminal confirm refusal', async () => {
    const { fixture, component, http } = await setup(id);
    http.expectOne(`${base}/imports/${id}`).flush({ import: preview() });
    component.confirm();
    http
      .expectOne(`${base}/imports/${id}/confirm`)
      .flush({ error: { code: 'preview_changed' } }, { status: 409, statusText: 'Refused' });
    await vi.waitFor(() => {
      expect(component.importing()).toBe(false);
    });
    selectFile(fixture, new File([content], 'fresh-clients.csv'));
    (await vi.waitFor(() => http.expectOne(`${base}/imports`))).flush({
      import: { ...preview(), id: secondId },
    });
    fixture.detectChanges();
    expect(component.importError()).toBeNull();
    expect(button(fixture, 'Import 1 new clients').disabled).toBe(false);
    component.confirm();
    http
      .expectOne(`${base}/imports/${secondId}/confirm`)
      .flush({ appliedCount: 1, counts: { new: 1, duplicate: 1, error: 1 } });
    expect(component.created()).toBe(1);
    http.verify();
  });

  it('has no CSV controls or requests without the matching permissions, including on restore', async () => {
    const { fixture, component, http } = await setup(id, false);
    expect(root(fixture).querySelector('button')).toBeNull();
    expect(root(fixture).querySelector('input')).toBeNull();
    component.download();
    component.confirm();
    http.verify();
    const context = TestBed.inject(CompanyContextStore);
    context.grants.set([{ permission: 'client.export', scopeType: 'company', scopeId: null }]);
    fixture.detectChanges();
    expect(root(fixture).querySelector('[data-testid=client-csv-export]')).not.toBeNull();
    expect(root(fixture).querySelector('[data-testid=client-csv-import]')).toBeNull();
    context.grants.set([{ permission: 'client.import', scopeType: 'company', scopeId: null }]);
    fixture.detectChanges();
    expect(root(fixture).querySelector('[data-testid=client-csv-export]')).toBeNull();
    expect(root(fixture).querySelector('[data-testid=client-csv-import]')).not.toBeNull();
    http.expectOne(`${base}/imports/${id}`).flush({ import: preview() });
    http.verify();
  });

  it('offers both withheld MFA actions and explains their permission refusal with the existing step-up guidance', async () => {
    const { fixture, component, http } = await setup('', false);
    const context = TestBed.inject(CompanyContextStore);
    context.mfaStepUpRequired.set(true);
    context.withheldPermissions.set(['client.export', 'client.import']);
    fixture.detectChanges();
    expect(text(fixture)).toContain('Sign out from the account menu');
    component.download();
    http
      .expectOne(`${base}/export.csv`)
      .flush(new Blob([JSON.stringify({ error: { code: 'forbidden' } })]), {
        status: 403,
        statusText: 'Forbidden',
      });
    selectFile(fixture, new File([content], 'clients.csv'));
    (await vi.waitFor(() => http.expectOne(`${base}/imports`))).flush(
      { error: { code: 'forbidden' } },
      { status: 403, statusText: 'Forbidden' },
    );
    await vi.waitFor(() => {
      expect(component.exportError()?.key).toBe('clients.csv.errors.mfa');
      expect(component.importError()?.key).toBe('clients.csv.errors.mfa');
    });
    http.verify();
  });

  it('cancels superseded restores and page requests and ignores a late Blob error', async () => {
    const { fixture, component, http } = await setup(id);
    const old = http.expectOne(`${base}/imports/${id}`);
    fixture.componentRef.setInput('importId', secondId);
    fixture.detectChanges();
    expect(old.cancelled).toBe(true);
    const current = http.expectOne(`${base}/imports/${secondId}`);
    current.flush({ import: { ...preview(), id: secondId } });
    const blob = new Blob(['error']);
    let finish: ((value: string) => void) | undefined;
    vi.spyOn(blob, 'text').mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    component.download();
    http.expectOne(`${base}/export.csv`).flush(blob, { status: 500, statusText: 'Failed' });
    fixture.componentRef.setInput('companyId', 'company-2');
    fixture.componentRef.setInput('importId', '');
    fixture.detectChanges();
    finish?.(JSON.stringify({ error: { code: 'export_too_large' } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(component.exportError()).toBeNull();
    expect(component.preview()).toBeNull();
    component.download();
    const download = http.expectOne('/api/c/company-2/clients/export.csv');
    selectFile(fixture, new File([content], 'clients.csv'));
    const upload = await vi.waitFor(() => http.expectOne('/api/c/company-2/clients/imports'));
    fixture.destroy();
    expect(download.cancelled).toBe(true);
    expect(upload.cancelled).toBe(true);
    http.verify();
  });

  it('aborts a file read when the page closes', async () => {
    const { fixture, http } = await setup();
    vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader) {
      Object.defineProperty(this, 'readyState', { value: FileReader.LOADING });
    });
    const abort = vi.spyOn(FileReader.prototype, 'abort');
    selectFile(fixture, new File([content], 'clients.csv'));
    fixture.destroy();
    expect(abort).toHaveBeenCalledOnce();
    http.verify();
  });
});

async function setup(importId = '', allowed = true) {
  await TestBed.configureTestingModule({
    imports: [ClientCsvPanel],
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTransloco({
        config: { availableLangs: ['en', 'el'], defaultLang: 'en', prodMode: true },
        loader: AppTranslocoLoader,
      }),
    ],
  }).compileComponents();
  const transloco = TestBed.inject(TranslocoService);
  await firstValueFrom(transloco.load('en'));
  transloco.setActiveLang('en');
  TestBed.inject(CompanyContextStore).grants.set(
    allowed
      ? ['client.import', 'client.export'].map((permission) => ({
          permission,
          scopeType: 'company',
          scopeId: null,
        }))
      : [
          { permission: 'client.manage', scopeType: 'company', scopeId: null },
          { permission: 'client.view', scopeType: 'company', scopeId: null },
          { permission: 'invoice.export', scopeType: 'company', scopeId: null },
        ],
  );
  const fixture = TestBed.createComponent(ClientCsvPanel);
  fixture.componentRef.setInput('companyId', 'company-1');
  fixture.componentRef.setInput('importId', importId);
  fixture.detectChanges();
  return {
    fixture,
    component: fixture.componentInstance,
    http: TestBed.inject(HttpTestingController),
  };
}
function preview(): ClientImport {
  return {
    id,
    status: 'previewed',
    fileName: 'clients.csv',
    sha256: 'a'.repeat(64),
    rowCount: 3,
    counts: { new: 1, duplicate: 1, error: 1 },
    rows: [
      {
        number: 2,
        status: 'new',
        values: { display_name: '<img src=x onerror=alert(1)>Νέος', notes: '  First\nSecond  ' },
        messages: [],
      },
      {
        number: 3,
        status: 'duplicate',
        values: { display_name: 'Fictional duplicate', notes: '' },
        messages: [
          {
            field: 'display_name',
            code: 'duplicate',
            message: 'Matches client fictional-client-id',
          },
          { field: 'email', code: 'duplicate', message: 'Matches row 2' },
        ],
      },
      {
        number: 4,
        status: 'error',
        values: { display_name: 'Fictional error', notes: '' },
        messages: [{ field: 'email', code: 'invalid_email', message: 'email: invalid_email' }],
      },
    ],
    createdAt: '2026-10-29T09:00:00Z',
    appliedAt: null,
    appliedCount: null,
  };
}
function selectFile(fixture: ComponentFixture<unknown>, file: File): void {
  const input = root(fixture).querySelector<HTMLInputElement>('input[type=file]');
  if (!input) throw new Error('no file input');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
}
function root(fixture: ComponentFixture<unknown>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('no root');
  return element;
}
function text(fixture: ComponentFixture<unknown>): string {
  return root(fixture).textContent.replace(/\s+/g, ' ');
}
function button(fixture: ComponentFixture<unknown>, label: string): HTMLButtonElement {
  const result = Array.from(root(fixture).querySelectorAll('button')).find(
    (item) => item.textContent.trim() === label,
  );
  if (!result) throw new Error(`no button: ${label}`);
  return result;
}
