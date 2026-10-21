import { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TenantTransaction } from '@bp/db';
import { can } from '@bp/domain';
import {
  PrinterOffline,
  ProviderRejected,
  ProviderTimeout,
  StoragePathError,
  type PrintProvider,
  type StorageAdapter,
} from '@bp/integrations';
import { AuditService } from '../audit/audit.service';
import { grantsForMembership } from '../authz/load-grants';
import {
  LeaseLost,
  type ClaimedJob,
  type ExternalJobs,
  type QueueFinish,
} from '../automation/jobs/job-runner';
import { uuidv7 } from '../correlation/correlation';
import { orderScopes } from '../orders/order.scope';
import { STORAGE } from '../storage/storage.module';
import { PRINT_PROVIDER } from './print.tokens';

/**
 * One print job calls the provider at most once, and never after a cancel has
 * succeeded. Every provider outcome is recorded and audited, including one that
 * arrives after reclaim or cancel.
 *
 * Lock order, in every transaction that touches both rows: `print_job` first,
 * then `job`. Cancel, release, the claim, recording and reclaim follow it.
 * Confirm locks only `print_job`. `uncertain` is written only from `submitting`.
 */
const REFRESH_ATTEMPTS = 5;
const REFRESH_TIMEOUT_MS = 15_000;
const RECORD_ATTEMPTS = 3;

/** Test seams. Production leaves `hooks` null. */
export type PrintProcessorHooks = {
  /** After the submitting claim commits and before the provider call. */
  afterClaim?: () => Promise<void>;
  /** Inside the recording transaction, before either row is locked. */
  beforeRecord?: () => Promise<void>;
  /** After `print_job` is locked and before `job` is locked. */
  duringRecord?: () => Promise<void>;
};

type SubmitPayload = {
  printJobId: string;
  requestedById: string;
  releasedById: string | null;
  isReprint: boolean;
};

type ClaimedPrint = {
  printJobId: string;
  storageKey: string;
  externalPrinterId: string;
  copies: number;
  paperSize: string;
  idempotencyKey: string;
  documentType: string;
  title: string;
};

type SubmitStep =
  | { kind: 'stop' }
  | { kind: 'claimed'; print: ClaimedPrint };

