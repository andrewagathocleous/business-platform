/** Follow-up delay for `print.refresh_status`: `min(2s × 2^n, 300s)`. */
export function refreshDelayMs(refresh: number): number {
  const n = Number.isInteger(refresh) && refresh > 0 ? Math.min(refresh, 20) : 0;
  return Math.min(2_000 * 2 ** n, 300_000);
}

export function refreshDelaySeconds(refresh: number): number {
  return refreshDelayMs(refresh) / 1000;
}
