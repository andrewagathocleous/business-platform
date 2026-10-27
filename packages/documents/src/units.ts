/** Physical millimetres to PDF points. 1 in = 25.4 mm = 72 pt. */
export function millimetresToPoints(value: string): number {
  const parsed = decimalNumber(value);
  return (parsed * 72) / 25.4;
}

/** A non-negative decimal string, such as `148.00` or `1.200`. */
export function decimalNumber(value: string): number {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    throw new Error('expected a non-negative decimal string');
  }
  const whole = Number(match[1]);
  const fraction = match[2] ?? '';
  if (fraction.length === 0) {
    return whole;
  }
  return whole + Number(fraction) / 10 ** fraction.length;
}
