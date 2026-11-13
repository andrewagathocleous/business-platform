import { HttpClient } from '@angular/common/http';
import { DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SessionStore } from '../core/session.store';
import { createdId, definiteRefusal, PendingRequest, type PendingCreate } from './pending-request';
import { paymentFailure, type Failure } from './payment-view';

type Operation = PendingRequest['operation'];
type Attempt = { store: PendingRequest; request: PendingCreate };

/** One screen's create requests. A changed context invalidates every previous subscription. */
export class CreateRequests {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly session = inject(SessionStore);
  private generation = 0;
  private companyId = '';
  private stores = new Map<Operation, PendingRequest>();
  private succeeded: (operation: Operation, id: string, request: PendingCreate) => void = () => {};
  private refused: (operation: Operation) => void = () => {};
  private unanswered: () => void = () => {};
  readonly busy = signal(false);
  readonly pending = signal<Attempt | null>(null);
  readonly blocked = signal(false);
  readonly failure = signal<Failure | null>(null);
  readonly retryRefused = signal(false);

  reset(
    companyId: string,
    context: string,
    operations: Operation[],
    succeeded: typeof this.succeeded,
    refused: typeof this.refused = () => {},
    unanswered: typeof this.unanswered = () => {},
  ): void {
    this.generation += 1;
    this.companyId = companyId;
    this.succeeded = succeeded;
    this.refused = refused;
    this.unanswered = unanswered;
    this.stores.clear();
    this.busy.set(false);
    this.pending.set(null);
    this.blocked.set(false);
    this.failure.set(null);
    this.retryRefused.set(false);
    try {
      const ownerId = this.session.user()?.id ?? null;
      for (const operation of operations) {
        // A 401 clears the session before its refusal reaches this request's subscriber.
        const store = new PendingRequest(
          companyId,
          operation,
          context,
          () => this.session.user()?.id ?? ownerId,
        );
        this.stores.set(operation, store);
      }
      this.refreshPending();
    } catch {
      this.storageFailure();
    }
  }

  start(
    operation: Operation,
    body: Record<string, unknown>,
    followUp?: PendingCreate['followUp'],
  ): void {
    if (this.busy() || this.blocked() || !this.refreshPending() || this.pending()) return;
    const store = this.stores.get(operation);
    if (!store) return;
    try {
      this.pending.set({ store, request: store.prepare(body, followUp) });
    } catch {
      this.storageFailure();
      return;
    }
    this.send();
  }

  retry(): void {
    if (!this.busy()) this.send();
  }

  discard(): boolean {
    const attempt = this.pending();
    if (!attempt || this.busy() || !this.retryRefused()) return false;
    if (this.settle(attempt)) {
      this.failure.set(null);
      return true;
    }
    return false;
  }

  private send(): void {
    const attempt = this.pending();
    if (!attempt) return;
    const { store, request } = attempt;
    try {
      const stored = store.read();
      if (stored?.key !== request.key) {
        this.refreshPending();
        return;
      }
      if (stored.lost || request.lost) {
        const lost = store.markLost(request.key);
        if (!lost) {
          this.refreshPending();
          return;
        }
        this.pending.set({ store, request: lost });
      }
    } catch {
      this.storageFailure();
      return;
    }
    this.blocked.set(false);
    this.busy.set(true);
    this.failure.set(null);
    const generation = this.generation;
    this.http
      .post<unknown>(`/api/c/${this.companyId}/${store.operation}`, request.body, {
        headers: { 'Idempotency-Key': request.key },
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation !== this.generation) return;
          this.busy.set(false);
          if (!this.current(attempt)) return;
          const field = { payments: 'payment', allocations: 'allocation', refunds: 'refund' }[
            store.operation
          ];
          const id = createdId(response, field);
          if (!id) {
            this.markLost(attempt);
            if (this.blocked()) return;
            this.failure.set({ key: 'payments.errors.unknown', correlationId: null });
            this.unanswered();
            return;
          }
          if (!this.settle(attempt)) return;
          this.succeeded(store.operation, id, request);
        },
        error: (error: unknown) => {
          if (generation !== this.generation) return;
          this.busy.set(false);
          if (!this.current(attempt)) return;
          if (!definiteRefusal(error)) {
            this.markLost(attempt);
            if (this.blocked()) return;
            const failure = paymentFailure(error);
            this.failure.set({ ...failure, key: 'payments.errors.unknown' });
            this.unanswered();
            return;
          }
          // A restored or previously unanswered attempt survives a refused retry.
          if (this.pending()?.request.lost) {
            this.retryRefused.set(true);
            this.failure.set(paymentFailure(error));
            this.unanswered();
            return;
          }
          if (!this.settle(attempt)) return;
          this.failure.set(paymentFailure(error));
          this.refused(store.operation);
        },
      });
  }
  private settle(attempt: Attempt): boolean {
    try {
      const ownsKey = attempt.store.read()?.key === attempt.request.key;
      attempt.store.settle(attempt.request.key);
      if (!this.refreshPending()) return false;
      this.retryRefused.set(false);
      return ownsKey;
    } catch {
      this.storageFailure();
      return false;
    }
  }
  private current(attempt: Attempt): boolean {
    if (!this.refreshPending()) return false;
    return this.pending()?.request.key === attempt.request.key;
  }
  private markLost(attempt: Attempt): void {
    try {
      attempt.store.markLost(attempt.request.key);
      this.refreshPending();
    } catch {
      this.storageFailure();
    }
  }
  private refreshPending(): boolean {
    try {
      const prior = this.pending();
      let next: Attempt | null = null;
      for (const store of this.stores.values()) {
        const request = store.read();
        if (!request) continue;
        const same = prior?.request.key === request.key;
        const attempt = {
          store,
          request: { ...request, lost: request.lost || (same ? prior.request.lost : true) },
        };
        if (!next || same) next = attempt;
      }
      if (next?.request.key !== prior?.request.key) this.retryRefused.set(false);
      this.pending.set(next);
      return true;
    } catch {
      this.storageFailure();
      return false;
    }
  }
  private storageFailure(): void {
    const pending = this.pending();
    if (pending) this.pending.set({ ...pending, request: { ...pending.request, lost: true } });
    this.blocked.set(true);
    this.failure.set({ key: 'payments.errors.storage', correlationId: null });
  }
}
