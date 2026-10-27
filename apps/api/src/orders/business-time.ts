import { addDaysToBusinessDate, businessDateInZone } from '@bp/domain';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EARLIEST_BUSINESS_DATE = '2000-01-01';
const LATEST_BUSINESS_DATE = '2999-12-31';

/** UTC instant of YYYY-MM-DD 00:00:00 in an IANA timezone. */
export function startOfBusinessDate(businessDate: string, timeZone: string): Date {
  const parts = calendarParts(businessDate);
  const utcMidnight = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
  const adjusted = utcMidnight - zoneOffsetMs(new Date(utcMidnight), timeZone);
  const instant = new Date(adjusted - (zoneOffsetMs(new Date(adjusted), timeZone) - zoneOffsetMs(new Date(utcMidnight), timeZone)));
  if (businessDateInZone(instant, timeZone) !== businessDate || localTime(instant, timeZone) !== '00:00:00') {
    throw new Error(`could not resolve ${businessDate} in ${timeZone}`);
  }
  return instant;
}

/**
 * Inclusive business-date bounds. `to` covers that whole local date, so the stored
 * upper bound is the start of the next business date.
 */
export function businessDateBounds(
  from: string | undefined,
  to: string | undefined,
  timeZone: string,
): { from?: Date; to?: Date } {
  return {
    ...(from ? { from: startOfBusinessDate(from, timeZone) } : {}),
    ...(to ? { to: startOfBusinessDate(addDaysToBusinessDate(to, 1), timeZone) } : {}),
  };
}

export function isBusinessDate(value: string): boolean {
  try {
    calendarParts(value);
    return true;
  } catch {
    return false;
  }
}

/** Real calendar dates the order list will turn into instants without overflowing. */
export function isSupportedBusinessDate(value: string): boolean {
  return isBusinessDate(value) && value >= EARLIEST_BUSINESS_DATE && value <= LATEST_BUSINESS_DATE;
}

function calendarParts(businessDate: string): { year: number; month: number; day: number } {
  const match = DATE.exec(businessDate);
  if (!match) {
    throw new Error('business date must be YYYY-MM-DD');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new Error('business date is not a real calendar date');
  }
  return { year, month, day };
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  return wall - instant.getTime();
}

function localTime(instant: Date, timeZone: string): string {
  const wall = new Date(wallClock(instant, timeZone));
  const hour = wall.getUTCHours().toString().padStart(2, '0');
  const minute = wall.getUTCMinutes().toString().padStart(2, '0');
  const second = wall.getUTCSeconds().toString().padStart(2, '0');
  return `${hour}:${minute}:${second}`;
}

function wallClock(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) {
      throw new Error(`could not read ${type} in ${timeZone}`);
    }
    return Number(value);
  };
  const hour = read('hour') === 24 ? 0 : read('hour');
  return Date.UTC(read('year'), read('month') - 1, read('day'), hour, read('minute'), read('second'));
}
