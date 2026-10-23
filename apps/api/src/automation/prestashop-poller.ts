import { Inject, Injectable } from '@nestjs/common';
import type { TenantTransaction } from '@bp/db';
import { instantToWallTimeInZone, wallTimeInZoneToInstant } from '@bp/domain';
import {
  PrestashopAuthFailed,
  PrestashopBadResponse,
  SafeFetchError,
  buildPrestashopOrderPayload,
  createPrestashopClient,
  type PrestashopClient,
  type PrestashopOrder,
  type SafeFetch,
} from '@bp/integrations';
import { AuditService } from '../audit/audit.service';
import { isUuid } from '../authz/company-path';
import {
  PrestashopConnections,
  PrestashopCredentialUnavailable,
  type OpenedPrestashopConnection,
} from '../integrations/prestashop-connections';
import { SAFE_FETCH } from '../outbound/outbound.module';
import { insertInboxAndEnqueue } from './inbox-insert';
import type { ClaimedJob, ExternalJobs, QueueFinish } from './jobs/job-runner';

const PAGE_LIMIT = 100;
const COUNTED_PAGE_LIMIT = 20;
const OVERLAP_PAGE_LIMIT = 50;
const OVERLAP_MS = 10 * 60 * 1000;
const HORIZON_MS = 24 * 60 * 60 * 1000;
const CODE = /^[a-z][a-z0-9_]*$/;

export type PrestashopPollHooks = {
  /**
   * Test seam. Runs after a page's inbox rows commit and before the checkpoint
   * write. Production leaves `hooks` null.
   */
  beforeCheckpoint?: () => Promise<void>;
};

type Counts = {
  newEvents: number;
  duplicates: number;
};

/**
 * Reads one PrestaShop connection and writes inbox rows. Nothing is written to the shop.
 * The key, the Authorization header and response bodies are never logged.
 * A lost lease finishes the queue job as failed from the runner; this handler
 * always releases the connection lease it acquired.
 */
@Injectable()
export class PrestashopPoller {
  hooks: PrestashopPollHooks | null = null;

