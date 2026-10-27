import { HttpErrorResponse } from '@angular/common/http';

export type ApiErrorBody = {
  message: string;
  correlationId: string | null;
  code: string | null;
};

export function readApiError(error: HttpErrorResponse): ApiErrorBody {
  const body: unknown = error.error;
  if (!isRecord(body)) {
    return { message: error.message, correlationId: null, code: null };
  }
  const nested = body['error'];
  if (!isRecord(nested)) {
    return { message: error.message, correlationId: null, code: null };
  }
  const message = typeof nested['message'] === 'string' ? nested['message'] : error.message;
  const correlationId = typeof nested['correlationId'] === 'string' ? nested['correlationId'] : null;
  const code = typeof nested['code'] === 'string' ? nested['code'] : null;
  return { message, correlationId, code };
}

export function isVersionConflict(error: unknown): boolean {
  if (!(error instanceof HttpErrorResponse) || error.status !== 409) {
    return false;
  }
  const body = readApiError(error);
  return body.message === 'version_conflict' || body.code === 'version_conflict';
}

export function isAlreadyPrinted(error: unknown): boolean {
  if (!(error instanceof HttpErrorResponse) || error.status !== 409) {
    return false;
  }
  return readApiError(error).code === 'already_printed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
