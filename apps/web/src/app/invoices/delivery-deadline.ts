/** Days before the delivery deadline when the screen starts to warn. */
export const DEADLINE_SOON_DAYS = 5;

/** `none`: delivered or no deadline. `soon`: within {@link DEADLINE_SOON_DAYS}. */
export type DeadlineState = 'none' | 'ok' | 'soon' | 'overdue';

/** Today's YYYY-MM-DD in the company's timezone. */
export function companyToday(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/**
 * How an issued document stands against its delivery deadline (Cyprus VAT reg. 11(5), 11(6)).
 * A late delivery is warned about, never refused.
 */
export function deadlineState(
  deadline: string | null,
  delivered: boolean,
  today: string,
): DeadlineState {
  if (delivered || !deadline) {
    return 'none';
  }
  if (deadline < today) {
    return 'overdue';
  }
  return daysBetween(today, deadline) <= DEADLINE_SOON_DAYS ? 'soon' : 'ok';
}

function daysBetween(from: string, to: string): number {
  return Math.round((utcDay(to) - utcDay(from)) / 86_400_000);
}

function utcDay(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
}
