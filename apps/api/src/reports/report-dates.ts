import { UnprocessableEntityException } from '@nestjs/common';
import { formatDateOnly } from '../commerce/format';

export function invalidDate(message: string): never {
  throw new UnprocessableEntityException({ code: 'invalid_date', message });
}

export function reportDate(value: unknown, field: string): { date: Date; day: string } {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000'))
    return invalidDate(`${field} must be a business date YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || formatDateOnly(date) !== value)
    return invalidDate(`${field} must be a business date YYYY-MM-DD`);
  return { date, day: value };
}

export function reportPeriod(from: unknown, to: unknown) {
  const start = reportDate(from, 'from');
  const end = reportDate(to, 'to');
  const days = (end.date.getTime() - start.date.getTime()) / 86_400_000 + 1;
  if (days < 1 || days > 366)
    return invalidDate('from must be on or before to, at most 366 days inclusive');
  return { start, end };
}
