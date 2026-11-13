import { HttpErrorResponse } from '@angular/common/http';

export type PendingCreate = {
  key: string;
  ownerId: string;
  body: Record<string, unknown>;
  /** Once an answer is lost, a refused retry cannot settle the earlier write. */
  lost?: boolean;
  /** Local intent for a second, separately keyed allocation after recording a payment. */
  followUp?: { invoiceId: string; amount: string };
};

/** A durable copy exists before any create is sent. Storage failures fail closed. */
export class PendingRequest {
  readonly storageKey: string;

  constructor(
    companyId: string,
    readonly operation: 'payments' | 'allocations' | 'refunds',
    context: string,
    private readonly currentOwnerId: () => string | null,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = sessionStorage,
  ) {
    // UUID spelling must not create a second attempt for the same API resource.
    this.storageKey = `bp.pending.${companyId.toLowerCase()}.${operation}.${context.toLowerCase()}`;
  }

  read(): PendingCreate | null {
    const ownerId = this.currentOwnerId();
    // Expiry preserves the attempt until its owner signs in again.
    if (!ownerId) return null;
    const raw = this.storage.getItem(this.storageKey);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value['ownerId'] !== ownerId) {
      this.storage.removeItem(this.storageKey);
      if (this.storage.getItem(this.storageKey) !== null)
        throw new Error('Pending request not cleared');
      return null;
    }
    if (
      typeof value['key'] !== 'string' ||
      !record(value['body']) ||
      (value['lost'] !== undefined && typeof value['lost'] !== 'boolean')
    ) {
      throw new Error('Invalid pending request');
    }
    const followUp = value['followUp'];
    if (
      followUp !== undefined &&
      (!record(followUp) ||
        typeof followUp['invoiceId'] !== 'string' ||
        typeof followUp['amount'] !== 'string')
    ) {
      throw new Error('Invalid pending intent');
    }
    return value as PendingCreate;
  }

  prepare(body: Record<string, unknown>, followUp?: PendingCreate['followUp']): PendingCreate {
    const ownerId = this.currentOwnerId();
    if (!ownerId) throw new Error('Pending request requires a signed-in user');
    // An unanswered attempt always wins over later edits.
    const prior = this.read();
    if (prior) return prior;
    const pending: PendingCreate = {
      key: crypto.randomUUID(),
      ownerId,
      body,
      ...(followUp ? { followUp } : {}),
    };
    return this.save(pending);
  }

  markLost(key: string): PendingCreate | null {
    const prior = this.read();
    if (!prior || prior.key !== key) return null;
    return this.save({ ...prior, lost: true });
  }

  settle(key: string): void {
    // A late answer must never remove a newer attempt's key.
    if (this.read()?.key === key) this.storage.removeItem(this.storageKey);
    if (this.read()?.key === key) throw new Error('Pending request not cleared');
  }

  private save(pending: PendingCreate): PendingCreate {
    const raw = JSON.stringify(pending);
    this.storage.setItem(this.storageKey, raw);
    // Also detect a storage implementation that silently refuses writes.
    if (this.storage.getItem(this.storageKey) !== raw) throw new Error('Pending request not saved');
    return JSON.parse(raw) as PendingCreate;
  }
}

export function definiteRefusal(error: unknown): boolean {
  return error instanceof HttpErrorResponse && error.status >= 400 && error.status < 500;
}

export function createdId(value: unknown, field: string): string | null {
  if (!record(value)) return null;
  const item = value[field];
  return record(item) && typeof item['id'] === 'string' && item['id'].length > 0
    ? item['id']
    : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
