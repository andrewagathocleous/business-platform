import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { can, isAutomationOnly, permissionByKey } from '@bp/domain';
import { AuditService } from '../audit/audit.service';
import { isUuid } from '../authz/company-path';
import type { RequestContext } from '../authz/request-context';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';
import { hashToken, randomToken } from '../identity/tokens';

export type ServiceIdentityView = {
  id: string;
  name: string;
  purpose: string;
  permissions: string[];
  status: string;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type ServiceIdentityCreated = {
  identity: ServiceIdentityView;
  token: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const SERVICE_IDENTITY_DEFAULT_TTL_MS = 90 * DAY_MS;
export const SERVICE_IDENTITY_MAX_TTL_MS = 365 * DAY_MS;

/** Omitted expiry becomes 90 days. Null, past dates and dates past 365 days are rejected. */
export function resolveServiceIdentityExpiry(value: string | null | undefined, now = Date.now()): Date {
  if (value === undefined) {
    return new Date(now + SERVICE_IDENTITY_DEFAULT_TTL_MS);
  }
  if (value === null) {
    throw new BadRequestException('expiresAt is invalid');
  }
  const expiresAt = new Date(value);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new BadRequestException('expiresAt is invalid');
  }
  if (expiresAt.getTime() <= now) {
    throw new BadRequestException('expiresAt must be in the future');
  }
  if (expiresAt.getTime() > now + SERVICE_IDENTITY_MAX_TTL_MS) {
    throw new BadRequestException('expiresAt must be at most 365 days ahead');
  }
  return expiresAt;
}

const identitySelect = {
  id: true,
  name: true,
  purpose: true,
  permissions: true,
  status: true,
  expiresAt: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true,
} as const;

@Injectable()
export class ServiceIdentityService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(companyId: string): Promise<ServiceIdentityView[]> {
    const rows = await this.prisma.client.serviceIdentity.findMany({
      where: { companyId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: identitySelect,
    });
    return rows.map(toView);
  }

  async create(
    ctx: RequestContext,
    input: { name: string; purpose: string; permissions: string[]; expiresAt: string | null | undefined },
    meta: RequestMeta,
  ): Promise<ServiceIdentityCreated> {
    if (!ctx.userId) {
      throw new ForbiddenException('Forbidden');
    }
    const permissions = [...new Set(input.permissions)];
    if (permissions.length === 0) {
      throw new BadRequestException('permissions are required');
    }
    for (const permission of permissions) {
      if (!permissionByKey(permission)) {
        throw new BadRequestException('Unknown permission');
      }
      if (!isAutomationOnly(permission) && !can(ctx.grants, permission)) {
        await this.audit.recordDenial({
          companyId: ctx.companyId,
          actorType: 'user',
          actorId: ctx.userId,
          actorLabel: ctx.actorLabel,
          action: 'authorization.denied',
          objectType: 'service_identity',
          objectId: null,
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: { reason: 'permission_not_held', permission },
        });
        throw new ForbiddenException('Forbidden');
      }
    }
    const expiresAt = resolveServiceIdentityExpiry(input.expiresAt);
    const secret = randomToken();
    const saved = await this.prisma.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.company_id', ${ctx.companyId}, true)`;
      const identity = await tx.serviceIdentity.create({
        data: {
          companyId: ctx.companyId,
          name: input.name,
          purpose: input.purpose,
          secretHash: hashToken(secret),
          permissions,
          status: 'active',
          expiresAt,
          createdById: ctx.userId ?? '',
        },
        select: identitySelect,
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        actorType: 'user',
        actorId: ctx.userId,
        actorLabel: ctx.actorLabel,
        action: 'service_identity.created',
        objectType: 'service_identity',
        objectId: identity.id,
        outcome: 'success',
        ip: meta.ip,
        userAgent: meta.userAgent,
        details: { name: input.name, purpose: input.purpose, permissions },
      });
      return identity;
    });
    return { identity: toView(saved), token: `bps_${saved.id}.${secret}` };
  }

  async revoke(ctx: RequestContext, serviceIdentityId: string, meta: RequestMeta): Promise<void> {
    if (!ctx.userId) {
      throw new ForbiddenException('Forbidden');
    }
    if (!isUuid(serviceIdentityId)) {
      await this.denyMissing(ctx, null, meta);
      throw new NotFoundException('Not found');
    }
    const existing = await this.prisma.client.serviceIdentity.findFirst({
      where: { id: serviceIdentityId, companyId: ctx.companyId },
    });
    if (!existing || existing.status !== 'active' || existing.revokedAt) {
      await this.denyMissing(ctx, isUuid(serviceIdentityId) ? serviceIdentityId : null, meta);
      throw new NotFoundException('Not found');
    }
    const now = new Date();
    const revoked = await this.prisma.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.company_id', ${ctx.companyId}, true)`;
      const updated = await tx.serviceIdentity.updateMany({
        where: { id: existing.id, companyId: ctx.companyId, status: 'active', revokedAt: null },
        data: { status: 'revoked', revokedAt: now },
      });
      if (updated.count !== 1) {
        return false;
      }
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        actorType: 'user',
        actorId: ctx.userId,
        actorLabel: ctx.actorLabel,
        action: 'service_identity.revoked',
        objectType: 'service_identity',
        objectId: existing.id,
        outcome: 'success',
        ip: meta.ip,
        userAgent: meta.userAgent,
        details: { name: existing.name },
      });
      return true;
    });
    if (!revoked) {
      await this.denyMissing(ctx, existing.id, meta);
      throw new NotFoundException('Not found');
    }
  }

  private async denyMissing(ctx: RequestContext, objectId: string | null, meta: RequestMeta): Promise<void> {
    await this.audit.recordDenial({
      companyId: ctx.companyId,
      actorType: 'user',
      actorId: ctx.userId,
      actorLabel: ctx.actorLabel,
      action: 'authorization.denied',
      objectType: 'service_identity',
      objectId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: { reason: 'service_identity_not_found' },
    });
  }
}

function toView(row: {
  id: string;
  name: string;
  purpose: string;
  permissions: string[];
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}): ServiceIdentityView {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    permissions: [...row.permissions].sort(),
    status: row.status,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