@Injectable()
export class PrintProcessor {
  private readonly logger = new Logger(PrintProcessor.name);
  /** Null in production. Tests stall or fail a recording here. */
  hooks: PrintProcessorHooks | null = null;

  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(STORAGE) private readonly storage: StorageAdapter,
    @Inject(PRINT_PROVIDER) private readonly printing: PrintProvider,
  ) {}

  async runSubmit(job: ClaimedJob, external: ExternalJobs): Promise<void> {
    const companyId = requiredCompany(job);
    const payload = submitPayload(job.payload);
    const located = await external.transaction((tx) => this.locate(tx, companyId, payload.printJobId));
    let pdf: Buffer | null = null;
    if (located) {
      try {
        pdf = await readStream(await this.storage.get(located.storageKey));
      } catch (error) {
        const reason = error instanceof StoragePathError || isFsMiss(error) ? 'file_missing' : 'file_unreadable';
        await this.failUnread(external, companyId, payload.printJobId, reason);
        return;
      }
    }
    const step = await external.fenced((tx) => this.claim(tx, job, external, companyId, payload));
    if (step.kind !== 'claimed') {
      return;
    }
    await this.hooks?.afterClaim?.();
    if (!(await this.readyToSubmit(external, job, companyId, payload.printJobId))) {
      return;
    }
    if (!pdf) {
      await this.persist(null, () =>
        this.record(external, job, companyId, payload.printJobId, 'failed', null, null, 'file_missing'),
      );
      return;
    }
    await this.submitClaimed(external, job, companyId, payload.printJobId, step.print, pdf);
  }

  async runRefresh(job: ClaimedJob, external: ExternalJobs): Promise<void> {
    const companyId = requiredCompany(job);
    const printJobId = refreshTarget(job.payload);
    const ready = await external.fenced(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; status: string; providerJobId: string | null }[]>`
        SELECT id, status::text AS status, provider_job_id AS "providerJobId"
        FROM print_job
        WHERE company_id = ${companyId}::uuid AND id = ${printJobId}::uuid
        FOR UPDATE
      `;
      const owned = await external.lockQueue(tx);
      if (!owned) {
        throw new LeaseLost();
      }
      const row = rows[0];
      if (!row || (row.status !== 'submitted' && row.status !== 'delivered_to_printer') || !row.providerJobId) {
        await finishOrLose(external, tx, 'succeeded', null);
        return null;
      }
      return row.providerJobId;
    });
    if (!ready) {
      return;
    }
    const state = await this.printing.getJobState(ready);
    await external.transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM print_job
        WHERE company_id = ${companyId}::uuid AND id = ${printJobId}::uuid
        FOR UPDATE
      `;
      await this.hooks?.duringRecord?.();
      await tx.$queryRaw`SELECT id FROM job WHERE id = ${job.id}::uuid FOR UPDATE`;
      const next = state === 'done' ? 'done_reported' : 'delivered_to_printer';
      const updated = await tx.$queryRaw<{ id: string }[]>`
        UPDATE print_job
        SET status = ${next}::"print_job_status",
            provider_state = ${state},
            completed_at = CASE
              WHEN ${next} = 'done_reported' THEN clock_timestamp()
              ELSE completed_at
            END,
            updated_at = clock_timestamp()
        WHERE company_id = ${companyId}::uuid
          AND id = ${printJobId}::uuid
          AND status::text IN ('submitted', 'delivered_to_printer')
        RETURNING id
      `;
      if (updated.length > 0) {
        await this.audit.record(tx, {
          companyId,
          actorType: 'system',
          actorLabel: 'job-runner',
          action: next === 'done_reported' ? 'print_job.done_reported' : 'print_job.delivered_to_printer',
          objectType: 'print_job',
          objectId: printJobId,
          outcome: 'success',
          details: { providerState: state, provider: 'mock' },
        });
      }
      if (state !== 'done' && updated.length > 0) {
        await enqueueRefresh(tx, companyId, printJobId, job.correlationId, true);
      }
      await external.finish(tx, 'succeeded', null);
    });
  }

  private async claim(
    tx: TenantTransaction,
    job: ClaimedJob,
    external: ExternalJobs,
    companyId: string,
    payload: SubmitPayload,
  ): Promise<SubmitStep> {
    const locked = await tx.$queryRaw<{ id: string; status: string; sourceId: string; documentType: string }[]>`
      SELECT id,
             status::text AS status,
             source_id AS "sourceId",
             document_type AS "documentType"
      FROM print_job
      WHERE company_id = ${companyId}::uuid AND id = ${payload.printJobId}::uuid
      FOR UPDATE
    `;
    const owned = await external.lockQueue(tx);
    if (!owned) {
      throw new LeaseLost();
    }
    const print = locked[0];
    if (!print || print.status !== 'queued') {
      await finishOrLose(external, tx, 'cancelled', 'print_not_queued');
      return { kind: 'stop' };
    }
    const enabled = await switchesOn(tx, companyId);
    if (!enabled) {
      const held = await tx.$queryRaw<{ id: string }[]>`
        UPDATE print_job
        SET status = 'held'::"print_job_status",
            last_error = 'printing_disabled',
            updated_at = clock_timestamp()
        WHERE company_id = ${companyId}::uuid
          AND id = ${print.id}::uuid
          AND status = 'queued'::"print_job_status"
        RETURNING id
      `;
      if (held.length === 0) {
        await finishOrLose(external, tx, 'cancelled', 'print_not_queued');
        return { kind: 'stop' };
      }
      await this.audit.record(tx, {
        companyId,
        actorType: 'system',
        actorLabel: 'job-runner',
        action: 'print_job.held',
        objectType: 'print_job',
        objectId: print.id,
        outcome: 'success',
        details: { reason: 'printing_disabled' },
      });
      await finishOrLose(external, tx, 'held', 'printing_disabled');
      return { kind: 'stop' };
    }
    const order = await tx.salesOrder.findFirst({
      where: { id: print.sourceId, companyId },
      select: { id: true, externalNumber: true, storeId: true },
    });
    const store = order
      ? await tx.store.findFirst({
          where: { id: order.storeId, companyId },
          select: { locationId: true },
        })
      : null;
    const permission = payload.isReprint ? 'print.reprint' : 'print.submit';
    const requesterOk =
      order !== null &&
      store !== null &&
      (await stillAuthorised(tx, companyId, payload.requestedById, permission, order.storeId, store.locationId));
    const releaserOk =
      payload.releasedById === null ||
      (order !== null &&
        store !== null &&
        (await stillAuthorised(
          tx,
          companyId,
          payload.releasedById,
          'automation.replay',
          order.storeId,
          store.locationId,
        )));
    if (!requesterOk || !releaserOk) {
      const failed = await tx.$queryRaw<{ id: string }[]>`
        UPDATE print_job
        SET status = 'failed'::"print_job_status",
            last_error = 'requester_no_longer_authorised',
            updated_at = clock_timestamp()
        WHERE company_id = ${companyId}::uuid
          AND id = ${print.id}::uuid
          AND status = 'queued'::"print_job_status"
        RETURNING id
      `;
      if (failed.length > 0) {
        await this.audit.record(tx, {
          companyId,
          actorType: 'system',
          actorLabel: 'job-runner',
          action: 'print_job.failed',
          objectType: 'print_job',
          objectId: print.id,
          outcome: 'failure',
          details: {
            reason: 'requester_no_longer_authorised',
            check: !order || !store ? 'order' : requesterOk ? 'releaser' : 'requester',
          },
        });
      }
      await finishOrLose(external, tx, 'failed', 'requester_no_longer_authorised');
      return { kind: 'stop' };
    }
    const claimed = await tx.$queryRaw<
      {
        id: string;
        fileId: string | null;
        copies: number;
        paperSize: string;
        idempotencyKey: string;
        printerId: string;
        documentType: string;
      }[]
    >`
      UPDATE print_job
      SET status = 'submitting'::"print_job_status",
          attempts = attempts + 1,
          updated_at = clock_timestamp()
      WHERE company_id = ${companyId}::uuid
        AND id = ${print.id}::uuid
        AND status = 'queued'::"print_job_status"
      RETURNING id,
                file_id AS "fileId",
                copies,
                paper_size AS "paperSize",
                idempotency_key AS "idempotencyKey",
                printer_id AS "printerId",
                document_type AS "documentType"
    `;
    const row = claimed[0];
    if (!row?.fileId) {
      await finishOrLose(external, tx, 'cancelled', 'print_not_queued');
      return { kind: 'stop' };
    }
    const file = await tx.storedFile.findFirst({
      where: { id: row.fileId, companyId },
      select: { storageKey: true },
    });
    const printer = await tx.printer.findFirst({
      where: { id: row.printerId, companyId },
      select: { externalPrinterId: true },
    });
    if (!file || !printer) {
      await tx.$executeRaw`
        UPDATE print_job
        SET status = 'failed'::"print_job_status",
            last_error = 'file_missing',
            updated_at = clock_timestamp()
        WHERE company_id = ${companyId}::uuid AND id = ${row.id}::uuid
      `;
      await this.audit.record(tx, {
        companyId,
        actorType: 'system',
        actorLabel: 'job-runner',
        action: 'print_job.failed',
        objectType: 'print_job',
        objectId: row.id,
        outcome: 'failure',
        details: { reason: 'file_missing' },
      });
      await finishOrLose(external, tx, 'failed', 'file_missing');
      return { kind: 'stop' };
    }
    await this.audit.record(tx, {
      companyId,
      actorType: 'system',
      actorLabel: 'job-runner',
      action: 'print_job.submitting',
      objectType: 'print_job',
      objectId: row.id,
      outcome: 'success',
      details: { provider: 'mock' },
    });
    return {
      kind: 'claimed',
      print: {
        printJobId: row.id,
        storageKey: file.storageKey,
        externalPrinterId: printer.externalPrinterId,
        copies: row.copies,
        paperSize: row.paperSize,
        idempotencyKey: row.idempotencyKey,
        documentType: row.documentType,
        title: `${row.documentType} ${order.externalNumber}`,
      },
    };
  }

  private async submitClaimed(
    external: ExternalJobs,
    job: ClaimedJob,
    companyId: string,
    printJobId: string,
    print: ClaimedPrint,
    pdf: Buffer,
  ): Promise<void> {
    let submitted: { providerJobId: string };
    try {
      submitted = await this.printing.submit(
        {
          companyId,
          printJobId,
          printerExternalId: print.externalPrinterId,
          pdf,
          copies: print.copies,
          paperSize: print.paperSize,
          title: print.title,
          idempotencyKey: print.idempotencyKey,
        },
        external.signal,
      );
    } catch (error) {
      const outcome = providerOutcome(error);
      await this.persist(null, () =>
        this.record(external, job, companyId, printJobId, outcome.status, null, null, outcome.reason),
      );
      return;
    }
    await this.persist(submitted.providerJobId, () =>
      this.record(external, job, companyId, printJobId, 'submitted', submitted.providerJobId, 'submitted', null),
    );
  }

  private async readyToSubmit(
    external: ExternalJobs,
    job: ClaimedJob,
    companyId: string,
    printJobId: string,
  ): Promise<boolean> {
    if (signalAborted(external.signal)) {
      throw aborted(external.signal);
    }
    const owned = await external.transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT pj.id
        FROM print_job pj
        JOIN job j ON j.id = pj.queue_job_id AND j.company_id = pj.company_id
        WHERE pj.company_id = ${companyId}::uuid
          AND pj.id = ${printJobId}::uuid
          AND pj.status = 'submitting'::"print_job_status"
          AND j.locked_by = ${job.lockedBy}
          AND j.status = 'running'::"job_status"
          AND j.locked_until > clock_timestamp() + interval '10 seconds'
      `;
      return rows.length > 0;
    });
    if (!owned) {
      return false;
    }
    if (signalAborted(external.signal)) {
      throw aborted(external.signal);
    }
    return true;
  }

  private async locate(
    tx: TenantTransaction,
    companyId: string,
    printJobId: string,
  ): Promise<{ storageKey: string } | null> {
    const print = await tx.printJob.findFirst({
      where: { id: printJobId, companyId, status: 'queued' },
      select: { fileId: true },
    });
    if (!print?.fileId) {
      return null;
    }
    const file = await tx.storedFile.findFirst({
      where: { id: print.fileId, companyId },
      select: { storageKey: true },
    });
    return file ? { storageKey: file.storageKey } : null;
  }

  private async failUnread(
    external: ExternalJobs,
    companyId: string,
    printJobId: string,
    reason: string,
  ): Promise<void> {
    await external.fenced(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id
        FROM print_job
        WHERE company_id = ${companyId}::uuid AND id = ${printJobId}::uuid
        FOR UPDATE
      `;
      const owned = await external.lockQueue(tx);
      if (!owned) {
        throw new LeaseLost();
      }
      if (rows.length === 0) {
        await finishOrLose(external, tx, 'cancelled', 'print_not_queued');
        return;
      }
      const updated = await tx.$queryRaw<{ id: string }[]>`
        UPDATE print_job
        SET status = 'failed'::"print_job_status",
            last_error = ${reason},
            updated_at = clock_timestamp()
        WHERE company_id = ${companyId}::uuid
          AND id = ${printJobId}::uuid
          AND status = 'queued'::"print_job_status"
        RETURNING id
      `;
      if (updated.length === 0) {
        await finishOrLose(external, tx, 'cancelled', 'print_not_queued');
        return;
      }
      await this.audit.record(tx, {
        companyId,
        actorType: 'system',
        actorLabel: 'job-runner',
        action: 'print_job.failed',
        objectType: 'print_job',
        objectId: printJobId,
        outcome: 'failure',
        details: { reason },
      });
      await finishOrLose(external, tx, 'failed', reason);
    });
  }

  /**
   * Retries only the database settlement. A recording error is not a provider outcome
   * and does not submit again. After three failures the row stays for reclaim.
   */
  private async persist(providerJobId: string | null, write: () => Promise<void>): Promise<void> {
    let last: unknown;
    for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt += 1) {
      try {
        await write();
        return;
      } catch (error) {
        last = error;
        if (attempt < RECORD_ATTEMPTS) {
          await delay(50 * attempt);
        }
      }
    }
    const message = last instanceof Error ? last.message : 'recording_failed';
    this.logger.error(
      `print provider result was not recorded providerJobId=${providerJobId ?? 'none'} error=${message}`,
    );
  }

  private async record(
    external: ExternalJobs,
    job: ClaimedJob,
    companyId: string,
    printJobId: string,
    status: 'submitted' | 'failed' | 'uncertain',
    providerJobId: string | null,
    providerState: string | null,
    lastError: string | null,
  ): Promise<void> {
    const queueStatus: QueueFinish = status === 'submitted' ? 'succeeded' : status;
    await external.transaction(async (tx) => {
      await this.hooks?.beforeRecord?.();
      const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status::text AS status
        FROM print_job
        WHERE company_id = ${companyId}::uuid AND id = ${printJobId}::uuid
        FOR UPDATE
      `;
      await this.hooks?.duringRecord?.();
      await tx.$queryRaw`SELECT id FROM job WHERE id = ${job.id}::uuid FOR UPDATE`;
      const current = locked[0]?.status ?? null;
      let applied = false;
      if (current === 'submitting') {
        const updated = await tx.$queryRaw<{ id: string }[]>`
          UPDATE print_job
          SET status = ${status}::"print_job_status",
              provider_job_id = ${providerJobId},
              provider_state = ${providerState},
              last_error = ${lastError},
              submitted_at = CASE
                WHEN ${status} = 'submitted' THEN clock_timestamp()
                ELSE submitted_at
              END,
              completed_at = CASE
                WHEN ${status} IN ('failed', 'uncertain') THEN clock_timestamp()
                ELSE completed_at
              END,
              updated_at = clock_timestamp()
          WHERE company_id = ${companyId}::uuid
            AND id = ${printJobId}::uuid
            AND status = 'submitting'::"print_job_status"
          RETURNING id
        `;
        applied = updated.length > 0;
        if (applied && status === 'submitted') {
          await enqueueRefresh(tx, companyId, printJobId, job.correlationId, false);
        }
      } else if (current === 'uncertain' && providerJobId) {
        await tx.$executeRaw`
          UPDATE print_job
          SET provider_job_id = COALESCE(provider_job_id, ${providerJobId}),
              provider_state = COALESCE(provider_state, ${providerState}),
              updated_at = clock_timestamp()
          WHERE company_id = ${companyId}::uuid
            AND id = ${printJobId}::uuid
            AND status = 'uncertain'::"print_job_status"
            AND provider_job_id IS NULL
        `;
      }
      await this.audit.record(tx, {
        companyId,
        actorType: 'system',
        actorLabel: 'job-runner',
        action: `print_job.${status}`,
        objectType: 'print_job',
        objectId: printJobId,
        outcome: status === 'submitted' ? 'success' : 'failure',
        details: {
          provider: 'mock',
          providerJobId,
          applied,
          ...(lastError ? { reason: lastError } : {}),
        },
      });
      await external.finish(tx, applied ? queueStatus : 'uncertain', lastError);
    });
  }
}

