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
import { getCorrelationId } from '../correlation/correlation';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';
import { insertInboxAndEnqueue } from './inbox-insert';

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
        const seam = hooks ?? this.hooks;
        const row = await insertInboxAndEnqueue(tx, {
          companyId: ctx.companyId,
          connectionId: connection.id,
          provider: connection.store.platform,
          externalEventId: body.eventId,
          topic: body.topic,
          externalObjectId: identity.externalId,
          sourceUpdatedAt: identity.sourceUpdatedAt,
          payload: body.payload,
          correlationId,
          serviceIdentityId: ctx.serviceIdentityId,
          actorLabel: ctx.actorLabel,
          enqueueReceivedDuplicates: true,
          afterInsert: async () => {
            if (seam?.afterInboxInsert) {
              await seam.afterInboxInsert();
            }
          },
          onDuplicate: async (inserted) => {
            await this.audit.record(tx, {
              companyId: ctx.companyId,
              actorType: 'service',
              actorId: ctx.serviceIdentityId,
              actorLabel: ctx.actorLabel,
              action: 'inbox.duplicate',
              objectType: 'integration_inbox',
              objectId: inserted.id,
              outcome: 'success',
              ip: meta.ip,
              userAgent: meta.userAgent,
              details: {
                duplicateCount: inserted.duplicateCount,
                externalEventId: body.eventId,
                connectionId: connection.id,
              },
            });
          },
        });
        return {
          inboxId: row.id,
          status: row.duplicateCount === 0 ? 'accepted' : 'duplicate',
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
}
