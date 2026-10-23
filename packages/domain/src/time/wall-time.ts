const WALL = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

type WallParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/** Hours around the naive UTC reading. Wide enough to see both sides of a DST change. */
const SAMPLE_HOURS = [-48, -36, -24, -18, -12, -6, -3, -2, -1, 0, 1, 2, 3, 6, 12, 18, 24, 36, 48];

/**
 * Shop-local `YYYY-MM-DD HH:mm:ss` in an IANA zone, as a UTC instant.
 * Uses `Intl` only. An ambiguous wall time (the hour that repeats when DST ends)
 * takes the earlier instant. A skipped wall time (the hour that does not exist
 * when DST starts) moves forward to the first valid instant.
 */
export function wallTimeInZoneToInstant(wall: string, timeZone: string): Date {
  const wanted = parseWall(wall);
  const read = zonedReader(timeZone);
  const wantedMs = partsToEpoch(wanted);
  const offsets = new Set<number>();
  for (const hours of SAMPLE_HOURS) {
    offsets.add(offsetAt(wantedMs + hours * 3_600_000, read));
  }

  const matches: number[] = [];
  const before: number[] = [];
  const after: { instant: number; offset: number }[] = [];
  for (const offset of offsets) {
    const instant = wantedMs - offset;
    const order = compareParts(read(new Date(instant)), wanted);
    if (order === 0) {
      matches.push(instant);
      continue;
    }
    if (order < 0) {
      before.push(instant);
      continue;
    }
    after.push({ instant, offset: offsetAt(instant, read) });
  }

  if (matches.length > 0) {
    return new Date(earliest(matches));
  }

  const start = latest(before);
  const end = earliestAfter(after);
  if (start === null || end === null) {
    throw new Error('wall time is not a valid instant');
  }
  return new Date(firstOffsetChange(start, end.instant, end.offset, read));
}

function parseWall(wall: string): WallParts {
  const match = WALL.exec(wall);
  if (match === null) {
    throw new Error('wall time must be YYYY-MM-DD HH:mm:ss');
  }
  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  const hourText = match[4];
  const minuteText = match[5];
  const secondText = match[6];
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined ||
    hourText === undefined ||
    minuteText === undefined ||
    secondText === undefined
  ) {
    throw new Error('wall time must be YYYY-MM-DD HH:mm:ss');
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    throw new Error('wall time must be YYYY-MM-DD HH:mm:ss');
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error('wall time is not a real calendar date');
  }
  return { year, month, day, hour, minute, second };
}

/**
 * UTC instant as shop-local `YYYY-MM-DD HH:mm:ss` in an IANA zone.
 * The inverse of `wallTimeInZoneToInstant` for an unambiguous wall time.
 * During a repeated hour the two instants format as the same wall time.
 */
export function instantToWallTimeInZone(instant: Date, timeZone: string): string {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new Error('instant is not a valid date');
  }
  const parts = zonedReader(timeZone)(instant);
  return (
    `${String(parts.year).padStart(4, '0')}-` +
    `${String(parts.month).padStart(2, '0')}-` +
    `${String(parts.day).padStart(2, '0')} ` +
    `${String(parts.hour).padStart(2, '0')}:` +
    `${String(parts.minute).padStart(2, '0')}:` +
    String(parts.second).padStart(2, '0')
  );
}

function zonedReader(timeZone: string): (instant: Date) => WallParts {
  if (timeZone.length === 0) {
    throw new Error('time zone is invalid');
  }
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    format.format(0);
  } catch {
    throw new Error('time zone is invalid');
  }
  return (instant) => readParts(format, instant);
}

function readParts(format: Intl.DateTimeFormat, instant: Date): WallParts {
  const parts = format.formatToParts(instant);
  let year = numberPart(parts, 'year');
  let month = numberPart(parts, 'month');
  let day = numberPart(parts, 'day');
  let hour = numberPart(parts, 'hour');
  const minute = numberPart(parts, 'minute');
  const second = numberPart(parts, 'second');
  // A few engines report midnight as 24:00 on the day that just ended.
  if (hour === 24) {
    hour = 0;
    const rolled = new Date(Date.UTC(year, month - 1, day + 1));
    year = rolled.getUTCFullYear();
    month = rolled.getUTCMonth() + 1;
    day = rolled.getUTCDate();
  }
  return { year, month, day, hour, minute, second };
}

function numberPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const value = parts.find((part) => part.type === type)?.value;
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error('could not read a time zone');
  }
  return Number(value);
}

function offsetAt(instantMs: number, read: (instant: Date) => WallParts): number {
  // The civil offset is constant for a whole second. Truncating keeps the gap search monotonic.
  const second = Math.floor(instantMs / 1000) * 1000;
  return partsToEpoch(read(new Date(second))) - second;
}

function partsToEpoch(parts: WallParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function compareParts(left: WallParts, right: WallParts): number {
  return partsToEpoch(left) - partsToEpoch(right);
}

function earliest(values: readonly number[]): number {
  let best = values[0];
  if (best === undefined) {
    throw new Error('wall time is not a valid instant');
  }
  for (const value of values) {
    if (value < best) {
      best = value;
    }
  }
  return best;
}

function latest(values: readonly number[]): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (best === null || value > best) {
      best = value;
    }
  }
  return best;
}

function earliestAfter(
  values: readonly { instant: number; offset: number }[],
): { instant: number; offset: number } | null {
  let best: { instant: number; offset: number } | null = null;
  for (const value of values) {
    if (best === null || value.instant < best.instant) {
      best = value;
    }
  }
  return best;
}

/** First millisecond in (before, after] whose offset is the post-gap offset. */
function firstOffsetChange(
  before: number,
  after: number,
  afterOffset: number,
  read: (instant: Date) => WallParts,
): number {
  if (
    after <= before ||
    offsetAt(before, read) === afterOffset ||
    offsetAt(after, read) !== afterOffset
  ) {
    throw new Error('wall time is not a valid instant');
  }
  let lo = before;
  let hi = after;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetAt(mid, read) === afterOffset) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}
