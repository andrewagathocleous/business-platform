const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar date YYYY-MM-DD for an instant in an IANA timezone. */
export function businessDateInZone(instant: Date, timeZone: string): string {
  if (Number.isNaN(instant.getTime())) {
    throw new Error('instant is not a valid date');
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) {
    throw new Error(`could not format a business date in ${timeZone}`);
  }
  return `${year}-${month}-${day}`;
}

/** Adds calendar days to a YYYY-MM-DD business date. The addition is not timezone-aware. */
export function addDaysToBusinessDate(businessDate: string, days: number): string {
  const match = DATE.exec(businessDate);
  if (!match) {
    throw new Error('business date must be YYYY-MM-DD');
  }
  if (!Number.isInteger(days)) {
    throw new Error('days must be an integer');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new Error('business date is not a real calendar date');
  }
  utc.setUTCDate(utc.getUTCDate() + days);
  const nextYear = utc.getUTCFullYear().toString().padStart(4, '0');
  const nextMonth = (utc.getUTCMonth() + 1).toString().padStart(2, '0');
  const nextDay = utc.getUTCDate().toString().padStart(2, '0');
  return `${nextYear}-${nextMonth}-${nextDay}`;
}
