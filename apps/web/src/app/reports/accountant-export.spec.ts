import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyContextStore } from '../core/company-context.store';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { AccountantExport } from './accountant-export';

beforeEach(() => {
  // jsdom's Blob lacks the standard text() method used by HttpClient consumers.
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AccountantExport', () => {
  it.each([
    ['attachment; filename="download.zip"', 'download.zip'],
    ["attachment; filename*=UTF-8''%CE%94%CE%BF%CE%BA%CE%B9%CE%BC%CE%AE.zip", 'Δοκιμή.zip'],
    [null, 'accountant-export-2026-10-01-2026-10-29.zip'],
  ])(
    'downloads a Blob with disposition %s, saves it and revokes its URL',
    async (disposition, name) => {
      const { fixture, component, http } = await setup();
      const create = vi.fn<() => string>().mockReturnValue('blob:export-test');
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
      const blob = new Blob(['PK demo ZIP'], { type: 'application/zip' });
      expect(component.pdfs()).toBe(false);
      expect(text(fixture)).toContain('customer and financial data');
      component.download();
      fixture.detectChanges();
      const request = http.expectOne((req) => req.url === '/api/c/company-1/exports/accountant');
      expect(request.request.method).toBe('GET');
      expect(request.request.responseType).toBe('blob');
      expect(request.request.params.get('from')).toBe('2026-10-01');
      expect(request.request.params.get('to')).toBe('2026-10-29');
      expect(request.request.params.get('pdfs')).toBe('false');
      expect(root(fixture).querySelector('button')?.disabled).toBe(true);
      component.download();
      http.expectNone((req) => req.url.endsWith('/exports/accountant'));
      request.flush(blob, { headers: disposition ? { 'Content-Disposition': disposition } : {} });
      expect(create).toHaveBeenCalledWith(blob);
      expect(saved?.name).toBe(name);
      expect(saved?.href).toBe('blob:export-test');
      expect(saved?.anchor.isConnected).toBe(false);
      await vi.waitFor(() => {
        expect(revoke).toHaveBeenCalledWith('blob:export-test');
      });
      expect(component.busy()).toBe(false);
      fixture.detectChanges();
      expect(root(fixture).querySelector('button')?.disabled).toBe(false);
      http.verify();
    },
  );

  it('sends PDFs only when selected, with the chosen dates', async () => {
    const { component, http } = await setup();
    component.pdfs.set(true);
    component.from.set('2026-09-01');
    component.to.set('2026-09-30');
    component.download();
    const request = http.expectOne((req) => req.url.endsWith('/exports/accountant'));
    expect(request.request.params.get('pdfs')).toBe('true');
    expect(request.request.params.get('from')).toBe('2026-09-01');
    expect(request.request.params.get('to')).toBe('2026-09-30');
    request.error(new ProgressEvent('error'));
    await vi.waitFor(() => {
      expect(component.busy()).toBe(false);
    });
    http.verify();
  });

  it.each([
    ['invalid_date', 422, 'at most 366 days'],
    ['export_too_large', 422, 'shorter period or download without PDFs'],
    ['file_integrity_failed', 409, 'stored PDF failed its integrity check'],
    ['mfa_required', 403, 'Sign out from the account menu'],
    ['forbidden', 403, 'do not have permission'],
    ['unauthorized', 401, 'Sign in again'],
    ['internal_error', 500, 'could not be completed'],
  ])('maps error Blob %s and keeps its correlation id', async (code, status, message) => {
    const { fixture, component, http } = await setup();
    component.download();
    http
      .expectOne((req) => req.url.endsWith('/exports/accountant'))
      .flush(
        new Blob([JSON.stringify({ error: { code, correlationId: 'corr-export' } })], {
          type: 'application/json',
        }),
        { status, statusText: 'Refused' },
      );
    await vi.waitFor(() => {
      expect(component.busy()).toBe(false);
    });
    fixture.detectChanges();
    expect(text(fixture)).toContain(message);
    expect(text(fixture)).toContain('corr-export');
    http.verify();
  });

  it('maps an unreadable error generically and uses the correlation header', async () => {
    const { fixture, component, http } = await setup();
    component.download();
    http
      .expectOne((req) => req.url.endsWith('/exports/accountant'))
      .flush(new Blob(['not JSON']), {
        status: 502,
        statusText: 'Failed',
        headers: { 'X-Correlation-Id': 'corr-header' },
      });
    await vi.waitFor(() => {
      expect(component.busy()).toBe(false);
    });
    fixture.detectChanges();
    expect(text(fixture)).toContain('could not be completed');
    expect(text(fixture)).toContain('corr-header');
    http.verify();
  });

  it('has no export panel or request without invoice.export, and offers the withheld MFA path', async () => {
    const { fixture, component, http } = await setup(false);
    expect(root(fixture).querySelector('[data-testid=accountant-export]')).toBeNull();
    component.download();
    http.verify();
    const context = TestBed.inject(CompanyContextStore);
    context.mfaStepUpRequired.set(true);
    context.withheldPermissions.set(['invoice.export']);
    fixture.detectChanges();
    expect(text(fixture)).toContain('Accountant export');
    expect(text(fixture)).toContain('Sign out from the account menu');
    component.download();
    http
      .expectOne((req) => req.url.endsWith('/exports/accountant'))
      .flush(
        new Blob([JSON.stringify({ error: { code: 'forbidden', correlationId: 'corr-mfa' } })]),
        { status: 403, statusText: 'Forbidden' },
      );
    await vi.waitFor(() => {
      expect(component.busy()).toBe(false);
    });
    expect(component.failure()?.key).toBe('reports.errors.mfa');
    http.verify();
  });

  it.each([
    ['2026-10-29', '2026-10-01', 'reports.errors.order'],
    ['2025-10-01', '2026-10-29', 'reports.errors.period'],
    ['', '2026-10-29', 'reports.errors.date'],
  ])('refuses invalid export dates before requesting', async (from, to, key) => {
    const { component, http } = await setup();
    component.from.set(from);
    component.to.set(to);
    component.download();
    expect(component.failure()?.key).toBe(key);
    http.verify();
  });

  it('does not save an old company download and cancels a request when closed', async () => {
    const { fixture, component, http } = await setup();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    component.download();
    const old = http.expectOne((req) => req.url.endsWith('/exports/accountant'));
    fixture.componentRef.setInput('companyId', 'company-2');
    fixture.detectChanges();
    old.flush(new Blob(['PK old']));
    expect(click).not.toHaveBeenCalled();
    component.download();
    const pending = http.expectOne((req) => req.url === '/api/c/company-2/exports/accountant');
    fixture.destroy();
    expect(pending.cancelled).toBe(true);
    http.verify();
  });

  it('does not apply a late Blob error after closing', async () => {
    const { fixture, component, http } = await setup();
    const blob = new Blob(['error']);
    let finish: ((value: string) => void) | undefined;
    vi.spyOn(blob, 'text').mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    component.download();
    http
      .expectOne((req) => req.url.endsWith('/exports/accountant'))
      .flush(blob, { status: 409, statusText: 'Refused' });
    fixture.destroy();
    finish?.(JSON.stringify({ error: { code: 'file_integrity_failed' } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(component.failure()).toBeNull();
    http.verify();
  });
});

async function setup(allowed = true) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T10:00:00Z'));
  await TestBed.configureTestingModule({
    imports: [AccountantExport],
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
    allowed ? [{ permission: 'invoice.export', scopeType: 'company', scopeId: null }] : [],
  );
  const fixture = TestBed.createComponent(AccountantExport);
  fixture.componentRef.setInput('companyId', 'company-1');
  fixture.detectChanges();
  return {
    fixture,
    component: fixture.componentInstance,
    http: TestBed.inject(HttpTestingController),
  };
}
function root(fixture: ComponentFixture<unknown>): HTMLElement {
  const value: unknown = fixture.nativeElement;
  if (!(value instanceof HTMLElement)) throw new Error('no root');
  return value;
}
function text(fixture: ComponentFixture<unknown>): string {
  return root(fixture).textContent.replace(/\s+/g, ' ');
}
