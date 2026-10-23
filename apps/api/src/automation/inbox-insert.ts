import { InternalServerErrorException } from '@nestjs/common';
import type { TenantTransaction } from '@bp/db';
import { uuidv7 } from '../correlation/correlation';

const INBOX_ATTEMPTS = 5;
const INBOX_TIMEOUT_MS = 30_000;

export type InboxInserted = {
  id: string;
  duplicateCount: number;
  status: string;
};

type InboxRow = {
  id: string;
  duplicate_count: number;
  status: string;
};

/**
 * Inserts one inbox row and, when the row should be processed, its `inbox.process` job.
 * The Shopify ingest path and the PrestaShop poll both call this.
 * `enqueueReceivedDuplicates` keeps the Shopify rule: a duplicate that is still
 * `received` is queued again. The poll passes false and queues a fresh insert only.
 * `afterInsert` runs after the insert and before the job insert, so a throw rolls both back.
 */
export async function insertInboxAndEnqueue(
  tx: TenantTransaction,
  input: {
    companyId: string;
    connectionId: string;
    provider: string;
    externalEventId: string;
    topic: string;
    externalObjectId: string;
    sourceUpdatedAt: Date;
    payload: unknown;
    correlationId: string;
    serviceIdentityId: string | null;
    actorLabel: string | null;
    enqueueReceivedDuplicates: boolean;
    afterInsert?: () => Promise<void>;
    onDuplicate?: (row: InboxInserted) => Promise<void>;
  },
): Promise<InboxInserted> {
  const payload = JSON.stringify(input.payload);
  const inserted = await tx.$queryRaw<InboxRow[]>`
    INSERT INTO integration_inbox (
      id, company_id, connection_id, provider, external_event_id, topic,
      external_object_id, source_updated_at, payload, status, duplicate_count, correlation_id
    ) VALUES (
      ${uuidv7()}::uuid,
      ${input.companyId}::uuid,
      ${input.connectionId}::uuid,
      ${input.provider},
      ${input.externalEventId},
      ${input.topic},
      ${input.externalObjectId},
      ${input.sourceUpdatedAt},
      ${payload}::jsonb,
      'received'::"inbox_status",
      0,
      ${input.correlationId}
    )
    ON CONFLICT (company_id, connection_id, external_event_id)
    DO UPDATE SET duplicate_count = integration_inbox.duplicate_count + 1
    RETURNING id, duplicate_count, status::text AS status
  `;
  const row = inserted[0];
  if (!row) {
    throw new InternalServerErrorException('Inbox insert returned no row');
  }
  const saved: InboxInserted = {
    id: row.id,
    duplicateCount: row.duplicate_count,
    status: row.status,
  };
  if (input.afterInsert) {
    await input.afterInsert();
  }
  if (saved.duplicateCount > 0 && input.onDuplicate) {
    await input.onDuplicate(saved);
  }
  const fresh = saved.duplicateCount === 0;
  const stillReceived = input.enqueueReceivedDuplicates && saved.status === 'received';
  if (fresh || stillReceived) {
    await enqueueInboxJob(tx, input, saved.id);
  }
  return saved;
}

async function enqueueInboxJob(
  tx: TenantTransaction,
  input: {
    companyId: string;
    correlationId: string;
    serviceIdentityId: string | null;
    actorLabel: string | null;
  },
  inboxId: string,
): Promise<void> {
  const payload = JSON.stringify({
    inboxId,
    serviceIdentityId: input.serviceIdentityId,
    actorLabel: input.actorLabel,
  });
  await tx.$executeRaw`
    INSERT INTO job (
      id, company_id, type, payload, status, attempts, max_attempts, run_after,
      timeout_ms, correlation_id, idempotency_key, created_at, updated_at
    ) VALUES (
      ${uuidv7()}::uuid,
      ${input.companyId}::uuid,
      'inbox.process',
      ${payload}::jsonb,
      'queued'::"job_status",
      0,
      ${INBOX_ATTEMPTS},
      clock_timestamp(),
      ${INBOX_TIMEOUT_MS},
      ${input.correlationId},
      ${`inbox:${inboxId}`},
      clock_timestamp(),
      clock_timestamp()
    )
    ON CONFLICT (idempotency_key) DO NOTHING
  `;
}
