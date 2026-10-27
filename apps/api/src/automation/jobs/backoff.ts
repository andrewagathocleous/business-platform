const BASE_MS = 1_000;
const CAP_MS = 15 * 60 * 1_000;

/** 1s, 2s, 4s, … capped at 15 minutes. `attempts` is the count already used, starting at 1. */
export function backoffMs(attempts: number): number {
  const used = Math.max(1, Math.floor(attempts));
  const exponent = Math.min(used - 1, 20);
  return Math.min(BASE_MS * 2 ** exponent, CAP_MS);
}
