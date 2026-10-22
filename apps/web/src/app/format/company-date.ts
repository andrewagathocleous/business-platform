export const DEFAULT_COMPANY_TIME_ZONE = 'Asia/Nicosia';

/**
 * Company business time in `Asia/Nicosia` by default.
 * English and Greek both use day/month/year: the product is for Cyprus.
 * The clock is 24-hour and keeps the offset suffix.
 */
export function formatCompanyDate(
  value: string | Date,
  timeZone: string = DEFAULT_COMPANY_TIME_ZONE,
  locale: 'en' | 'el' = 'en',
): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const formatter = new Intl.DateTimeFormat(locale === 'el' ? 'el' : 'en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  });
  const parts = formatter.formatToParts(date);
  const year = part(parts, 'year');
  const month = part(parts, 'month');
  const day = part(parts, 'day');
  const hour = part(parts, 'hour');
  const minute = part(parts, 'minute');
  const zone = part(parts, 'timeZoneName');
  if (!year || !month || !day || !hour || !minute) {
    return '';
  }
  const clock = `${hour}:${minute}${zone ? ` ${zone}` : ''}`;
  return `${day}/${month}/${year} ${clock}`;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((item) => item.type === type)?.value ?? '';
}

/** UTC instant of YYYY-MM-DD 00:00:00 in the company timezone. */
export function companyDayStart(businessDate: string, timeZone: string = DEFAULT_COMPANY_TIME_ZONE): Date {
  const parts = calendarParts(businessDate);
  const utcMidnight = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
  const adjusted = utcMidnight - zoneOffsetMs(new Date(utcMidnight), timeZone);
  return new Date(adjusted - (zoneOffsetMs(new Date(adjusted), timeZone) - zoneOffsetMs(new Date(utcMidnight), timeZone)));
}

/** Start of the next calendar day in the company timezone. The selected day is excluded at this instant. */
export function companyDayEndExclusive(businessDate: string, timeZone: string = DEFAULT_COMPANY_TIME_ZONE): Date {
  return companyDayStart(nextCalendarDate(businessDate), timeZone);
}

function nextCalendarDate(businessDate: string): string {
  const parts = calendarParts(businessDate);
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const year = utc.getUTCFullYear().toString().padStart(4, '0');
  const month = (utc.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = utc.getUTCDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function calendarParts(businessDate: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
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
  return wallClock(instant, timeZone) - instant.getTime();
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
    const value = parts.find((item) => item.type === type)?.value;
    if (!value) {
      throw new Error(`could not read ${type} in ${timeZone}`);
    }
    return Number(value);
  };
  const hour = read('hour') === 24 ? 0 : read('hour');
  return Date.UTC(read('year'), read('month') - 1, read('day'), hour, read('minute'), read('second'));
}