function providerOutcome(error: unknown): { status: 'failed' | 'uncertain'; reason: string } {
  if (error instanceof PrinterOffline) {
    return { status: 'failed', reason: 'printer_offline' };
  }
  if (error instanceof ProviderRejected) {
    return { status: 'failed', reason: 'provider_rejected' };
  }
  if (error instanceof ProviderTimeout) {
    return { status: 'uncertain', reason: 'provider_timeout' };
  }
  return { status: 'uncertain', reason: 'provider_unknown' };
}

function signalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function aborted(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException('The operation was aborted', 'AbortError');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function finishOrLose(
  external: ExternalJobs,
  tx: TenantTransaction,
  status: QueueFinish,
  lastError: string | null,
): Promise<void> {
  const finished = await external.finish(tx, status, lastError);
  if (!finished) {
    throw new LeaseLost();
  }
}

async function switchesOn(tx: TenantTransaction, companyId: string): Promise<boolean> {
  const outbound = await tx.automationSwitch.findFirst({
    where: { companyId: null, key: 'outbound.all' },
    select: { enabled: true },
  });
  const printing = await tx.automationSwitch.findFirst({
    where: { companyId, key: 'printing' },
    select: { enabled: true },
  });
  return outbound?.enabled === true && printing?.enabled === true;
}

async function stillAuthorised(
  tx: TenantTransaction,
  companyId: string,
  userId: string,
  permission: string,
  storeId: string,
  locationId: string,
): Promise<boolean> {
  const user = await tx.userAccount.findFirst({
    where: { id: userId },
    select: { status: true },
  });
  if (!user || user.status !== 'active') {
    return false;
  }
  const membership = await tx.membership.findFirst({
    where: { userId, companyId, status: 'active' },
    select: { id: true },
  });
  if (!membership) {
    return false;
  }
  const grants = await grantsForMembership(tx, membership.id);
  if (permission === 'automation.replay') {
    return can(grants, permission);
  }
  return can(grants, permission, orderScopes(storeId, locationId));
}

async function enqueueRefresh(
  tx: TenantTransaction,
  companyId: string,
  printJobId: string,
  correlationId: string,
  followUp: boolean,
): Promise<void> {
  const id = uuidv7();
  const key = followUp ? `print.refresh:${printJobId}:${id}` : `print.refresh:${printJobId}`;
  const payload = JSON.stringify({ printJobId });
  await tx.$executeRaw`
    INSERT INTO job (
      id, company_id, type, payload, status, attempts, max_attempts, run_after,
      timeout_ms, correlation_id, idempotency_key, created_at, updated_at
    ) VALUES (
      ${id}::uuid,
      ${companyId}::uuid,
      'print.refresh_status',
      ${payload}::jsonb,
      'queued'::"job_status",
      0,
      ${REFRESH_ATTEMPTS},
      clock_timestamp() + interval '2 seconds',
      ${REFRESH_TIMEOUT_MS},
      ${correlationId},
      ${key},
      clock_timestamp(),
      clock_timestamp()
    )
    ON CONFLICT (idempotency_key) DO NOTHING
  `;
}

function requiredCompany(job: ClaimedJob): string {
  if (!job.companyId) {
    throw new Error('job_missing_company');
  }
  return job.companyId;
}

function submitPayload(value: unknown): SubmitPayload {
  if (typeof value !== 'object' || value === null) {
    throw new Error('print_payload_invalid');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.printJobId !== 'string' || typeof record.requestedById !== 'string') {
    throw new Error('print_payload_invalid');
  }
  return {
    printJobId: record.printJobId,
    requestedById: record.requestedById,
    releasedById: typeof record.releasedById === 'string' ? record.releasedById : null,
    isReprint: record.isReprint === true,
  };
}

function refreshTarget(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    throw new Error('print_payload_invalid');
  }
  const printJobId = (value as Record<string, unknown>).printJobId;
  if (typeof printJobId !== 'string') {
    throw new Error('print_payload_invalid');
  }
  return printJobId;
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      chunks.push(toBuffer(chunk));
    }
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return Buffer.concat(chunks);
}

function toBuffer(chunk: unknown): Buffer {
  if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  throw new Error('storage returned an unexpected chunk');
}

function isFsMiss(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ELOOP' || error.code === 'ENOTDIR')
  );
}
