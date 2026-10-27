import { Inject, Injectable } from '@nestjs/common';
import { TenantDb } from '@bp/db';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../authz/request-context';
import { CommerceError, settleCommerceError } from '../commerce/errors';
import { requireActor } from '../commerce/http';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';
import { COMPANY_SWITCH_KEYS, isCompanySwitchKey, type CompanySwitchKey } from './company-switches';

const JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'held',
  'uncertain',
  'cancelled',
] as const;

/** Test seam. Runs after the switch row is locked and before it is updated. */
export type SwitchHooks = {
  beforeSwitchWrite?: () => Promise<void>;
};

export type JobStatusFilter = (typeof JOB_STATUSES)[number];

export type SwitchView = {
  key: string;
  enabled: boolean;
  reason: string | null;
  updatedAt: string;
};

export type JobView = {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  finishedAt: string | null;
  createdAt: string;
  correlationId: string;
  lastError: string | null;
};

@Injectable()
export class CompanyAutomationService {
  private readonly tenants: TenantDb;
  /** Test seam. Production leaves it null. */
  hooks: SwitchHooks | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.tenants = new TenantDb(prisma.client);
  }

  async listSwitches(ctx: RequestContext): Promise<{ switches: SwitchView[] }> {
    const rows = await this.tenants.run(this.context(ctx), (tx) =>
      tx.automationSwitch.findMany({
        where: { companyId: ctx.companyId, key: { in: [...COMPANY_SWITCH_KEYS] } },
        orderBy: { key: 'asc' },
      }),
    );
    return {
      switches: rows.map((row) => ({
        key: row.key,
        enabled: row.enabled,
        reason: row.reason,
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  async setSwitch(
    ctx: RequestContext,
    key: string,
    enabled: boolean,
    reason: string,
    meta: RequestMeta,
  ): Promise<{ key: CompanySwitchKey; enabled: boolean; reason: string }> {
    try {
      if (!isCompanySwitchKey(key)) {
        throw new CommerceError(
          404,
          'switch_not_in_company',
          'automation_switch',
          null,
          'Not found',
          undefined,
          { key },
        );
      }
      await this.tenants.run(this.context(ctx), async (tx) => {
        const locked = await tx.$queryRaw<{ id: string; enabled: boolean }[]>`
          SELECT id, enabled
          FROM automation_switch
          WHERE company_id = ${ctx.companyId}::uuid
            AND key = ${key}
          FOR UPDATE
        `;
        const existing = locked[0];
        if (!existing) {
          throw new CommerceError(
            404,
            'switch_not_in_company',
            'automation_switch',
            null,
            'Not found',
            undefined,
            { key },
          );
        }
        await this.hooks?.beforeSwitchWrite?.();
        const written = await tx.automationSwitch.updateMany({
          where: { id: existing.id, companyId: ctx.companyId },
          data: { enabled, reason, updatedById: requireActor(ctx) },
        });
        if (written.count !== 1) {
          throw new CommerceError(
            404,
            'switch_not_in_company',
            'automation_switch',
            existing.id,
            'Not found',
            undefined,
            { key },
          );
        }
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          actorType: 'user',
          actorId: ctx.userId,
          actorLabel: ctx.actorLabel,
          action: 'automation_switch.updated',
          objectType: 'automation_switch',
          objectId: existing.id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: { key, enabled, previousEnabled: existing.enabled, reason },
        });
      });
      return { key, enabled, reason };
    } catch (error) {
      if (error instanceof CommerceError) {
        return settleCommerceError(this.audit, this.prisma, ctx, meta, error);
      }
      throw error;
    }
  }

  async listJobs(
    ctx: RequestContext,
    query: { status?: JobStatusFilter; page: number; pageSize: number },
  ): Promise<{ jobs: JobView[]; page: number; pageSize: number; total: number }> {
    const where = {
      companyId: ctx.companyId,
      ...(query.status ? { status: query.status } : {}),
    };
    const [rows, total] = await this.tenants.run(this.context(ctx), async (tx) => {
      const jobs = await tx.job.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          type: true,
          status: true,
          attempts: true,
          maxAttempts: true,
          runAfter: true,
          finishedAt: true,
          createdAt: true,
          correlationId: true,
          lastError: true,
        },
      });
      const count = await tx.job.count({ where });
      return [jobs, count] as const;
    });
    return {
      jobs: rows.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        runAfter: row.runAfter.toISOString(),
        finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
        correlationId: row.correlationId,
        lastError: row.lastError,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  private context(ctx: RequestContext) {
    return { companyId: ctx.companyId, actor: requireActor(ctx), correlationId: ctx.correlationId };
  }
}

export function isJobStatus(value: string): value is JobStatusFilter {
  return (JOB_STATUSES as readonly string[]).includes(value);
}
