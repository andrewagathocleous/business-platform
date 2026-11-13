/**
 * Postgres job runner. The HTTP process never starts the loop.
 *
 * Lease. Each claim stores a unique token `<workerId>:<uuidv7>` in `locked_by`.
 * Heartbeats, completion, failure, backoff and release all match
 * `id AND locked_by = <token> AND status = 'running'`. A heartbeat that updates
 * 0 rows aborts the handler. When both the renewal and the ownership read fail,
 * the handler is aborted once `lease - heartbeat` has elapsed since the last
 * successful renewal, measured with `performance.now()`.
 * `run_after`, `locked_until`, backoff and release times are computed with
 * `clock_timestamp()`, never the host clock. The lease is 60s and the heartbeat
 * is 20s.
 *
 * Fence. The handler runs inside one TenantDb transaction. The claim returns a
 * database-clock deadline, `clock_timestamp() + timeout_ms`. Success and failure
 * each lock the owned running row with `SELECT … FOR UPDATE`, then, in a
 * separate statement, require `clock_timestamp() < deadline AND locked_until >
 * clock_timestamp()`. Only then do they update. A volatile clock predicate in
 * the same statement as the lock can be evaluated before the wait and is not
 * rechecked when the blocking transaction leaves the tuple unchanged. Zero
 * rows, or a passed deadline, throws LeaseLost and the business writes roll
 * back. The abort signal is checked again after that update, before the
 * transaction callback returns.
 *
 * Shutdown. SIGTERM stops new claims. `stop()` has an overall deadline of
 * `shutdownGraceMs` plus 10s, covering the in-flight tick and settlement.
 * Claims take `pg_try_advisory_xact_lock` and the runner's own transactions
 * set a local statement and lock timeout, so a lock held elsewhere does not
 * block shutdown. After the grace period:
 * a started non-retryable job is marked `uncertain` and audited;
 * a started retryable job is released with backoff, keeping its attempt;
 * a started retryable job that has used `max_attempts` is marked `failed` and audited;
 * a claim whose handler never started is released and its attempt is restored.
 * Claims skip jobs with `attempts >= max_attempts`.
 *
 * External handlers (`mode: 'external'`) call something outside the database,
 * so the runner does not wrap them in one transaction. The handler gets short
 * company transactions that commit on their own, and the abort signal.
 * `runExternal` races the handler against that signal and the claim deadline.
 * When the race loses after `print.submit` has claimed `submitting`, the attempt
 * is settled `uncertain` with no retry. The handler promise keeps running, so a
 * late provider result is recorded and audited, and the provider is not called again.
 * `fenced` runs the body, then confirms the queue-job deadline. The body locks
 * `print_job` before `job` and calls `lockQueue`. A miss throws LeaseLost and
 * that transaction rolls back. Work that records a provider outcome uses
 * `transaction` plus `finish`: if the lease is already gone, the print outcome
 * and its audit still commit and the queue job is left for reclaim. The abort
 * signal fires on timeout, a lost lease and shutdown. It does not discard a
 * provider result the handler has already received.
 *
 * Lock order, everywhere a print attempt and its queue job are locked together:
 * `print_job` first, then `job`. That includes the claim, recording, reclaim,
 * timeout settlement, cancel and release. Confirm locks only `print_job`.
 * Reclaim does not lock `print.submit` or `print.refresh_status` in the generic
 * pass. It selects those expired rows without locking, then, in one transaction
 * per job, locks `print_job` and re-checks the queue row. Generic jobs stay in
 * their own transaction.
 *
 * `print.submit` claims `queued → submitting` inside `fenced` before the
 * provider call. A later attempt finds no queued row and does not call the
 * provider again. Lease expiry and shutdown of a non-retryable `print.submit`:
 * a print job still `submitting` becomes `uncertain` in the same transaction
 * as the queue job, and is audited. It is not put back to `queued`.
 * `uncertain` is written only from `submitting`. A print job still `queued`
 * (the claim did not commit, so the provider was not called) releases the
 * queue job and restores the attempt on shutdown or lease expiry. A timeout
 * or handler error fails that queued print instead.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, TenantDb, type TenantTransaction } from '@bp/db';
import { AuditService } from '../../audit/audit.service';
import { correlationStorage, uuidv7 } from '../../correlation/correlation';
import { PrismaService } from '../../database/prisma.service';
import { backoffMs } from './backoff';
import { WORKER_HEARTBEAT_PATH, touchWorkerHeartbeat } from './worker-heartbeat';

export type JobOutcome = { failed?: string };

export type ClaimedJob = {
  id: string;
  companyId: string | null;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  correlationId: string;
  timeoutMs: number;
  lockedBy: string;
  /** Database clock instant after which the completion fence must not commit. */
  deadline: Date;
};

export type QueueFinish = 'succeeded' | 'failed' | 'held' | 'uncertain' | 'cancelled';

/** Short, separately committed company transactions for a handler with an external side effect. */
export type ExternalJobs = {
  signal: AbortSignal;
  /**
   * Commits when `fn` resolves. A provider outcome is recorded here: `finish`
   * may update zero queue-job rows, and the print outcome still commits.
   */
  transaction<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T>;
  /**
   * Runs `fn`, then confirms the claim deadline. The body locks `print_job`
   * before calling `lockQueue` when it touches both rows. A missed lease or a
   * passed deadline throws LeaseLost and the transaction rolls back.
   * The provider is not called inside this.
   */
  fenced<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T>;
  /**
   * Locks the queue job this attempt still owns. Call it only after `print_job`
   * is locked. False means this attempt no longer holds the lease.
   */
  lockQueue(tx: TenantTransaction): Promise<boolean>;
  /**
   * Conditional completion of the queue job. False means this attempt no longer
   * holds the lease. The caller does not throw, so the surrounding transaction
   * still commits.
   */
  finish(tx: TenantTransaction, status: QueueFinish, lastError?: string | null): Promise<boolean>;
};

