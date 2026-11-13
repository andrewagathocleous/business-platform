import { HttpException } from '@nestjs/common';

/** A matching payment or refund. Notes, actors and anything else stay off this object. */
export type DuplicateDetails = {
  id: string;
  date: string;
  amount: string;
  reference: string | null;
  recordedAt: string;
};

export type ErrorBody = {
  error: {
    code: string;
    message: string;
    correlationId: string;
    printJobId?: string;
    /** Field codes a 422 names, for example `seller.vatNumber`. */
    fields?: string[];
    /** A gift card that does not fit stays refused. */
    fits?: boolean;
    /** Code points the card cannot draw, `U+XXXX` only. Capped; see `unsupportedCharsMore`. */
    unsupportedChars?: string[];
    /** Distinct code points left off `unsupportedChars` after the cap. */
    unsupportedCharsMore?: number;
    /** How many characters will be left off the card. The exact count, with no upper cap. */
    omittedCount?: number;
    details?: DuplicateDetails;
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

export function errorBody(
  exception: unknown,
  correlationId: string,
): { status: number; body: ErrorBody } {
  const status = statusOf(exception);
  const printJobId = explicitPrintJobId(exception);
  const fields = explicitFields(exception, status);
  const details = explicitDuplicateDetails(exception);
  const giftReview = explicitGiftReview(exception);
  return {
    status,
    body: {
      error: {
        code: explicitCode(exception) ?? STATUS_CODES[status] ?? `http_${String(status)}`,
        message: publicMessage(exception, status),
        correlationId,
        ...(printJobId ? { printJobId } : {}),
        ...(fields ? { fields } : {}),
        ...(giftReview ?? {}),
        ...(details ? { details } : {}),
      },
    },
  };
}

const FIELD_CODE = /^[a-zA-Z][a-zA-Z0-9_.]{0,79}$/;
const CODE_POINT = /^U\+[0-9A-F]{4,6}$/;
/** Distinct code points named on a gift-card 422. The rest are counted, not dropped. */
const MAX_UNSUPPORTED_CHARS = 500;

/**
 * A gift-card 422 may name the code points that will be left off, whether the
 * card fits, and how many characters are omitted. The omitted count is kept
 * in full. The code-point list is capped and the remainder is counted.
 * Anything else, including the message text, is dropped.
 */
function explicitGiftReview(exception: unknown):
  | {
      fits?: boolean;
      unsupportedChars?: string[];
      unsupportedCharsMore?: number;
      omittedCount?: number;
    }
  | undefined {
  if (!(exception instanceof HttpException)) {
    return undefined;
  }
  const response = exception.getResponse();
  if (!isRecord(response) || response.code !== 'gift_message_needs_review') {
    return undefined;
  }
  const review: {
    fits?: boolean;
    unsupportedChars?: string[];
    unsupportedCharsMore?: number;
    omittedCount?: number;
  } = {};
  if (typeof response.fits === 'boolean') {
    review.fits = response.fits;
  }
  if (Array.isArray(response.unsupportedChars)) {
    const chars: string[] = [];
    const seen = new Set<string>();
    for (const item of response.unsupportedChars) {
      if (typeof item !== 'string' || !CODE_POINT.test(item) || seen.has(item)) {
        continue;
      }
      seen.add(item);
      chars.push(item);
    }
    if (chars.length > 0) {
      const listed = chars.slice(0, MAX_UNSUPPORTED_CHARS);
      review.unsupportedChars = listed;
      const more = chars.length - listed.length;
      if (more > 0) {
        review.unsupportedCharsMore = more;
      }
    }
  }
  if (
    typeof response.omittedCount === 'number' &&
    Number.isSafeInteger(response.omittedCount) &&
    response.omittedCount >= 0
  ) {
    review.omittedCount = response.omittedCount;
  }
  return Object.keys(review).length > 0 ? review : undefined;
}

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
const DUPLICATE_ID = PRINT_JOB_ID;
const DUPLICATE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DUPLICATE_AMOUNT = /^\d{1,17}\.\d{2}$/;
const DUPLICATE_RECORDED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function explicitDuplicateDetails(exception: unknown): DuplicateDetails | undefined {
  if (!(exception instanceof HttpException)) {
    return undefined;
  }
  const response = exception.getResponse();
  if (
    !isRecord(response) ||
    response.code !== 'possible_duplicate' ||
    !isRecord(response.details)
  ) {
    return undefined;
  }
  const { id, date, amount, reference, recordedAt } = response.details;
  if (typeof id !== 'string' || !DUPLICATE_ID.test(id)) {
    return undefined;
  }
  if (typeof date !== 'string' || !DUPLICATE_DATE.test(date)) {
    return undefined;
  }
  if (typeof amount !== 'string' || !DUPLICATE_AMOUNT.test(amount)) {
    return undefined;
  }
  if (reference !== null && (typeof reference !== 'string' || reference.length > 200)) {
    return undefined;
  }
  if (typeof recordedAt !== 'string' || !DUPLICATE_RECORDED_AT.test(recordedAt)) {
    return undefined;
  }
  return { id, date, amount, reference, recordedAt };
}

function explicitPrintJobId(exception: unknown): string | undefined {
  if (!(exception instanceof HttpException)) {
    return undefined;
  }
  const response = exception.getResponse();
  if (
    !isRecord(response) ||
    response.code !== 'already_printed' ||
    typeof response.printJobId !== 'string'
  ) {
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
        const messages = response.message.filter(
          (item): item is string => typeof item === 'string',
        );
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
