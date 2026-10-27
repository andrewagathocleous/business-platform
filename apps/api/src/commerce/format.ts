import { AmountError, parseAmount } from '@bp/domain';
import { CommerceError } from './errors';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function fixed(value: { toFixed(digits: number): string }, digits: number): string {
  return value.toFixed(digits);
}

export function formatDateOnly(value: Date | null): string | null {
  if (!value) {
    return null;
  }
  const year = value.getUTCFullYear().toString().padStart(4, '0');
  const month = (value.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = value.getUTCDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseDateOnly(value: string, field: string): Date {
  const match = DATE.exec(value);
  if (!match) {
    throw new CommerceError(400, 'invalid_date', field, null, `${field} must be YYYY-MM-DD`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new CommerceError(400, 'invalid_date', field, null, `${field} must be YYYY-MM-DD`);
  }
  return date;
}

/** Money and quantity fields. JSON numbers are rejected by parseAmount. */
export function decimalField(value: unknown, scale: number, field: string): string {
  try {
    return parseAmount(value, scale).toFixed(scale);
  } catch (error) {
    if (error instanceof AmountError) {
      throw new CommerceError(400, error.reason, field, null, error.message);
    }
    throw error;
  }
}
