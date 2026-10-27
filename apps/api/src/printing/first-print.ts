/**
 * Statuses that do not occupy `print_job_one_first_print_key`
 * (`is_reprint = false AND status NOT IN ('failed', 'cancelled', 'not_printed')`).
 */
export const FIRST_PRINT_RELEASED_STATUSES = ['failed', 'cancelled', 'not_printed'] as const;

export function blocksFirstPrint(status: string, isReprint: boolean): boolean {
  return !isReprint && !(FIRST_PRINT_RELEASED_STATUSES as readonly string[]).includes(status);
}
