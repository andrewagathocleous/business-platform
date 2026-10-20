import { Inject, Injectable } from '@nestjs/common';
import type { TenantTransaction } from '@bp/db';
import { getCorrelationId } from '../correlation/correlation';
import { PrismaService } from '../database/prisma.service';
import { redactDetails, type JsonValue } from './redact-details';

export type AuditActorType = 'user' | 'service' | 'system';
export type AuditOutcome = 'success' | 'denied' | 'failure';

export type AuditRecord = {
  companyId?: string | null;
  actorType: AuditActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  objectType: string;
  objectId?: string | null;
  outcome: AuditOutcome;
  ip?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown> | null;
};

@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Writes one audit row on the caller's transaction so the change and the
   * audit row commit or roll back together. The correlation id comes from
   * AsyncLocalStorage, not from the caller.
   */
  async record(tx: TenantTransaction, input: AuditRecord): Promise<void> {
    const correlationId = getCorrelationId();
    if (!correlationId) {
      throw new Error('audit record requires a correlation id');
    }
    // INSERT ... RETURNING is also checked against the SELECT policy.
    // A platform row (no company) is visible only while platform scope is on.
    if (input.companyId == null) {
      await tx.$queryRaw`SELECT set_config('app.platform_scope', 'on', true)`;
    }
    await tx.auditEvent.create({
      data: {
        companyId: input.companyId ?? null,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        actorLabel: input.actorLabel ?? null,
        action: input.action,
        objectType: input.objectType,
        objectId: input.objectId ?? null,
        outcome: input.outcome,
        correlationId,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        details: redactDetails(input.details ?? {}),
      },
    });
  }

  /** Denials are recorded in their own transaction, after the rejected change has ended. */
  async recordDenial(input: Omit<AuditRecord, 'outcome'>): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      // This transaction does not inherit the caller's company setting.
      if (input.companyId) {
        await tx.$queryRaw`SELECT set_config('app.company_id', ${input.companyId}, true)`;
      }
      await this.record(tx, { ...input, outcome: 'denied' });
    });
  }
}

export type { JsonValue };
