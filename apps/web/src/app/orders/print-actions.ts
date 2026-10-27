const POLL = new Set(['queued', 'submitting', 'submitted', 'delivered_to_printer']);
const CONFIRM_PRINTED = new Set(['submitted', 'delivered_to_printer', 'done_reported', 'uncertain']);
const NOT_PRINTED = new Set(['submitted', 'delivered_to_printer', 'done_reported', 'uncertain', 'failed']);
const CANCEL = new Set(['queued', 'held', 'uncertain']);
const MAY_STILL_PRINT = new Set([
  'queued',
  'held',
  'submitting',
  'submitted',
  'delivered_to_printer',
  'uncertain',
]);

export type PrintPermissions = {
  submit: boolean;
  reprint: boolean;
  confirm: boolean;
};

export type PrintActionState = {
  poll: boolean;
  print: boolean;
  confirmPrinted: boolean;
  notPrinted: boolean;
  cancel: boolean;
  reprint: boolean;
  warning: boolean;
  heldNote: boolean;
};

/**
 * Print follows `firstPrintAvailable` (the unique first-print index) and `print.submit`.
 * Reprint is offered for any existing job when the user has `print.reprint`.
 * Confirm and not-printed follow `print.confirm` and the statuses the print service accepts.
 * Cancel follows `print.submit` and the statuses the service accepts.
 */
export function printActions(
  status: string | null,
  firstPrintAvailable: boolean,
  permissions: PrintPermissions,
): PrintActionState {
  const hasJob = status !== null;
  return {
    poll: hasJob && POLL.has(status),
    print: firstPrintAvailable && permissions.submit,
    confirmPrinted: hasJob && permissions.confirm && CONFIRM_PRINTED.has(status),
    notPrinted: hasJob && permissions.confirm && NOT_PRINTED.has(status),
    cancel: hasJob && permissions.submit && CANCEL.has(status),
    reprint: hasJob && permissions.reprint,
    warning: hasJob && MAY_STILL_PRINT.has(status),
    heldNote: status === 'held',
  };
}
