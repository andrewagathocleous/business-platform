/** Sign-out clears all attempts; sign-in keeps only this user's attempts in this tab. */
export function clearPendingPaymentAttempts(keepOwnerId?: string): void {
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index);
      if (!key?.startsWith('bp.pending.')) continue;
      if (keepOwnerId && ownedBy(sessionStorage.getItem(key), keepOwnerId)) continue;
      sessionStorage.removeItem(key);
    }
  } catch {
    // Unavailable storage must not prevent session changes. Attempt reads still fail closed.
  }
}

function ownedBy(raw: string | null, ownerId: string): boolean {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    return (
      typeof value === 'object' && value !== null && 'ownerId' in value && value.ownerId === ownerId
    );
  } catch {
    return false;
  }
}