  constructor(
    @Inject(PrestashopConnections) private readonly connections: PrestashopConnections,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SAFE_FETCH) private readonly fetch: SafeFetch,
  ) {}

  async run(job: ClaimedJob, external: ExternalJobs): Promise<void> {
    const companyId = job.companyId;
    const connectionId = readConnectionId(job.payload);
    if (!companyId || !connectionId) {
      await this.finishOnly(external, 'failed', 'invalid_job_payload');
      return;
    }
    let heldUntil: string | null = null;
    try {
      heldUntil = await this.acquire(external, companyId, connectionId);
      if (heldUntil === null) {
        await this.finishOnly(external, 'succeeded', null);
        return;
      }
      try {
        await this.poll(job, external, companyId, connectionId);
      } catch (error) {
        if (isAbort(error, external.signal)) {
          throw error;
        }
        await this.settleError(external, companyId, connectionId, error);
      }
    } finally {
      if (heldUntil !== null) {
        await this.release(external, companyId, connectionId, heldUntil);
      }
    }
  }

  private async poll(
    job: ClaimedJob,
    external: ExternalJobs,
    companyId: string,
    connectionId: string,
  ): Promise<void> {
    const opened = await this.connections.open(companyId, connectionId);
    const client = createPrestashopClient({
      fetch: this.fetch,
      baseUrl: opened.settings.baseUrl,
      apiKey: opened.apiKey,
    });
    const counts = await this.importOrders(job, external, client, companyId, connectionId, opened);
    await this.markSuccess(external, companyId, connectionId, counts);
  }

  private async importOrders(
    job: ClaimedJob,
    external: ExternalJobs,
    client: PrestashopClient,
    companyId: string,
    connectionId: string,
    opened: OpenedPrestashopConnection,
  ): Promise<Counts> {
    const counts: Counts = { newEvents: 0, duplicates: 0 };
    const timeZone = opened.settings.timezone;
    const checkpoint = readCheckpoint(opened.checkpoint, timeZone);
    if (checkpoint.kind === 'invalid') {
      await this.noteCheckpointReset(external, companyId, connectionId);
    }
    const startCheckpoint =
      checkpoint.kind === 'valid' ? checkpoint.dateUpd : opened.settings.firstImportFrom;
    let persisted = checkpoint.kind === 'valid' ? checkpoint.dateUpd : null;
    const states = await client.getOrderStates();
    let from = minusOverlap(startCheckpoint, timeZone);
    const to = instantToWallTimeInZone(new Date(Date.now() + HORIZON_MS), timeZone);
    // Pages at or before the checkpoint this run started with are the overlap.
    // They do not count toward the 20-page cap. Fifty of them is overlap_too_large.
    // A short page, or 20 counted pages, ends the run as a success.
    let countedPages = 0;
    let overlapPages = 0;
    const pageBound = COUNTED_PAGE_LIMIT + OVERLAP_PAGE_LIMIT;
    for (let read = 0; read < pageBound; read += 1) {
      if (external.signal.aborted) {
        throw abortError(external.signal);
      }
      const orders = await client.listOrdersUpdatedBetween({
        from,
        to,
        offset: 0,
        limit: PAGE_LIMIT,
      });
      if (orders.length === 0) {
        return counts;
      }
      const customers = await client.getCustomers(uniqueIds(orders.map((order) => order.id_customer)));
      const addresses = await client.getAddresses(
        uniqueIds(orders.flatMap((order) => [order.id_address_delivery, order.id_address_invoice])),
      );
      const countries = await client.getCountries(uniqueIds(addresses.map((address) => address.id_country)));
      const carriers = await client.getCarriers(uniqueIds(orders.map((order) => order.id_carrier)));
      const currencies = await client.getCurrencies(uniqueIds(orders.map((order) => order.id_currency)));
      const lookups = { customers, addresses, countries, carriers, currencies, states };
      for (const order of orders) {
        const payload = buildPrestashopOrderPayload(order, lookups);
        const saved = await external.transaction((tx) =>
          insertInboxAndEnqueue(tx, {
            companyId,
            connectionId,
            provider: 'prestashop',
            externalEventId: `order:${order.id}:${order.date_upd}`,
            topic: 'orders/updated',
            externalObjectId: order.id,
            sourceUpdatedAt: wallTimeInZoneToInstant(order.date_upd, timeZone),
            payload,
            correlationId: job.correlationId,
            serviceIdentityId: null,
            actorLabel: null,
            enqueueReceivedDuplicates: false,
          }),
        );
        if (saved.duplicateCount === 0) {
          counts.newEvents += 1;
        } else {
          counts.duplicates += 1;
        }
      }
      const last = lastDateUpd(orders);
      if (orders.length === PAGE_LIMIT && last === from) {
        throw new TooManyInOneSecond();
      }
      await this.hooks?.beforeCheckpoint?.();
      const floor = persisted ?? opened.settings.firstImportFrom;
      if (last > floor) {
        await this.writeCheckpoint(external, companyId, connectionId, last);
        persisted = last;
      }
      from = last;
      if (orders.length < PAGE_LIMIT) {
        return counts;
      }
      if (last > startCheckpoint) {
        countedPages += 1;
        if (countedPages >= COUNTED_PAGE_LIMIT) {
          return counts;
        }
      } else {
        overlapPages += 1;
        if (overlapPages >= OVERLAP_PAGE_LIMIT) {
          throw new OverlapTooLarge();
        }
      }
    }
    throw new Error('poll_failed');
  }

  private async markSuccess(
    external: ExternalJobs,
    companyId: string,
    connectionId: string,
    counts: Counts,
  ): Promise<void> {
    await external.transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE store_connection
        SET last_sync_at = now(),
            last_error_class = NULL,
            last_error_at = NULL
        WHERE company_id = ${companyId}::uuid
          AND id = ${connectionId}::uuid
      `;
      if (counts.newEvents > 0) {
        await this.audit.record(tx, {
          companyId,
          actorType: 'system',
          actorId: null,
          actorLabel: 'prestashop.poll',
          action: 'store.sync_imported',
          objectType: 'store_connection',
          objectId: connectionId,
          outcome: 'success',
          details: {
            connectionId,
            newEvents: counts.newEvents,
            duplicates: counts.duplicates,
          },
        });
      }
      await this.finish(external, tx, 'succeeded', null);
    });
  }

  private async settleError(
    external: ExternalJobs,
    companyId: string,
    connectionId: string,
    error: unknown,
  ): Promise<void> {
    if (error instanceof PrestashopAuthFailed) {
      await this.markAuthFailed(external, companyId, connectionId);
      return;
    }
    const unavailable = error instanceof PrestashopCredentialUnavailable;
    await this.markFailed(external, companyId, connectionId, errorCode(error), !unavailable);
  }

  private async markAuthFailed(
    external: ExternalJobs,
    companyId: string,
    connectionId: string,
  ): Promise<void> {
    await external.transaction(async (tx) => {
      const changed = await tx.$queryRaw<{ id: string }[]>`
        UPDATE store_connection
        SET status = 'auth_failed',
            last_error_class = 'auth_failed',
            last_error_at = now()
        WHERE company_id = ${companyId}::uuid
          AND id = ${connectionId}::uuid
          AND status IS DISTINCT FROM 'auth_failed'
        RETURNING id
      `;
      if (changed.length === 1) {
        await this.audit.record(tx, {
          companyId,
          actorType: 'system',
          actorId: null,
          actorLabel: 'prestashop.poll',
          action: 'store.connection_paused',
          objectType: 'store_connection',
          objectId: connectionId,
          outcome: 'success',
          details: { reason: 'auth_failed' },
        });
      }
      await this.finish(external, tx, 'succeeded', null);
    });
  }

  private async noteCheckpointReset(
    external: ExternalJobs,
    companyId: string,
    connectionId: string,
  ): Promise<void> {
    await external.transaction(async (tx) => {
      await this.recordFailure(tx, companyId, connectionId, 'checkpoint_reset', true);
      // The invalid value can sort after a real shop time and block every later write.
      await tx.$executeRaw`
        UPDATE store_connection
        SET sync_checkpoint = NULL
        WHERE company_id = ${companyId}::uuid
          AND id = ${connectionId}::uuid
      `;
    });
  }

  private async markFailed(
    external: ExternalJobs,
    companyId: string,
    connectionId: string,
    code: string,
    audit: boolean,
  ): Promise<void> {
    await external.transaction(async (tx) => {
      await this.recordFailure(tx, companyId, connectionId, code, audit);
      await this.finish(external, tx, 'failed', code);
    });
  }

  private async recordFailure(
    tx: TenantTransaction,
    companyId: string,
    connectionId: string,
    code: string,
    audit: boolean,
  ): Promise<void> {
    const current = await tx.storeConnection.findFirst({
      where: { id: connectionId, companyId },
      select: { lastErrorClass: true },
    });
    const changed = current !== null && current.lastErrorClass !== code;
    await tx.$executeRaw`
      UPDATE store_connection
      SET last_error_class = ${code},
          last_error_at = now()
      WHERE company_id = ${companyId}::uuid
        AND id = ${connectionId}::uuid
    `;
    if (audit && changed) {
      await this.audit.record(tx, {
        companyId,
        actorType: 'system',
        actorId: null,
        actorLabel: 'prestashop.poll',
        action: 'store.sync_failed',
        objectType: 'store_connection',
        objectId: connectionId,
        outcome: 'failure',
        details: { connectionId, errorClass: code },
      });
    }
  }

  private async writeCheckpoint(
    external: ExternalJobs,
    companyId: string,
    connectionId: string,
    dateUpd: string,
  ): Promise<void> {
    const checkpoint = JSON.stringify({ dateUpd });
    await external.transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE store_connection
        SET sync_checkpoint = ${checkpoint}::jsonb
        WHERE company_id = ${companyId}::uuid
          AND id = ${connectionId}::uuid
          AND (
            sync_checkpoint->>'dateUpd' IS NULL
            OR sync_checkpoint->>'dateUpd' < ${dateUpd}
          )
      `;
    });
  }

  private async acquire(
    external: ExternalJobs,
    companyId: string,
    connectionId: string,
  ): Promise<string | null> {
    return external.transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ sync_locked_until: string }[]>`
        UPDATE store_connection
        SET sync_locked_until = now() + interval '5 minutes'
        WHERE company_id = ${companyId}::uuid
          AND id = ${connectionId}::uuid
          AND status = 'active'
          AND (sync_locked_until IS NULL OR sync_locked_until < now())
        RETURNING sync_locked_until::text AS sync_locked_until
      `;
      return rows[0]?.sync_locked_until ?? null;
    });
  }

  private async release(
    external: ExternalJobs,
    companyId: string,
    connectionId: string,
    heldUntil: string,
  ): Promise<void> {
    await external.transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE store_connection
        SET sync_locked_until = NULL
        WHERE company_id = ${companyId}::uuid
          AND id = ${connectionId}::uuid
          AND sync_locked_until = ${heldUntil}::timestamptz
      `;
    });
  }

  private async finishOnly(
    external: ExternalJobs,
    status: QueueFinish,
    lastError: string | null,
  ): Promise<void> {
    await external.transaction(async (tx) => {
      await this.finish(external, tx, status, lastError);
    });
  }

  private async finish(
    external: ExternalJobs,
    tx: TenantTransaction,
    status: QueueFinish,
    lastError: string | null,
  ): Promise<void> {
    const finished = await external.finish(tx, status, lastError);
    if (!finished) {
      throw new Error('lease_lost');
    }
  }
}

class TooManyInOneSecond extends Error {
  override readonly name = 'TooManyInOneSecond';
  readonly code = 'too_many_in_one_second';

  constructor() {
    super('too_many_in_one_second');
  }
}

class OverlapTooLarge extends Error {
  override readonly name = 'OverlapTooLarge';
  readonly code = 'overlap_too_large';

  constructor() {
    super('overlap_too_large');
  }
}

function readConnectionId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('connectionId' in payload)) {
    return null;
  }
  const connectionId = payload.connectionId;
  if (typeof connectionId !== 'string' || !isUuid(connectionId)) {
    return null;
  }
  return connectionId.toLowerCase();
}

type CheckpointRead = { kind: 'missing' } | { kind: 'valid'; dateUpd: string } | { kind: 'invalid' };

function readCheckpoint(value: unknown, timeZone: string): CheckpointRead {
  if (value === null || value === undefined) {
    return { kind: 'missing' };
  }
  if (typeof value !== 'object' || Array.isArray(value) || !('dateUpd' in value)) {
    return { kind: 'invalid' };
  }
  const dateUpd = value.dateUpd;
  if (typeof dateUpd !== 'string') {
    return { kind: 'invalid' };
  }
  try {
    wallTimeInZoneToInstant(dateUpd, timeZone);
  } catch {
    return { kind: 'invalid' };
  }
  return { kind: 'valid', dateUpd };
}

function minusOverlap(checkpoint: string, timeZone: string): string {
  const instant = wallTimeInZoneToInstant(checkpoint, timeZone);
  return instantToWallTimeInZone(new Date(instant.getTime() - OVERLAP_MS), timeZone);
}

function lastDateUpd(orders: readonly PrestashopOrder[]): string {
  const last = orders[orders.length - 1];
  if (!last) {
    throw new Error('poll_failed');
  }
  return last.date_upd;
}

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

function errorCode(error: unknown): string {
  if (error instanceof SafeFetchError || error instanceof PrestashopBadResponse) {
    return error.code;
  }
  if (isCoded(error) && CODE.test(error.code)) {
    return error.code;
  }
  if (error instanceof Error && CODE.test(error.message)) {
    return error.message;
  }
  return 'poll_failed';
}

function isCoded(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string';
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) {
    return false;
  }
  if (error === signal.reason) {
    return true;
  }
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException('The operation was aborted', 'AbortError');
}
