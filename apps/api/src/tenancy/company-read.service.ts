import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { TenantDb } from '@bp/db';
import { isUuid } from '../authz/company-path';
import { PrismaService } from '../database/prisma.service';
import type { RequestContext } from '../authz/request-context';
import { companyDetails, type CompanyDetails } from './company-details';

const OUTCOMES = ['success', 'denied', 'failure'] as const;

export type AuditQuery = {
  objectType?: string;
  objectId?: string;
  action?: string;
  actorId?: string;
  outcome?: (typeof OUTCOMES)[number];
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
};

export type CompanyContextView = {
  company: CompanyDetails;
  grants: { permission: string; scopeType: string; scopeId: string | null }[];
  switches: { key: string; enabled: boolean }[];
  mfaStepUpRequired: boolean;
  withheldPermissions: string[];
};

@Injectable()
export class CompanyReadService {
  private readonly tenant: TenantDb;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    this.tenant = new TenantDb(prisma.client);
  }

  async context(ctx: RequestContext): Promise<CompanyContextView> {
    const company = await this.prisma.client.company.findUniqueOrThrow({ where: { id: ctx.companyId } });
    const switches = await this.prisma.client.automationSwitch.findMany({
      where: { companyId: ctx.companyId },
      orderBy: { key: 'asc' },
      select: { key: true, enabled: true },
    });
    return {
      company: companyDetails(company),
      grants: ctx.grants.map((grant) => ({
        permission: grant.permission,
        scopeType: grant.scopeType,
        scopeId: grant.scopeId,
      })),
      switches,
      mfaStepUpRequired: ctx.mfaStepUpRequired,
      withheldPermissions: ctx.withheldPermissions,
    };
  }

  async locations(ctx: RequestContext): Promise<{
    locations: { id: string; name: string; address: unknown; timezone: string | null; archivedAt: string | null }[];
  }> {
    const actor = ctx.userId ?? ctx.serviceIdentityId;
    if (!actor) {
      throw new BadRequestException('actor is missing');
    }
    const rows = await this.tenant.run(
      { companyId: ctx.companyId, actor, correlationId: ctx.correlationId },
      (tx) =>
        tx.location.findMany({
          where: { companyId: ctx.companyId },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          select: { id: true, name: true, address: true, timezone: true, archivedAt: true },
        }),
    );
    return {
      locations: rows.map((row) => ({
        id: row.id,
        name: row.name,
        address: row.address,
        timezone: row.timezone,
        archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
      })),
    };
  }

  async roles(companyId: string): Promise<
    { id: string; key: string; name: string; description: string | null; templateKey: string | null; permissions: string[] }[]
  > {
    const roles = await this.prisma.client.role.findMany({
      where: { companyId },
      orderBy: [{ key: 'asc' }],
      include: { permissions: true },
    });
    return roles.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      templateKey: role.templateKey,
      permissions: role.permissions.map((permission) => permission.permission).sort(),
    }));
  }

  async auditEvents(ctx: RequestContext, query: AuditQuery): Promise<{
    events: {
      id: string;
      occurredAt: string;
      actorType: string;
      actorId: string | null;
      actorLabel: string | null;
      action: string;
      objectType: string;
      objectId: string | null;
      outcome: string;
      correlationId: string;
      details: unknown;
    }[];
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    if (query.from && query.to && query.from.getTime() > query.to.getTime()) {
      throw new BadRequestException('from must be before to');
    }
    const actor = ctx.userId ?? ctx.serviceIdentityId;
    if (!actor) {
      throw new BadRequestException('actor is missing');
    }
    const rows = await this.tenant.run(
      { companyId: ctx.companyId, actor, correlationId: ctx.correlationId },
      (tx) =>
        tx.auditEvent.findMany({
          where: {
            companyId: ctx.companyId,
            objectType: query.objectType,
            objectId: query.objectId,
            action: query.action,
            actorId: query.actorId,
            outcome: query.outcome,
            occurredAt: auditOccurredAt(query.from, query.to),
          },
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          skip: query.offset,
          take: query.limit + 1,
        }),
    );
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      events: page.map((event) => ({
        id: event.id,
        occurredAt: event.occurredAt.toISOString(),
        actorType: event.actorType,
        actorId: event.actorId,
        actorLabel: event.actorLabel,
        action: event.action,
        objectType: event.objectType,
        objectId: event.objectId,
        outcome: event.outcome,
        correlationId: event.correlationId,
        details: event.details,
      })),
      limit: query.limit,
      offset: query.offset,
      hasMore,
    };
  }
}

/** Inclusive start, exclusive end. A date-only `to` must already be the next boundary. */
export function auditOccurredAt(from?: Date, to?: Date): { gte?: Date; lt?: Date } | undefined {
  if (!from && !to) {
    return undefined;
  }
  return {
    ...(from ? { gte: from } : {}),
    ...(to ? { lt: to } : {}),
  };
}

export function parseAuditQuery(query: Record<string, unknown>): AuditQuery {
  const limit = parseBounded(query.limit, 50, 1, 100, 'limit');
  const offset = parseBounded(query.offset, 0, 0, 10_000, 'offset');
  const outcome = optionalString(query.outcome);
  if (outcome !== undefined && !OUTCOMES.includes(outcome as (typeof OUTCOMES)[number])) {
    throw new BadRequestException('outcome is invalid');
  }
  return {
    objectType: optionalString(query.objectType),
    objectId: optionalUuid(query.objectId, 'objectId'),
    action: optionalString(query.action),
    actorId: optionalUuid(query.actorId, 'actorId'),
    outcome: outcome as AuditQuery['outcome'],
    from: optionalDate(query.from, 'from'),
    to: optionalDate(query.to, 'to'),
    limit,
    offset,
  };
}

function optionalUuid(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new BadRequestException('filter is invalid');
  }
  return value;
}

function optionalDate(value: unknown, name: string): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(`${name} is invalid`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return parsed;
}

function parseBounded(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new BadRequestException(`${name} is invalid`);
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return parsed;
}
