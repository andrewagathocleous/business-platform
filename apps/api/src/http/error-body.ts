import { HttpException } from '@nestjs/common';

export type ErrorBody = {
  error: {
    code: string;
    message: string;
    correlationId: string;
    printJobId?: string;
    /** Field codes a 422 names, for example `seller.vatNumber`. */
    fields?: string[];
  };
};

const STATUS_CODES: Readonly<Record<number, string>> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  429: 'too_many_requests',
  500: 'internal_error',
};

export function errorBody(exception: unknown, correlationId: string): { status: number; body: ErrorBody } {
  const status = statusOf(exception);
  const printJobId = explicitPrintJobId(exception);
  const fields = explicitFields(exception, status);
  return {
    status,
    body: {
      error: {
        code: explicitCode(exception) ?? STATUS_CODES[status] ?? `http_${String(status)}`,
        message: publicMessage(exception, status),
        correlationId,
        ...(printJobId ? { printJobId } : {}),
        ...(fields ? { fields } : {}),
      },
    },
  };
}

const FIELD_CODE = /^[a-zA-Z][a-zA-Z0-9_.]{0,79}$/;

/** A 422 may name the fields that failed. Only short, plain field codes pass through. */
function explicitFields(exception: unknown, status: number): string[] | undefined {
  if (status !== 422 || !(exception instanceof HttpException)) {
    return undefined;
  }
  const response = exception.getResponse();
  if (!isRecord(response) || !Array.isArray(response.fields)) {
    return undefined;
  }
  const fields = response.fields.filter(
    (field): field is string => typeof field === 'string' && FIELD_CODE.test(field),
  );
  return fields.length > 0 ? fields.slice(0, 100) : undefined;
}

/** Domain guards put a stable code on the exception body, for example `payment_not_settled`. */
function explicitCode(exception: unknown): string | undefined {
  if (!(exception instanceof HttpException)) {
    return undefined;
  }
  const response = exception.getResponse();
  if (!isRecord(response) || typeof response.code !== 'string') {
    return undefined;
  }
  if (!/^[a-z][a-z0-9_]*$/.test(response.code)) {
    return undefined;
  }
  return response.code;
}

const PRINT_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function explicitPrintJobId(exception: unknown): string | undefined {
  if (!(exception instanceof HttpException)) {
    return undefined;
  }
  const response = exception.getResponse();
  if (!isRecord(response) || response.code !== 'already_printed' || typeof response.printJobId !== 'string') {
    return undefined;
  }
  if (!PRINT_JOB_ID.test(response.printJobId)) {
    return undefined;
  }
  return response.printJobId;
}

function statusOf(exception: unknown): number {
  if (exception instanceof HttpException) {
    return exception.getStatus();
  }
  if (isRecord(exception)) {
    if (typeof exception.status === 'number') {
      return exception.status;
    }
    if (typeof exception.statusCode === 'number') {
      return exception.statusCode;
    }
  }
  return 500;
}

function publicMessage(exception: unknown, status: number): string {
  if (status >= 500) {
    return 'Internal server error';
  }
  if (status === 413) {
    return 'Request body is too large';
  }
  if (exception instanceof HttpException) {
    const response = exception.getResponse();
    if (typeof response === 'string' && response.length > 0) {
      return response;
    }
    if (isRecord(response)) {
      if (typeof response.message === 'string' && response.message.length > 0) {
        return response.message;
      }
      if (Array.isArray(response.message)) {
        const messages = response.message.filter((item): item is string => typeof item === 'string');
        if (messages.length > 0) {
          return messages.join(', ');
        }
      }
    }
  }
  if (status === 404) {
    return 'Not found';
  }
  return 'Request failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
