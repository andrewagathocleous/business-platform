import { HttpErrorResponse } from '@angular/common/http';
import { readApiError } from '../core/api-error';

type Figure = { amount: string; basis: string };
type CountedFigure = Figure & { count: number };
type TaxAmounts = { net: string; tax: string; gross: string; basis: string };
type TaxSets = { invoiced: TaxAmounts; credited: TaxAmounts; totals: TaxAmounts };
type CollectionSets = { payments: CountedFigure; refunds: CountedFigure; total: Figure };
export type AgeingBucket = 'current' | 'days1To30' | 'days31To60' | 'days61To90' | 'over90';
type AgeingTotals = {
  buckets: Record<AgeingBucket, Figure>;
  openTotal: Figure;
  creditTotal: Figure;
};

// API response shapes. All amounts stay decimal strings, including totals.
export type InvoicedReport = {
  from: string;
  to: string;
  currencies: (TaxSets & {
    currency: string;
    invoiced: TaxAmounts & { count: number };
    credited: TaxAmounts & { count: number };
    taxCodes: (TaxSets & { taxCodeId: string; code: string; name: string })[];
  })[];
};
export type CollectedReport = {
  from: string;
  to: string;
  currencies: (CollectionSets & {
    currency: string;
    methods: (CollectionSets & { method: string })[];
  })[];
};
export type AgeingReport = {
  asOf: string;
  currencies: (AgeingTotals & {
    currency: string;
    clients: (AgeingTotals & {
      clientId: string;
      clientName: string;
      invoices: {
        id: string;
        number: string | null;
        issueDate: string;
        dueDate: string;
        bucket: AgeingBucket;
        openBalance: Figure;
      }[];
      credits: { id: string; type: 'payment' | 'credit_note'; date: string; remaining: Figure }[];
    })[];
  })[];
};
export type Failure = { key: string; correlationId: string | null };

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function periodProblem(from: string, to: string): string | null {
  if (!validDate(from) || !validDate(to)) return 'reports.errors.date';
  if (from > to) return 'reports.errors.order';
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  return days > 366 ? 'reports.errors.period' : null;
}

export function asOfProblem(asOf: string, today: string): string | null {
  if (!validDate(asOf)) return 'reports.errors.date';
  return asOf > today ? 'reports.errors.future' : null;
}

export function reportFailure(error: unknown, ageing = false): Failure {
  const body = error instanceof HttpErrorResponse ? readApiError(error) : null;
  let key = 'reports.errors.failed';
  if (body?.code === 'invalid_date') key = ageing ? 'reports.errors.asOf' : 'reports.errors.dates';
  else if (body?.code === 'export_too_large') key = 'reports.errors.tooLarge';
  else if (body?.code === 'file_integrity_failed') key = 'reports.errors.integrity';
  else if (body?.code === 'mfa_required') key = 'reports.errors.mfa';
  else if (error instanceof HttpErrorResponse && error.status === 403)
    key = 'reports.errors.permission';
  else if (error instanceof HttpErrorResponse && error.status === 401)
    key = 'reports.errors.session';
  return {
    key,
    correlationId:
      body?.correlationId ??
      (error instanceof HttpErrorResponse ? error.headers.get('X-Correlation-Id') : null),
  };
}

/** HttpClient keeps JSON refusals as Blobs when a ZIP was requested. */
export async function exportFailure(error: unknown): Promise<Failure> {
  if (error instanceof HttpErrorResponse && error.error instanceof Blob) {
    try {
      const body: unknown = JSON.parse(await error.error.text());
      return reportFailure(
        new HttpErrorResponse({ error: body, status: error.status, headers: error.headers }),
      );
    } catch {
      // An unreadable error still carries the status and possibly a correlation header.
    }
  }
  return reportFailure(error);
}

export function exportFileName(disposition: string | null, from: string, to: string): string {
  return downloadFileName(disposition, `accountant-export-${from}-${to}.zip`);
}

export function downloadFileName(disposition: string | null, fallback: string): string {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? '')?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      /* Use the ordinary filename below. */
    }
  }
  return (
    /filename="([^"]+)"/i.exec(disposition ?? '')?.[1] ??
    /filename=([^;\s]+)/i.exec(disposition ?? '')?.[1] ??
    fallback
  );
}

export function saveExport(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Let the browser start the download before releasing its URL.
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  }
}
