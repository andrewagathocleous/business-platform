import { HttpException } from '@nestjs/common';

export type ErrorBody = {
  error: {
    code: string;
    message: string;
    correlationId: string;
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
  return {
    status,
    body: {
      error: {
        code: STATUS_CODES[status] ?? `http_${String(status)}`,
        message: publicMessage(exception, status),
        correlationId,
      },
    },
  };
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
