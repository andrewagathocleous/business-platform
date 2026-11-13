import { HttpErrorResponse } from '@angular/common/http';
import { isVersionConflict, readApiError } from '../core/api-error';
import type { Failure } from '../reports/report-view';

// Client CSV API shapes; customer text stays exactly as returned by the server.
export type ImportCounts = { new: number; duplicate: number; error: number };
export type ImportRow = {
  number: number;
  status: 'new' | 'duplicate' | 'error';
  values: { display_name: string; notes: string };
  messages: { field: string; code: string; message: string }[];
};
export type ClientImport = {
  id: string;
  status: 'previewed' | 'applied' | 'expired';
  fileName: string;
  sha256: string;
  rowCount: number;
  counts: ImportCounts;
  rows: ImportRow[];
  createdAt: string;
  appliedAt: string | null;
  appliedCount: number | null;
};

const refusals = new Set([
  'export_too_large',
  'preview_expired',
  'preview_changed',
  'already_applied',
  'too_many_rows',
  'preview_too_large',
  'invalid_csv',
  'header_required',
  'unknown_columns',
  'duplicate_columns',
  'missing_columns',
  'invalid_body',
]);

export async function csvFailure(
  error: unknown,
  stepUp: boolean,
  operation: 'export' | 'import',
): Promise<Failure> {
  // Blob downloads retain JSON errors as Blobs, just like the accountant export.
  if (error instanceof HttpErrorResponse && error.error instanceof Blob) {
    try {
      const body: unknown = JSON.parse(await error.error.text());
      error = new HttpErrorResponse({ error: body, status: error.status, headers: error.headers });
    } catch {
      // Keep the HTTP status and correlation header if the body is unreadable.
    }
  }
  const body = error instanceof HttpErrorResponse ? readApiError(error) : null;
  let code = 'failed';
  if (body?.code && refusals.has(body.code)) code = body.code;
  else if (isVersionConflict(error)) code = 'version_conflict';
  else if (body?.code === 'mfa_required') code = 'mfa';
  else if (error instanceof HttpErrorResponse) {
    if (error.status === 404)
      code = operation === 'export' ? 'export_not_found' : 'import_not_found';
    else if (error.status === 413) code = 'file_too_large';
    else if (error.status === 403) code = stepUp ? 'mfa' : 'permission';
    else if (error.status === 401) code = 'session';
  }
  return {
    key: `clients.csv.errors.${code}`,
    correlationId:
      body?.correlationId ??
      (error instanceof HttpErrorResponse ? error.headers.get('X-Correlation-Id') : null),
  };
}
