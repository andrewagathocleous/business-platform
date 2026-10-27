const CANCEL_FROM = ['queued', 'held', 'uncertain'] as const;

export type PrintJobActionFlags = {
  release: boolean;
  cancel: boolean;
};

/** Release is only for a held job. Cancel is only while the backend still allows it. */
export function printJobActions(
  status: string,
  can: { release: boolean; cancel: boolean },
): PrintJobActionFlags {
  return {
    release: can.release && status === 'held',
    cancel: can.cancel && CANCEL_FROM.some((allowed) => allowed === status),
  };
}
