export type PrintingAttempt<T> = {
  value?: T;
  error?: unknown;
  changed: boolean;
  cleanupError?: unknown;
  /** Persisted state after cleanup. The cleanup row reports this read-back. */
  persisted?: boolean;
};

/**
 * Records the prior state, enables printing inside the protected scope, runs
 * the print, then reads the persisted switch. A lost enable response still
 * reaches cleanup. When the persisted state differs from the prior state, it
 * is restored and read back.
 */
export async function attemptWithPrinting<T>(input: {
  enabled: boolean;
  enableReason: string;
  restoreReason: string;
  enable: (reason: string) => Promise<void>;
  readEnabled: () => Promise<boolean>;
  restore: (enabled: boolean, reason: string) => Promise<void>;
  run: () => Promise<T>;
}): Promise<PrintingAttempt<T>> {
  const prior = input.enabled;
  const attempt: PrintingAttempt<T> = { changed: false };
  try {
    if (!prior) {
      await input.enable(input.enableReason);
    }
    attempt.value = await input.run();
  } catch (error) {
    attempt.error = error;
  }
  try {
    let persisted = await input.readEnabled();
    if (persisted !== prior) {
      await input.restore(prior, input.restoreReason);
      persisted = await input.readEnabled();
      attempt.changed = persisted === prior;
    }
    attempt.persisted = persisted;
    if (persisted !== prior) {
      throw new Error('printing switch was not restored');
    }
  } catch (error) {
    attempt.cleanupError = error;
  }
  return attempt;
}
