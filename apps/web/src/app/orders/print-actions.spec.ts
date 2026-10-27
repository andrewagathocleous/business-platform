import { describe, expect, it } from 'vitest';
import { printActions, type PrintPermissions } from './print-actions';

const STATUSES = [
  null,
  'queued',
  'held',
  'submitting',
  'submitted',
  'delivered_to_printer',
  'done_reported',
  'confirmed_printed',
  'not_printed',
  'failed',
  'uncertain',
  'cancelled',
] as const;

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
const POLL = new Set(['queued', 'submitting', 'submitted', 'delivered_to_printer']);

const PERMISSIONS: PrintPermissions[] = [
  { submit: false, reprint: false, confirm: false },
  { submit: true, reprint: false, confirm: false },
  { submit: false, reprint: true, confirm: false },
  { submit: false, reprint: false, confirm: true },
  { submit: true, reprint: true, confirm: false },
  { submit: true, reprint: false, confirm: true },
  { submit: false, reprint: true, confirm: true },
  { submit: true, reprint: true, confirm: true },
];

describe('printActions', () => {
  it('covers every status for each permission and first-print flag', () => {
    for (const status of STATUSES) {
      for (const firstPrintAvailable of [true, false]) {
        for (const permissions of PERMISSIONS) {
          const actions = printActions(status, firstPrintAvailable, permissions);
          const hasJob = status !== null;
          expect(actions.print, label(status, firstPrintAvailable, permissions, 'print')).toBe(
            firstPrintAvailable && permissions.submit,
          );
          expect(actions.reprint, label(status, firstPrintAvailable, permissions, 'reprint')).toBe(
            hasJob && permissions.reprint,
          );
          expect(actions.confirmPrinted, label(status, firstPrintAvailable, permissions, 'confirm')).toBe(
            hasJob && permissions.confirm && CONFIRM_PRINTED.has(status),
          );
          expect(actions.notPrinted, label(status, firstPrintAvailable, permissions, 'notPrinted')).toBe(
            hasJob && permissions.confirm && NOT_PRINTED.has(status),
          );
          expect(actions.cancel, label(status, firstPrintAvailable, permissions, 'cancel')).toBe(
            hasJob && permissions.submit && CANCEL.has(status),
          );
          expect(actions.warning, label(status, firstPrintAvailable, permissions, 'warning')).toBe(
            hasJob && MAY_STILL_PRINT.has(status),
          );
          expect(actions.poll, label(status, firstPrintAvailable, permissions, 'poll')).toBe(hasJob && POLL.has(status));
          expect(actions.heldNote).toBe(status === 'held');
        }
      }
    }
  });

  it('offers reprint without confirm on jobs that have reached the printer', () => {
    const reprintOnly = { submit: false, reprint: true, confirm: false };
    for (const status of ['submitted', 'delivered_to_printer', 'done_reported']) {
      const actions = printActions(status, false, reprintOnly);
      expect(actions.reprint).toBe(true);
      expect(actions.confirmPrinted).toBe(false);
      expect(actions.notPrinted).toBe(false);
    }
  });

  it('offers a new first print after a failed reprint when the index is free', () => {
    const submit = { submit: true, reprint: true, confirm: false };
    expect(printActions('failed', true, submit).print).toBe(true);
    expect(printActions('failed', true, submit).reprint).toBe(true);
    expect(printActions('failed', false, submit).print).toBe(false);
  });
});

function label(
  status: string | null,
  firstPrintAvailable: boolean,
  permissions: PrintPermissions,
  action: string,
): string {
  return `${action} status=${String(status)} first=${String(firstPrintAvailable)} submit=${String(permissions.submit)} reprint=${String(permissions.reprint)} confirm=${String(permissions.confirm)}`;
}
