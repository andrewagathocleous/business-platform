import { ParamMap, Params } from '@angular/router';

export function positiveInt(value: string | null, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    return fallback;
  }
  let result = 0;
  for (const char of value) {
    result = result * 10 + (char.charCodeAt(0) - 48);
    if (!Number.isSafeInteger(result) || result > max) {
      return fallback;
    }
  }
  return result > 0 ? result : fallback;
}

/** `0` is allowed. Anything else that is not a canonical integer falls back. */
export function nonNegativeInt(value: string | null, fallback: number, max: number): number {
  if (value === null) {
    return fallback;
  }
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    return fallback;
  }
  let result = 0;
  for (const char of value) {
    result = result * 10 + (char.charCodeAt(0) - 48);
    if (result > max) {
      return fallback;
    }
  }
  return result;
}

export function dateParam(value: string | null): string {
  return value !== null && isRealCalendarDate(value) ? value : '';
}

/** YYYY-MM-DD that is a real calendar day, not only the right shape. */
export function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

export function boundedText(value: string | null, max: number): string {
  if (value === null || value.length === 0 || value.length > max) {
    return '';
  }
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidParam(value: string | null): string {
  return value !== null && UUID.test(value) ? value.toLowerCase() : '';
}

export function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  if (value !== null && allowed.some((item) => item === value)) {
    return value as T;
  }
  return fallback;
}

export function isCanonical(params: ParamMap, canonical: Params): boolean {
  const keys = new Set<string>([...params.keys, ...Object.keys(canonical)]);
  for (const key of keys) {
    const actual = params.getAll(key);
    const expected = paramValues(canonical[key]);
    if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
      return false;
    }
  }
  return true;
}

function paramValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : ''));
  }
  if (typeof value === 'string') {
    return [value];
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  return [];
}
