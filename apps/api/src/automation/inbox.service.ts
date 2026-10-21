import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { readShopifyEventIdentity, ShopifyMapError } from '@bp/integrations';
import { AuditService } from '../audit/audit.service';
import { isUuid } from '../authz/company-path';
import type { RequestContext } from '../authz/request-context';
import { CommerceError, settleCommerceError } from '../commerce/errors';
import { getCorrelationId, uuidv7 } from '../correlation/correlation';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';

export type StoreEventBody = {
  eventId: string;
  topic: 'orders/create' | 'orders/updated';
  occurredAt: string;
  payload: unknown;
};

export type IngestHooks = {
  /** Test seam. Throws inside the ingest transaction, after the inbox insert and before the job insert. */
  afterInboxInsert?: () => Promise<void>;
};

type InboxRow = {
  id: string;
  duplicate_count: number;
  status: string;
};

const INBOX_ATTEMPTS = 5;
const INBOX_TIMEOUT_MS = 30_000;

@Injectable()
export class InboxService {
  private readonly tenants: TenantDb;

  /** Test seam. The HTTP controller does not pass hooks, so tests set this before a request. */
  hooks: IngestHooks | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.tenants = new TenantDb(prisma.client);
  }

  async ingest(
    ctx: RequestContext,
    connectionId: string,
    body: StoreEventBody,
    meta: RequestMeta,
    hooks?: IngestHooks,
  ): Promise<{ inboxId: string; status: 'accepted' | 'duplicate' }> {
    const actor = ctx.serviceIdentityId ?? ctx.userId;
    const correlationId = getCorrelationId();
    if (!actor || !correlationId) {
      throw new InternalServerErrorException('Actor is missing');
    }
    let identity: { externalId: string; sourceUpdatedAt: Date };
    try {
      identity = readShopifyEventIdentity(body.payload);
    } catch (error) {
      if (error instanceof ShopifyMapError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    if (Number.isNaN(new Date(body.occurredAt).getTime())) {
      throw new BadRequestException('occurredAt must be an ISO timestamp');
    }
    try {
      return await this.tenants.run({ companyId: ctx.companyId, actor, correlationId }, async (tx) => {
        const connection = await this.connection(tx, ctx.companyId, connectionId);
        const payload = JSON.stringify(body.payload);
        const inserted = await tx.$queryRaw<InboxRow[]>`
          INSERT INTO integration_inbox (
            id, company_id, connection_id, provider, external_event_id, topic,
            external_object_id, source_updated_at, payload, status, duplicate_count, correlation_id
          ) VALUES (
            ${uuidv7()}::uuid,
            ${ctx.companyId}::uuid,
            ${connection.id}::uuid,
            ${connection.store.platform},
            ${body.eventId},
            ${body.topic},
            ${identity.externalId},
            ${identity.sourceUpdatedAt},
            ${payload}::jsonb,
            'received'::"inbox_status",
            0,
            ${correlationId}
          )
          ON CONFLICT (company_id, connection_id, external_event_id)
          DO UPDATE SET duplicate_count = integration_inbox.duplicate_count + 1
          RETURNING id, duplicate_count, status::text AS status
        `;
        const row = inserted[0];
        if (!row) {
          throw new InternalServerErrorException('Inbox insert returned no row');
        }
        const seam = hooks ?? this.hooks;
        if (seam?.afterInboxInsert) {
          await seam.afterInboxInsert();
        }
        const duplicateCount = row.duplicate_count;
        if (duplicateCount > 0) {
          await this.audit.record(tx, {
            companyId: ctx.companyId,
            actorType: 'service',
            actorId: ctx.serviceIdentityId,
            actorLabel: ctx.actorLabel,
            action: 'inbox.duplicate',
            objectType: 'integration_inbox',
            objectId: row.id,
            outcome: 'success',
            ip: meta.ip,
            userAgent: meta.userAgent,
            details: { duplicateCount, externalEventId: body.eventId, connectionId: connection.id },
          });
        }
        if (duplicateCount === 0 || row.status === 'received') {
          await this.enqueue(tx, ctx, row.id, correlationId);
        }
        return {
          inboxId: row.id,
          status: duplicateCount === 0 ? 'accepted' : 'duplicate',
        } as const;
      });
    } catch (error) {
      if (error instanceof CommerceError) {
        return settleCommerceError(this.audit, this.prisma, ctx, meta, error);
      }
      throw error;
    }
  }

  private async connection(
    tx: TenantTransaction,
    companyId: string,
    connectionId: string,
  ): Promise<{ id: string; store: { platform: string } }> {
    if (!isUuid(connectionId)) {
      throw new CommerceError(404, 'connection_not_found', 'store_connection', null, 'Not found');
    }
    const connection = await tx.storeConnection.findFirst({
      where: { id: connectionId.toLowerCase(), companyId },
      select: { id: true, status: true, mode: true, store: { select: { platform: true } } },
    });
    if (!connection) {
      throw new CommerceError(404, 'connection_not_found', 'store_connection', connectionId.toLowerCase(), 'Not found');
    }
    if (connection.status !== 'active') {
      throw new CommerceError(404, 'connection_not_active', 'store_connection', connection.id, 'Not found');
    }
    if (connection.mode !== 'mock') {
      throw new CommerceError(404, 'connection_not_mock', 'store_connection', connection.id, 'Not found');
    }
    return connection;
  }

  private async enqueue(
    tx: TenantTransaction,
    ctx: RequestContext,
    inboxId: string,
    correlationId: string,
  ): Promise<void> {
    const payload = JSON.stringify({
      inboxId,
      serviceIdentityId: ctx.serviceIdentityId,
      actorLabel: ctx.actorLabel,
    });
    await tx.$executeRaw`
      INSERT INTO job (
        id, company_id, type, payload, status, attempts, max_attempts, run_after,
        timeout_ms, correlation_id, idempotency_key, created_at, updated_at
      ) VALUES (
        ${uuidv7()}::uuid,
        ${ctx.companyId}::uuid,
        'inbox.process',
        ${payload}::jsonb,
        'queued'::"job_status",
        0,
        ${INBOX_ATTEMPTS},
        clock_timestamp(),
        ${INBOX_TIMEOUT_MS},
        ${correlationId},
        ${`inbox:${inboxId}`},
        clock_timestamp(),
        clock_timestamp()
      )
      ON CONFLICT (idempotency_key) DO NOTHING
    `;
  }
}
