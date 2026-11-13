import { HttpErrorResponse } from '@angular/common/http';

/**
 * A print request that has not had a definite answer. Sent again as it is, it cannot print
 * twice. `lost`: an answer went missing, so only a success settles it; a refused retry does not
 * show that the first attempt failed.
 */
export type PendingPrint = { body: Record<string, unknown>; lost: boolean };

/**
 * What a read of the saved request found.
 * `unreadable`: the read threw, or the saved text is not JSON. That is not "no request":
 * nothing new may replace it until a later read succeeds.
 * `none`: nothing is saved, or the JSON is not a saved request.
 * A request found after a reload is lost: its answer died with the previous page.
 */
export type PendingPrintRead =
  { kind: 'none' } | { kind: 'pending'; pending: PendingPrint } | { kind: 'unreadable' };

/**
 * Only a 4xx says the request was refused. No answer, a server error, or a reply that could
 * not be read (even with status 200) leaves the outcome unknown.
 */
export function unknownPrintOutcome(error: unknown): boolean {
  return !(error instanceof HttpErrorResponse) || error.status < 400 || error.status >= 500;
}

export function requestKeyOf(body: Record<string, unknown> | undefined): string | null {
  const key = body?.['requestKey'];
  return typeof key === 'string' ? key : null;
}

/**
 * `openStorage` is called inside the exception handling: reading the storage object itself
 * throws when site storage is blocked.
 */
export function readPendingPrint(
  openStorage: () => Pick<Storage, 'getItem'>,
  storageKey: string,
): PendingPrintRead {
  try {
    const text = readStoredText(openStorage(), storageKey);
    if (text.kind === 'unreadable') {
      return { kind: 'unreadable' };
    }
    if (text.kind === 'json') {
      const pending = pendingFromParsed(text.value);
      if (pending) {
        return { kind: 'pending', pending };
      }
    }
    return { kind: 'none' };
  } catch {
    return { kind: 'unreadable' };
  }
}

/**
 * False when the write did not happen. An unreadable saved entry is left as it is: a new key
 * must not replace a request whose outcome cannot be checked. The caller must not send if
 * this is false.
 */
export function writePendingPrint(
  openStorage: () => Pick<Storage, 'getItem' | 'setItem'>,
  storageKey: string,
  pending: PendingPrint,
): boolean {
  try {
    const storage = openStorage();
    if (readStoredText(storage, storageKey).kind === 'unreadable') {
      return false;
    }
    storage.setItem(storageKey, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

/** Only the request that owns the saved key may remove it. An unreadable entry is left in place. */
export function removePendingPrintIfKey(
  openStorage: () => Pick<Storage, 'getItem' | 'removeItem'>,
  storageKey: string,
  requestKey: string | null,
): void {
  try {
    const storage = openStorage();
    const stored = readPendingPrint(() => storage, storageKey);
    if (stored.kind === 'pending' && requestKeyOf(stored.pending.body) === requestKey) {
      storage.removeItem(storageKey);
    }
  } catch {
    // Leave the entry. A failed read must not delete it.
  }
}

type StoredText = { kind: 'empty' } | { kind: 'json'; value: unknown } | { kind: 'unreadable' };

function readStoredText(storage: Pick<Storage, 'getItem'>, storageKey: string): StoredText {
  const raw = storage.getItem(storageKey);
  // No entry. An empty string is the same: there is no saved request to protect.
  if (raw === null || raw.length === 0) {
    return { kind: 'empty' };
  }
  try {
    return { kind: 'json', value: JSON.parse(raw) };
  } catch {
    return { kind: 'unreadable' };
  }
}

function pendingFromParsed(parsed: unknown): PendingPrint | null {
  if (typeof parsed === 'object' && parsed !== null && 'body' in parsed) {
    const body = parsed.body;
    if (typeof body === 'object' && body !== null) {
      return { body: body as Record<string, unknown>, lost: true };
    }
  }
  return null;
}