export type DatabaseJobHandler = {
  type: string;
  concurrency: number;
  retryable: boolean;
  mode?: 'database';
  run: (
    job: ClaimedJob,
    tx: TenantTransaction,
    signal: AbortSignal,
  ) => Promise<JobOutcome | undefined>;
};

export type ExternalJobHandler = {
  type: string;
  concurrency: number;
  retryable: boolean;
  mode: 'external';
  run: (job: ClaimedJob, external: ExternalJobs) => Promise<void>;
};

export type JobHandler = DatabaseJobHandler | ExternalJobHandler;

type ClaimRow = {
  id: string;
  companyId: string | null;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  correlationId: string;
  timeoutMs: number | null;
  lockedUntil: Date | string | null;
  deadline: Date | string;
};

type OwnedClaim = {
  job: ClaimedJob;
  started: boolean;
};

/** The completion fence saw another owner, or a lease that is no longer valid. */
export class LeaseLost extends Error {
  override readonly name = 'LeaseLost';

  constructor() {
    super('lease_lost');
  }
}

@Injectable()
export class JobRunner {
  readonly workerId = `w-${String(process.pid)}-${uuidv7()}`;
  leaseMs = 60_000;
  heartbeatMs = 20_000;
  pollMs = 1_000;
  /** How long SIGTERM waits for a handler that has already started. */
  shutdownGraceMs = 25_000;
  /** Upper bound for `drainOnce` while a registered job is due or nearly due. */
  drainDeadlineMs = 5_000;
  /**
   * Prisma budget for the handler transaction. Null uses the job's `timeout_ms`.
   * Tests set this above the database deadline so a delayed fence can still commit
   * on a build that forgets the deadline predicate.
   */
  transactionTimeoutMs: number | null = null;
  /** Runs after the handler and before the completion fence. Tests delay the fence here. */
  beforeFence: ((tx: TenantTransaction, job: ClaimedJob) => Promise<void>) | null = null;
  /**
   * Replaces the heartbeat queries. A rejection is a failed renewal or verification.
   * Tests use it to exercise the monotonic lease budget.
   */
  heartbeatIo: {
    renew: (job: ClaimedJob) => Promise<void>;
    verify: (job: ClaimedJob) => Promise<boolean>;
  } | null = null;
  /**
   * Replaces reclaim and claim. A claim that never settles must not keep the
   * file heartbeat fresh. Production leaves this null.
   */
  tickIo: {
    reclaim: () => Promise<void>;
    claim: () => Promise<ClaimedJob | null>;
  } | null = null;

