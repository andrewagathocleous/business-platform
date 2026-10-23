import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { TenantDb } from '@bp/db';
import type { RequestContext } from '../authz/request-context';
import { getCorrelationId, uuidv7 } from '../correlation/correlation';
import { PrismaService } from '../database/prisma.service';
import { readPrestashopSettings } from '../integrations/prestashop-settings';

/**
 * One poll may read 50 overlap pages or 20 pages past its checkpoint.
 * The next trigger is the retry, so the job is not retried.
 */
export const PRESTASHOP_POLL_TIMEOUT_MS = 240_000;
export const PRESTASHOP_POLL_ATTEMPTS = 1;

export type StoreSyncCounts = {
  queued: number;
  notDue: number;
  skipped: number;
};

/**
 * Queues a PrestaShop poll for each due live connection.
 * The trigger writes no audit row: it runs every minute and changes no business
 * state. The queue job is the record. That rule is documented in
 * `docs/integrations/prestashop.md`.
 */
@Injectable()
export class StoreSyncService {
  private readonly tenants: TenantDb;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.tenants = new TenantDb(prisma.client);
  }

  async trigger(ctx: RequestContext): Promise<StoreSyncCounts> {
    const correlationId = getCorrelationId();
    const actor = ctx.serviceIdentityId;
    if (!correlationId || !actor) {
      throw new InternalServerErrorException('Actor is missing');
    }
    const now = new Date();
    return this.tenants.run({ companyId: ctx.companyId, actor, correlationId }, async (tx) => {
      const connections = await tx.storeConnection.findMany({
        where: { companyId: ctx.companyId },
        select: {
          id: true,
          status: true,
          mode: true,
          lastSyncAt: true,
          settings: true,
          store: { select: { platform: true } },
        },
      });
      const counts: StoreSyncCounts = { queued: 0, notDue: 0, skipped: 0 };
      for (const connection of connections) {
        if (connection.store.platform !== 'prestashop') {
          continue;
        }
        if (connection.status !== 'active') {
          counts.skipped += 1;
          continue;
        }
        if (connection.mode !== 'live') {
          continue;
        }
        const settings = readPrestashopSettings(connection.settings);
        if (!settings) {
          counts.skipped += 1;
          continue;
        }
        if (!isDue(connection.lastSyncAt, settings.pollIntervalSeconds, now)) {
          counts.notDue += 1;
          continue;
        }
        const key = prestashopPollIdempotencyKey(connection.id, settings.pollIntervalSeconds, now);
        const payload = JSON.stringify({ connectionId: connection.id });
        const inserted = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO job (
            id, company_id, type, payload, status, attempts, max_attempts, run_after,
            timeout_ms, correlation_id, idempotency_key, created_at, updated_at
          ) VALUES (
            ${uuidv7()}::uuid,
            ${ctx.companyId}::uuid,
            'prestashop.poll',
            ${payload}::jsonb,
            'queued'::"job_status",
            0,
            ${PRESTASHOP_POLL_ATTEMPTS},
            clock_timestamp(),
            ${PRESTASHOP_POLL_TIMEOUT_MS},
            ${correlationId},
            ${key},
            clock_timestamp(),
            clock_timestamp()
          )
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING id
        `;
        if (inserted.length === 1) {
          counts.queued += 1;
        }
      }
      return counts;
    });
  }
}

export function prestashopPollIdempotencyKey(
  connectionId: string,
  pollIntervalSeconds: number,
  now: Date,
): string {
  const bucket = Math.floor(now.getTime() / 1000 / pollIntervalSeconds);
  return `prestashop.poll:${connectionId}:${String(bucket)}`;
}

function isDue(lastSyncAt: Date | null, pollIntervalSeconds: number, now: Date): boolean {
  if (lastSyncAt === null) {
    return true;
  }
  return now.getTime() - lastSyncAt.getTime() >= pollIntervalSeconds * 1000;
}
