/**
 * An IANA timezone name. Fixed offsets, blanks and untrimmed text are rejected.
 * `Intl` on its own accepts offsets such as `+03:00`.
 */
export function isIanaTimeZone(value: string): boolean {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    value.startsWith('+') ||
    value.startsWith('-')
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