  private readonly prisma;
  private readonly tenants: TenantDb;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly owned = new Map<string, OwnedClaim>();
  /** `performance.now()` just before the last successful renewal, keyed by claim token. */
  private readonly lastRenewalSentAt = new Map<string, number>();
  private readonly logger = new Logger(JobRunner.name);
  private abort = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickBusy = false;
  private stopping = false;
  /**
   * Touched when a tick starts, after reclaim finishes, after each successful
   * claim, and when that tick finishes. A claim that never settles does not
   * refresh it. No touch happens once `stop()` has begun. The compose
   * healthcheck fails when the file is older than 60s.
   */
  heartbeatFile = WORKER_HEARTBEAT_PATH;
  /** Clock for the file heartbeat. Production uses the host clock. */
  heartbeatClock: () => Date = () => new Date();

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.prisma = prisma.client;
    this.tenants = new TenantDb(prisma.client);
  }

  register(handler: JobHandler): void {
    this.handlers.set(handler.type, handler);
  }

  startLoop(): void {
    if (this.timer) {
      return;
    }
    this.logger.log('job loop started');
    const beat = (): void => {
      void this.tick();
    };
    beat();
    this.timer = setInterval(beat, this.pollMs);
  }

  private beat(): void {
    if (this.stopping) {
      return;
    }
    try {
      touchWorkerHeartbeat(this.heartbeatFile, this.heartbeatClock());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'heartbeat failed';
      this.logger.warn(`worker heartbeat was not written: ${message}`);
    }
  }

  /**
   * Stops claiming. In-flight handlers get `shutdownGraceMs` to finish.
   * Whatever is still running is then finalised. See the file comment.
   */
  async stop(): Promise<void> {
    const deadline = performance.now() + this.shutdownGraceMs + 10_000;
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    while (this.tickBusy && performance.now() < deadline) {
      await delay(10);
    }
    const remaining = (): number => Math.max(0, deadline - performance.now());
    await Promise.race([
      Promise.allSettled([...this.inflight.values()]),
      delay(Math.min(this.shutdownGraceMs, remaining())),
    ]);
    if (!this.abort.signal.aborted) {
      this.abort.abort(new DOMException('shutdown', 'AbortError'));
    }
    await Promise.race([
      Promise.allSettled([...this.inflight.values()]),
      delay(Math.min(1_000, this.shutdownGraceMs, remaining())),
    ]);
    for (const entry of [...this.owned.values()]) {
      if (performance.now() >= deadline) {
        break;
      }
      const left = remaining();
      const outcome = await Promise.race([
        this.settleShutdown(entry.job, entry.started).then(() => 'settled' as const),
        delay(left).then(() => 'pending' as const),
      ]);
      if (outcome === 'settled') {
        this.owned.delete(entry.job.lockedBy);
      }
    }
    await Promise.race([
      Promise.allSettled([...this.inflight.values()]),
      delay(Math.min(250, remaining())),
    ]);
    const leftover = [...this.owned.values()];
    if (leftover.length > 0 || this.tickBusy) {
      const ids = leftover.map((entry) => `${entry.job.id} ${entry.job.lockedBy}`).join(', ');
      this.logger.warn(
        `shutdown left ${String(leftover.length)} unsettled claim(s)${ids.length > 0 ? `: ${ids}` : ''}${this.tickBusy ? '; a claim tick was still running' : ''}`,
      );
    }
  }

  /**
   * Runs due jobs of registered types until none are due within 300ms,
   * or `drainDeadlineMs` passes. A job that is only slightly ahead of the
   * database clock is waited for, instead of stopping after a miss count.
   * `scope` limits the claim, the wait and reclaim to one company. The worker
   * and every production caller omit it and still drain every company.
   */
  async drainOnce(
    limit = 1_000,
    scope?: { readonly companyId: string },
  ): Promise<{ processed: number }> {
    const companyId = scope?.companyId ?? null;
    const deadline = Date.now() + this.drainDeadlineMs;
    let processed = 0;
    for (;;) {
      if (Date.now() >= deadline) {
        return { processed };
      }
      await this.reclaimExpired(scope);
      const job = await this.claimOne(this.workerId, companyId);
      if (!job) {
        const waitMs = await this.nextDelayMs(companyId);
        if (waitMs === null) {
          return { processed };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return { processed };
        }
        await delay(Math.min(waitMs, remaining));
        continue;
      }
      if (this.stopping) {
        await this.settleShutdown(job, false);
        return { processed };
      }
      await this.execute(job);
      processed += 1;
      if (processed >= limit) {
        return { processed };
      }
    }
  }

  async claimOne(
    workerId = this.workerId,
    companyId: string | null = null,
  ): Promise<ClaimedJob | null> {
    const types = [...this.handlers.keys()];
    if (types.length === 0) {
      return null;
    }
    const token = `${workerId}:${uuidv7()}`;
    const typeList = types.join(',');
    const rows = await this.prisma.$transaction(async (tx) => {
      await this.setRunnerTimeouts(tx);
      const locked = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended('bp-job-claim', 0::bigint)) AS locked
      `;
      if (locked[0]?.locked !== true) {
        return [];
      }
      const companyMatch = this.companyMatch(companyId);
      const running = await tx.$queryRaw<{ type: string; n: unknown }[]>`
        SELECT type, count(*)::int AS n
        FROM job
        WHERE status = 'running'::"job_status"
          AND locked_until > clock_timestamp()
          AND type = ANY(string_to_array(${typeList}, ','))
          AND ${companyMatch}
        GROUP BY type
      `;
      const runningCount = new Map(running.map((row) => [row.type, asNumber(row.n)]));
      const eligible = types.filter((type) => {
        const limitForType = this.handlers.get(type)?.concurrency ?? 1;
        return (runningCount.get(type) ?? 0) < limitForType;
      });
      if (eligible.length === 0) {
        return [];
      }
      const eligibleList = eligible.join(',');
      const picked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id
        FROM job
        WHERE status = 'queued'::"job_status"
          AND run_after <= clock_timestamp()
          AND attempts < max_attempts
          AND type = ANY(string_to_array(${eligibleList}, ','))
          AND ${companyMatch}
        ORDER BY run_after, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const id = picked[0]?.id;
      if (!id) {
        return [];
      }
      return tx.$queryRaw<ClaimRow[]>`
        UPDATE job
        SET status = 'running'::"job_status",
            attempts = attempts + 1,
            locked_by = ${token},
            locked_until = clock_timestamp() + make_interval(secs => ${this.leaseMs / 1000}),
            updated_at = clock_timestamp()
        WHERE id = ${id}::uuid
          AND status = 'queued'::"job_status"
          AND attempts < max_attempts
        RETURNING
          id,
          company_id AS "companyId",
          type,
          payload,
          attempts,
          max_attempts AS "maxAttempts",
          correlation_id AS "correlationId",
          timeout_ms AS "timeoutMs",
          locked_until AS "lockedUntil",
          clock_timestamp() + (COALESCE(timeout_ms, 30000) * interval '1 millisecond') AS deadline
      `;
    });
    const row = rows[0];
    if (!row) {
      return null;
    }
    const job = this.claimed(row, token);
    this.owned.set(job.lockedBy, { job, started: false });
    this.lastRenewalSentAt.set(job.lockedBy, performance.now());
    return job;
  }

  /** Unscoped drains match every company. A test scope matches one. */
  private companyMatch(companyId: string | null): Prisma.Sql {
    if (!companyId) {
      return Prisma.sql`TRUE`;
    }
    return Prisma.sql`company_id = ${companyId}::uuid`;
  }

  /**
   * Milliseconds to wait before claiming again.
   * 15 when a registered job is already due. The soonest wait, capped at 300ms,
   * when the next job is only slightly ahead of the database clock. Null when
   * nothing claimable is due inside that window.
   */
  private async nextDelayMs(companyId: string | null = null): Promise<number | null> {
    const types = [...this.handlers.keys()];
    if (types.length === 0) {
      return null;
    }
    const typeList = types.join(',');
    const companyMatch = this.companyMatch(companyId);
    const rows = await this.prisma.$queryRaw<{ due: unknown; soon: unknown; waitMs: unknown }[]>`
      SELECT
        count(*) FILTER (WHERE run_after <= clock_timestamp())::int AS due,
        count(*)::int AS soon,
        EXTRACT(EPOCH FROM (MIN(run_after) - clock_timestamp())) * 1000 AS "waitMs"
      FROM job
      WHERE status = 'queued'::"job_status"
        AND attempts < max_attempts
        AND type = ANY(string_to_array(${typeList}, ','))
        AND run_after <= clock_timestamp() + interval '300 milliseconds'
        AND ${companyMatch}
    `;
    const row = rows[0];
    if (!row || asNumber(row.soon) === 0) {
      return null;
    }
    if (asNumber(row.due) > 0) {
      return 15;
    }
    const wait = asNumber(row.waitMs);
    if (!Number.isFinite(wait) || wait <= 0) {
      return 15;
    }
    return Math.min(Math.ceil(wait), 300);
  }

  private claimed(row: ClaimRow, token: string): ClaimedJob {
    return {
      id: row.id,
      companyId: row.companyId,
      type: row.type,
      payload: decodeJson(row.payload),
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      correlationId: row.correlationId,
      timeoutMs: row.timeoutMs ?? 30_000,
      lockedBy: token,
      deadline: row.deadline instanceof Date ? row.deadline : new Date(row.deadline),
    };
  }

  async reclaimExpired(scope?: { readonly companyId: string }): Promise<number> {
    const types = [...this.handlers.keys()];
    if (types.length === 0) {
      return 0;
    }
    const companyId = scope?.companyId ?? null;
    const typeList = types.join(',');
    const generic = await this.reclaimGeneric(typeList, companyId);
    const companyMatch = this.companyMatch(companyId);
    const prints = await this.prisma.$queryRaw<ExpiredPrintJob[]>`
      SELECT id,
             company_id AS "companyId",
             type,
             attempts,
             max_attempts AS "maxAttempts",
             correlation_id AS "correlationId",
             payload
      FROM job
      WHERE status = 'running'::"job_status"
        AND locked_until IS NOT NULL
        AND locked_until <= clock_timestamp()
        AND company_id IS NOT NULL
        AND type IN ('print.submit', 'print.refresh_status')
        AND type = ANY(string_to_array(${typeList}, ','))
        AND ${companyMatch}
    `;
    let reclaimed = 0;
    for (const row of prints) {
      if (await this.reclaimPrintHandler(row)) {
        reclaimed += 1;
      }
    }
    return generic + reclaimed;
  }

  /** Expired jobs that are not print handlers. One transaction, queue row first. */
  private async reclaimGeneric(typeList: string, companyId: string | null): Promise<number> {
    const companyMatch = this.companyMatch(companyId);
    return this.prisma.$transaction(async (tx) => {
      await this.setRunnerTimeouts(tx);
      const expired = await tx.$queryRaw<
        {
          id: string;
          type: string;
          attempts: number;
          maxAttempts: number;
        }[]
      >`
        SELECT id,
               type,
               attempts,
               max_attempts AS "maxAttempts"
        FROM job
        WHERE status = 'running'::"job_status"
          AND locked_until IS NOT NULL
          AND locked_until <= clock_timestamp()
          AND type = ANY(string_to_array(${typeList}, ','))
          AND (
            type NOT IN ('print.submit', 'print.refresh_status')
            OR company_id IS NULL
          )
          AND ${companyMatch}
        FOR UPDATE SKIP LOCKED
      `;
      for (const row of expired) {
        await this.requeueOrUncertain(tx, row.id, row.type, row.attempts, row.maxAttempts);
      }
      return expired.length;
    });
  }

  /**
   * Print handler reclaim. Locks `print_job`, then re-checks the queue row.
   * A row another worker already finished is left alone.
   */
  private async reclaimPrintHandler(row: ExpiredPrintJob): Promise<boolean> {
    const companyId = row.companyId;
    if (!companyId || row.correlationId.length === 0) {
      return false;
    }
    return correlationStorage.run({ correlationId: row.correlationId }, () =>
      this.tenants.run(
        { companyId, actor: 'system', correlationId: row.correlationId },
        async (tx) => {
          await this.setRunnerTimeouts(tx);
          if (row.type === 'print.submit') {
            return this.closePrintSubmit(
              tx,
              {
                id: row.id,
                companyId,
                correlationId: row.correlationId,
                lockedBy: null,
              },
              'lease_expired',
              true,
              false,
            );
          }
          const printJobId = printJobIdFromPayload(row.payload);
          if (printJobId) {
            await tx.$queryRaw`
              SELECT id
              FROM print_job
              WHERE company_id = ${companyId}::uuid
                AND id = ${printJobId}::uuid
              FOR UPDATE
            `;
          }
          const locked = await tx.$queryRaw<{ attempts: number; maxAttempts: number }[]>`
            SELECT attempts, max_attempts AS "maxAttempts"
            FROM job
            WHERE id = ${row.id}::uuid
              AND status = 'running'::"job_status"
              AND locked_until IS NOT NULL
              AND locked_until <= clock_timestamp()
            FOR UPDATE
          `;
          const current = locked[0];
          if (!current) {
            return false;
          }
          await this.requeueOrUncertain(
            tx,
            row.id,
            row.type,
            current.attempts,
            current.maxAttempts,
          );
          return true;
        },
      ),
    );
  }

  private async requeueOrUncertain(
    tx: { $executeRaw: PrismaService['client']['$executeRaw'] },
    jobId: string,
    type: string,
    attempts: number,
    maxAttempts: number,
  ): Promise<void> {
    const retryable = this.handlers.get(type)?.retryable === true;
    if (!retryable || attempts >= maxAttempts) {
      await tx.$executeRaw`
        UPDATE job
        SET status = 'uncertain'::"job_status",
            last_error = 'lease_expired',
            locked_by = NULL,
            locked_until = NULL,
            finished_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE id = ${jobId}::uuid
          AND status = 'running'::"job_status"
      `;
      return;
    }
    const delayMs = backoffMs(attempts);
    await tx.$executeRaw`
      UPDATE job
      SET status = 'queued'::"job_status",
          last_error = 'lease_expired',
          locked_by = NULL,
          locked_until = NULL,
          run_after = clock_timestamp() + make_interval(secs => ${delayMs / 1000}),
          updated_at = clock_timestamp()
      WHERE id = ${jobId}::uuid
        AND status = 'running'::"job_status"
    `;
  }

  execute(job: ClaimedJob): Promise<void> {
    const run = this.runClaim(job).finally(() => {
      this.inflight.delete(job.lockedBy);
    });
    this.inflight.set(job.lockedBy, run);
    return run;
  }

  private async runClaim(job: ClaimedJob): Promise<void> {
    const handler = this.handlers.get(job.type);
    const controller = new AbortController();
    const onParent = (): void => {
      controller.abort(this.abort.signal.reason);
    };
    if (this.abort.signal.aborted) {
      controller.abort(this.abort.signal.reason);
    } else {
      this.abort.signal.addEventListener('abort', onParent);
    }
    const timeout = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new DOMException('job timed out', 'TimeoutError'));
      }
    }, job.timeoutMs);
    const heartbeat = setInterval(() => {
      void this.heartbeat(job, controller);
    }, this.heartbeatMs);
    heartbeat.unref();
    let started = false;
    try {
      if (this.stopping) {
        await this.settleShutdown(job, false);
        return;
      }
      if (!handler) {
        await this.markTerminal(job, 'uncertain', 'unknown_handler', false);
        return;
      }
      const companyId = job.companyId;
      if (!companyId) {
        await this.markTerminal(job, 'failed', 'job_missing_company', false);
        return;
      }
      const owned = this.owned.get(job.lockedBy);
      if (owned) {
        owned.started = true;
      }
      started = true;
      if (handler.mode === 'external') {
        await correlationStorage.run({ correlationId: job.correlationId }, () =>
          this.runExternal(handler, job, controller),
        );
        return;
      }
      const actor = serviceActor(job.payload);
      await correlationStorage.run({ correlationId: job.correlationId }, () =>
        this.tenants.run(
          {
            companyId,
            correlationId: job.correlationId,
            actor: actor.serviceIdentityId ?? 'system',
          },
          async (tx) => {
            const outcome = await this.invoke(handler, job, tx, controller.signal);
            if (controller.signal.aborted) {
              throw reasonError(controller.signal);
            }
            if (this.beforeFence) {
              await this.beforeFence(tx, job);
            }
            if (outcome?.failed) {
              const updated = await this.completeFailed(tx, job, outcome.failed);
              if (updated === 0) {
                throw new LeaseLost();
              }
            } else {
              const updated = await this.completeSucceeded(tx, job);
              if (updated === 0) {
                throw new LeaseLost();
              }
            }
            if (signalAborted(controller.signal)) {
              throw reasonError(controller.signal);
            }
          },
          { timeoutMs: this.transactionTimeoutMs ?? job.timeoutMs },
        ),
      );
    } catch (error) {
      if (this.stopping || isShutdownAbort(controller.signal)) {
        await this.settleShutdown(job, started);
        return;
      }
      if (isLeaseLost(error)) {
        return;
      }
      if (isJobTimeout(error, controller.signal)) {
        await this.finishTimeout(job, handler);
        return;
      }
      await this.finishError(job, handler, error);
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      this.abort.signal.removeEventListener('abort', onParent);
      this.lastRenewalSentAt.delete(job.lockedBy);
      this.owned.delete(job.lockedBy);
    }
  }

  private invoke(
    handler: DatabaseJobHandler,
    job: ClaimedJob,
    tx: TenantTransaction,
    signal: AbortSignal,
  ): Promise<JobOutcome | undefined> {
    if (signal.aborted) {
      return Promise.reject(reasonError(signal));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        settle();
      };
      const onAbort = (): void => {
        finish(() => {
          reject(reasonError(signal));
        });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      handler.run(job, tx, signal).then(
        (value) => {
          finish(() => {
            resolve(value);
          });
        },
        (error: unknown) => {
          finish(() => {
            reject(error instanceof Error ? error : new Error('job_failed'));
          });
        },
      );
    });
  }

  private stopped(): boolean {
    return this.stopping;
  }

  private async tick(): Promise<void> {
    if (this.stopping || this.tickBusy) {
      return;
    }
    this.beat();
    this.tickBusy = true;
    try {
      if (this.tickIo) {
        await this.tickIo.reclaim();
      } else {
        await this.reclaimExpired();
      }
      this.beat();
      while (!this.stopped()) {
        const job = this.tickIo ? await this.tickIo.claim() : await this.claimOne();
        if (!job) {
          return;
        }
        this.beat();
        if (this.stopped()) {
          await this.settleShutdown(job, false);
          return;
        }
        void this.execute(job);
      }
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : 'job tick failed');
    } finally {
      this.tickBusy = false;
      this.beat();
    }
  }

  private async heartbeat(job: ClaimedJob, controller: AbortController): Promise<void> {
    if (controller.signal.aborted) {
      return;
    }
    const sentAt = performance.now();
    try {
      const renewed = await this.renewLease(job);
      if (!renewed) {
        this.loseLease(controller);
        return;
      }
      this.lastRenewalSentAt.set(job.lockedBy, sentAt);
    } catch (error) {
      this.logger.warn(error instanceof Error ? error.message : 'heartbeat failed');
      await this.abortIfLeaseExpired(job, controller);
    }
  }

  private async renewLease(job: ClaimedJob): Promise<boolean> {
    if (this.heartbeatIo) {
      await this.heartbeatIo.renew(job);
      return true;
    }
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE job
      SET locked_until = clock_timestamp() + make_interval(secs => ${this.leaseMs / 1000}),
          updated_at = clock_timestamp()
      WHERE id = ${job.id}::uuid
        AND locked_by = ${job.lockedBy}
        AND status = 'running'::"job_status"
        AND locked_until > clock_timestamp()
      RETURNING id
    `;
    return rows.length > 0;
  }

  private loseLease(controller: AbortController): void {
    if (!controller.signal.aborted) {
      controller.abort(new LeaseLost());
    }
  }

  private async abortIfLeaseExpired(job: ClaimedJob, controller: AbortController): Promise<void> {
    try {
      const alive = this.heartbeatIo
        ? await this.heartbeatIo.verify(job)
        : await this.leaseStillHeld(job);
      if (!alive) {
        this.loseLease(controller);
      }
    } catch {
      const sentAt = this.lastRenewalSentAt.get(job.lockedBy);
      const budget = this.leaseMs - this.heartbeatMs;
      if (sentAt === undefined || performance.now() - sentAt >= budget) {
        this.loseLease(controller);
      }
    }
  }

  private async leaseStillHeld(job: ClaimedJob): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ alive: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM job
        WHERE id = ${job.id}::uuid
          AND locked_by = ${job.lockedBy}
          AND status = 'running'::"job_status"
          AND locked_until > clock_timestamp()
      ) AS alive
    `;
    return rows[0]?.alive === true;
  }

  private async completeSucceeded(tx: TenantTransaction, job: ClaimedJob): Promise<number> {
    if (!(await this.fenceAllows(tx, job))) {
      return 0;
    }
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE job
      SET status = 'succeeded'::"job_status",
          locked_by = NULL,
          locked_until = NULL,
          last_error = NULL,
          finished_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE id = ${job.id}::uuid
        AND locked_by = ${job.lockedBy}
        AND status = 'running'::"job_status"
      RETURNING id
    `;
    return rows.length;
  }

  private async completeFailed(
    tx: TenantTransaction,
    job: ClaimedJob,
    message: string,
  ): Promise<number> {
    if (!(await this.fenceAllows(tx, job))) {
      return 0;
    }
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE job
      SET status = 'failed'::"job_status",
          last_error = ${clip(message)},
          locked_by = NULL,
          locked_until = NULL,
          finished_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE id = ${job.id}::uuid
        AND locked_by = ${job.lockedBy}
        AND status = 'running'::"job_status"
      RETURNING id
    `;
    return rows.length;
  }

  /**
   * Locks the row this attempt still owns, then reads the clock. The clock
   * check is a separate statement so it cannot be evaluated before the wait.
   */
  private async fenceAllows(tx: TenantTransaction, job: ClaimedJob): Promise<boolean> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM job
      WHERE id = ${job.id}::uuid
        AND locked_by = ${job.lockedBy}
        AND status = 'running'::"job_status"
      FOR UPDATE
    `;
    if (locked.length === 0) {
      return false;
    }
    const rows = await tx.$queryRaw<{ open: boolean }[]>`
      SELECT (
        clock_timestamp() < ${job.deadline}::timestamptz
        AND locked_until > clock_timestamp()
      ) AS open
      FROM job
      WHERE id = ${job.id}::uuid
    `;
    return rows[0]?.open === true;
  }

  private async finishError(
    job: ClaimedJob,
    handler: JobHandler | undefined,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : 'job_failed';
    if (job.type === 'print.submit') {
      await this.settleOwnedPrint(job, message, false);
      return;
    }
    if (handler?.retryable && job.attempts < job.maxAttempts) {
      await this.requeue(job, message, backoffMs(job.attempts), false);
      return;
    }
    await this.markTerminal(job, 'failed', message, false);
  }

  private async finishTimeout(job: ClaimedJob, handler: JobHandler | undefined): Promise<void> {
    if (job.type === 'print.submit') {
      await this.settleOwnedPrint(job, 'timed_out', false);
      return;
    }
    if (handler?.retryable && job.attempts < job.maxAttempts) {
      await this.requeue(job, 'timed_out', backoffMs(job.attempts), false);
      return;
    }
    const retryable = handler?.retryable === true;
    await this.markTerminal(job, retryable ? 'failed' : 'uncertain', 'timed_out', !retryable);
  }

  /**
   * Finalises a claim during shutdown.
   * An unstarted claim is put back with its attempt restored.
   * A started non-retryable job becomes `uncertain`.
   * A started retryable job is backed off, unless this attempt exhausted the limit.
   */
  private async settleShutdown(job: ClaimedJob, started: boolean): Promise<void> {
    if (!started) {
      await this.requeue(job, 'shutdown', 0, true);
      return;
    }
    if (job.type === 'print.submit') {
      await this.settleOwnedPrint(job, 'shutdown', true);
      return;
    }
    const retryable = this.handlers.get(job.type)?.retryable === true;
    if (!retryable || job.attempts >= job.maxAttempts) {
      await this.markTerminal(job, retryable ? 'failed' : 'uncertain', 'shutdown', true);
      return;
    }
    await this.requeue(job, 'shutdown', backoffMs(job.attempts), false);
  }

  private async requeue(
    job: ClaimedJob,
    message: string,
    delayMs: number,
    restoreAttempt: boolean,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.setRunnerTimeouts(tx);
      if (restoreAttempt) {
        await tx.$executeRaw`
          UPDATE job
          SET status = 'queued'::"job_status",
              locked_by = NULL,
              locked_until = NULL,
              run_after = clock_timestamp(),
              attempts = GREATEST(attempts - 1, 0),
              updated_at = clock_timestamp()
          WHERE id = ${job.id}::uuid
            AND locked_by = ${job.lockedBy}
            AND status = 'running'::"job_status"
        `;
        return;
      }
      await tx.$executeRaw`
        UPDATE job
        SET status = 'queued'::"job_status",
            last_error = ${clip(message)},
            locked_by = NULL,
            locked_until = NULL,
            run_after = clock_timestamp() + make_interval(secs => ${delayMs / 1000}),
            updated_at = clock_timestamp()
        WHERE id = ${job.id}::uuid
          AND locked_by = ${job.lockedBy}
          AND status = 'running'::"job_status"
      `;
    });
  }

  private async markTerminal(
    job: ClaimedJob,
    status: 'failed' | 'uncertain',
    message: string,
    audit: boolean,
  ): Promise<void> {
    const companyId = job.companyId;
    const apply = async (tx: TenantTransaction): Promise<void> => {
      await this.setRunnerTimeouts(tx);
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE job
        SET status = ${status}::"job_status",
            last_error = ${clip(message)},
            locked_by = NULL,
            locked_until = NULL,
            finished_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE id = ${job.id}::uuid
          AND locked_by = ${job.lockedBy}
          AND status = 'running'::"job_status"
        RETURNING id
      `;
      if (rows.length === 0 || !audit || !companyId) {
        return;
      }
      await this.audit.record(tx, {
        companyId,
        actorType: 'system',
        actorLabel: 'job-runner',
        action: status === 'uncertain' ? 'job.uncertain' : 'job.failed',
        objectType: 'job',
        objectId: job.id,
        outcome: 'failure',
        details: { reason: clip(message) },
      });
    };
    if (!companyId) {
      await this.prisma.$transaction(async (tx) => {
        await apply(tx);
      });
      return;
    }
    await correlationStorage.run({ correlationId: job.correlationId }, () =>
      this.tenants.run({ companyId, actor: 'system', correlationId: job.correlationId }, (tx) =>
        apply(tx),
      ),
    );
  }

  private async runExternal(
    handler: ExternalJobHandler,
    job: ClaimedJob,
    controller: AbortController,
  ): Promise<void> {
    const companyId = job.companyId;
    if (!companyId) {
      throw new Error('job_missing_company');
    }
    const external = this.externalJobs(job, companyId, controller);
    const run = handler.run(job, external);
    let detached = false;
    const observed = run.then(
      () => undefined,
      (error: unknown) => {
        if (detached) {
          const message = error instanceof Error ? error.message : 'job_failed';
          this.logger.error(
            `external handler failed after the attempt stopped waiting job=${job.id} error=${message}`,
          );
          return;
        }
        throw error instanceof Error ? error : new Error('job_failed');
      },
    );
    try {
      await raceAbortOrDeadline(observed, controller.signal, job.deadline);
    } catch (error) {
      detached = true;
      if (!controller.signal.aborted) {
        controller.abort(
          error instanceof Error ? error : new DOMException('job timed out', 'TimeoutError'),
        );
      }
      throw error;
    }
  }

  private externalJobs(
    job: ClaimedJob,
    companyId: string,
    controller: AbortController,
  ): ExternalJobs {
    const context = {
      companyId,
      actor: 'job-runner',
      correlationId: job.correlationId,
    };
    return {
      signal: controller.signal,
      transaction: (fn) =>
        this.tenants.run(context, fn, { timeoutMs: this.transactionTimeoutMs ?? 5_000 }),
      fenced: (fn) =>
        this.tenants.run(
          context,
          async (tx) => {
            const value = await fn(tx);
            if (this.beforeFence) {
              await this.beforeFence(tx, job);
            }
            const open = await this.deadlineOpen(tx, job);
            if (!open) {
              throw new LeaseLost();
            }
            if (signalAborted(controller.signal)) {
              throw reasonError(controller.signal);
            }
            return value;
          },
          { timeoutMs: this.transactionTimeoutMs ?? 5_000 },
        ),
      lockQueue: (tx) => this.lockOwnedJob(tx, job),
      finish: (tx, status, lastError) => this.finishQueue(tx, job, status, lastError ?? null),
    };
  }

  private async lockOwnedJob(tx: TenantTransaction, job: ClaimedJob): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM job
      WHERE id = ${job.id}::uuid
        AND locked_by = ${job.lockedBy}
        AND status = 'running'::"job_status"
        AND locked_until > clock_timestamp()
        AND clock_timestamp() < ${job.deadline}::timestamptz
      FOR UPDATE
    `;
    return rows.length > 0;
  }

  private async deadlineOpen(tx: TenantTransaction, job: ClaimedJob): Promise<boolean> {
    const rows = await tx.$queryRaw<{ open: boolean }[]>`
      SELECT clock_timestamp() < ${job.deadline}::timestamptz AS open
    `;
    return rows[0]?.open === true;
  }

  private async finishQueue(
    tx: TenantTransaction,
    job: ClaimedJob,
    status: QueueFinish,
    lastError: string | null,
  ): Promise<boolean> {
    if (!(await this.fenceAllows(tx, job))) {
      return false;
    }
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE job
      SET status = ${status}::"job_status",
          last_error = ${lastError === null ? null : clip(lastError)},
          locked_by = NULL,
          locked_until = NULL,
          finished_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE id = ${job.id}::uuid
        AND locked_by = ${job.lockedBy}
        AND status = 'running'::"job_status"
      RETURNING id
    `;
    return rows.length > 0;
  }

  /** Closes a print.submit attempt this worker still owns. */
  private async settleOwnedPrint(
    job: ClaimedJob,
    reason: string,
    restoreIfQueued: boolean,
  ): Promise<void> {
    const companyId = job.companyId;
    if (!companyId) {
      await this.markTerminal(job, 'failed', reason, false);
      return;
    }
    await correlationStorage.run({ correlationId: job.correlationId }, () =>
      this.tenants.run(
        { companyId, actor: 'system', correlationId: job.correlationId },
        async (tx) => {
          await this.setRunnerTimeouts(tx);
          await this.closePrintSubmit(
            tx,
            { id: job.id, companyId, correlationId: job.correlationId, lockedBy: job.lockedBy },
            reason,
            restoreIfQueued,
            true,
          );
        },
      ),
    );
  }

  /**
   * Print job first, then the queue job. Cancel, release, confirm, recording,
   * the claim and this reconciliation all use that order.
   * A submitting print becomes uncertain and is audited. It is not returned to queued.
   * `uncertain` is written only from `submitting`.
   * A print still queued has not called the provider. Shutdown and lease expiry
   * restore the attempt. A handler error or timeout fails that print instead.
   */
  private async closePrintSubmit(
    tx: TenantTransaction,
    job: { id: string; companyId: string; correlationId: string; lockedBy: string | null },
    reason: string,
    restoreIfQueued: boolean,
    matchOwner: boolean,
  ): Promise<boolean> {
    await tx.$executeRaw`SELECT set_config('app.company_id', ${job.companyId}, true)`;
    const prints = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status::text AS status
      FROM print_job
      WHERE company_id = ${job.companyId}::uuid
        AND queue_job_id = ${job.id}::uuid
      FOR UPDATE
    `;
    const owned = matchOwner ? job.lockedBy : null;
    const jobs = await tx.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM job
      WHERE id = ${job.id}::uuid
        AND status = 'running'::"job_status"
        AND (${owned}::text IS NULL OR locked_by = ${owned})
        AND (
          ${owned}::text IS NOT NULL
          OR locked_until <= clock_timestamp()
        )
      FOR UPDATE
    `;
    if (jobs.length === 0) {
      return false;
    }
    const print = prints[0];
    if (!print || print.status === 'queued') {
      if (restoreIfQueued) {
        await tx.$executeRaw`
          UPDATE job
          SET status = 'queued'::"job_status",
              last_error = ${clip(reason)},
              locked_by = NULL,
              locked_until = NULL,
              attempts = GREATEST(attempts - 1, 0),
              run_after = clock_timestamp(),
              updated_at = clock_timestamp()
          WHERE id = ${job.id}::uuid
            AND status = 'running'::"job_status"
        `;
        return true;
      }
      await this.finishRunning(tx, job.id, 'failed', reason, matchOwner, job.lockedBy);
      if (print) {
        await this.failQueuedPrint(tx, job, print.id, reason);
      }
      return true;
    }
    if (print.status === 'submitting') {
      await this.finishRunning(tx, job.id, 'uncertain', reason, matchOwner, job.lockedBy);
      const updated = await tx.$queryRaw<{ id: string }[]>`
        UPDATE print_job
        SET status = 'uncertain'::"print_job_status",
            last_error = ${clip(reason)},
            updated_at = clock_timestamp()
        WHERE id = ${print.id}::uuid
          AND company_id = ${job.companyId}::uuid
          AND status = 'submitting'::"print_job_status"
        RETURNING id
      `;
      if (updated.length > 0) {
        await correlationStorage.run({ correlationId: job.correlationId }, () =>
          this.audit.record(tx, {
            companyId: job.companyId,
            actorType: 'system',
            actorLabel: 'job-runner',
            action: 'print_job.uncertain',
            objectType: 'print_job',
            objectId: print.id,
            outcome: 'failure',
            details: { reason: clip(reason) },
          }),
        );
      }
      return true;
    }
    await this.finishRunning(tx, job.id, 'uncertain', reason, matchOwner, job.lockedBy);
    return true;
  }

  private async finishRunning(
    tx: TenantTransaction,
    jobId: string,
    status: 'failed' | 'uncertain',
    reason: string,
    matchOwner: boolean,
    lockedBy: string | null,
  ): Promise<void> {
    const owner = matchOwner ? lockedBy : null;
    await tx.$executeRaw`
      UPDATE job
      SET status = ${status}::"job_status",
          last_error = ${clip(reason)},
          locked_by = NULL,
          locked_until = NULL,
          finished_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE id = ${jobId}::uuid
        AND status = 'running'::"job_status"
        AND (${owner}::text IS NULL OR locked_by = ${owner})
    `;
  }

  private async failQueuedPrint(
    tx: TenantTransaction,
    job: { companyId: string; correlationId: string },
    printJobId: string,
    reason: string,
  ): Promise<void> {
    const updated = await tx.$queryRaw<{ id: string }[]>`
      UPDATE print_job
      SET status = 'failed'::"print_job_status",
          last_error = ${clip(reason)},
          updated_at = clock_timestamp()
      WHERE id = ${printJobId}::uuid
        AND company_id = ${job.companyId}::uuid
        AND status = 'queued'::"print_job_status"
      RETURNING id
    `;
    if (updated.length === 0) {
      return;
    }
    await correlationStorage.run({ correlationId: job.correlationId }, () =>
      this.audit.record(tx, {
        companyId: job.companyId,
        actorType: 'system',
        actorLabel: 'job-runner',
        action: 'print_job.failed',
        objectType: 'print_job',
        objectId: printJobId,
        outcome: 'failure',
        details: { reason: clip(reason) },
      }),
    );
  }

  /** Local limits for the runner's own claim, reclaim, settlement and requeue transactions. */
  private async setRunnerTimeouts(tx: {
    $executeRaw: PrismaService['client']['$executeRaw'];
  }): Promise<void> {
    await tx.$executeRaw`SELECT set_config('statement_timeout', '5s', true)`;
    await tx.$executeRaw`SELECT set_config('lock_timeout', '5s', true)`;
  }
}

type ExpiredPrintJob = {
  id: string;
  companyId: string;
  type: string;
  attempts: number;
  maxAttempts: number;
  correlationId: string;
  payload: unknown;
};

const PRINT_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function printJobIdFromPayload(payload: unknown): string | null {
  const value = decodeJson(payload);
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const printJobId = (value as { printJobId?: unknown }).printJobId;
  return typeof printJobId === 'string' && PRINT_JOB_ID.test(printJobId) ? printJobId : null;
}

function serviceActor(payload: unknown): {
  serviceIdentityId: string | null;
  actorLabel: string | null;
} {
  if (typeof payload !== 'object' || payload === null) {
    return { serviceIdentityId: null, actorLabel: null };
  }
  const serviceIdentityId =
    'serviceIdentityId' in payload && typeof payload.serviceIdentityId === 'string'
      ? payload.serviceIdentityId
      : null;
  const actorLabel =
    'actorLabel' in payload && typeof payload.actorLabel === 'string' ? payload.actorLabel : null;
  return { serviceIdentityId, actorLabel };
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return value;
  }
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string') {
    return Number(value);
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  return Number.NaN;
}

function clip(message: string): string {
  return message.slice(0, 500);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function raceAbortOrDeadline(
  work: Promise<void>,
  signal: AbortSignal,
  deadline: Date,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(reasonError(signal));
  }
  const remaining = deadline.getTime() - Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = (): void => {
      finish(() => {
        reject(reasonError(signal));
      });
    };
    const timer = setTimeout(
      () => {
        finish(() => {
          reject(new DOMException('job timed out', 'TimeoutError'));
        });
      },
      Math.max(0, remaining),
    );
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      () => {
        finish(() => {
          resolve();
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(error instanceof Error ? error : new Error('job_failed'));
        });
      },
    );
  });
}

function signalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function reasonError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException('The operation was aborted', 'AbortError');
}

function isShutdownAbort(signal: AbortSignal): boolean {
  return (
    signal.reason instanceof DOMException &&
    signal.reason.name === 'AbortError' &&
    signal.reason.message === 'shutdown'
  );
}

function isLeaseLost(error: unknown): boolean {
  if (error instanceof LeaseLost) {
    return true;
  }
  if (error instanceof Error) {
    if (error.name === 'LeaseLost' || error.message === 'lease_lost') {
      return true;
    }
    return isLeaseLost(error.cause);
  }
  return false;
}

function isJobTimeout(error: unknown, signal: AbortSignal): boolean {
  if (isLeaseLost(error)) {
    return false;
  }
  if (signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError') {
    return true;
  }
  const text = errorText(error);
  return (
    text.includes('TimeoutError') ||
    text.includes('timed_out') ||
    text.includes('timed out') ||
    text.includes('expired transaction') ||
    text.includes('Transaction already closed') ||
    text.includes('P2028')
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message} ${errorText(error.cause)}`;
  }
  return '';
}
