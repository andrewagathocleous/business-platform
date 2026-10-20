import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { can, decideAccess, type AccessDecision } from '@bp/domain';
import type { Request } from 'express';
import { AuditService, type AuditActorType } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { getCorrelationId } from '../correlation/correlation';
import { PrismaService } from '../database/prisma.service';
import { pathOnly } from '../http/request-path';
import { applyMfaPolicy } from '../identity/mfa-policy';
import { requestMeta } from '../identity/request-meta';
import { readStaffSession } from '../identity/staff-session';
import { companyIdFromPath } from './company-path';
import { dedupeGrants, grantsForMembership, platformOwnerGrants } from './load-grants';
import type { RequiredPermission } from './require-permission.decorator';
import { resolvePermission } from './resolve-permission';
import {
  readServicePrincipal,
  setRequestContext,
  type RequestContext,
} from './request-context';

export type StaffAccess =
  | { ok: true; context: RequestContext }
  | { ok: false; reason: 'company_not_found' | 'not_a_member'; companyId: string | null };

@Injectable()
export class CompanyAccessService {
  private readonly tenant: TenantDb;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.tenant = new TenantDb(prisma.client);
  }

  async enforce(request: Request, required: RequiredPermission): Promise<void> {
    const path = pathOnly(request.originalUrl);
    const company = companyIdFromPath(path);
    if (company.kind === 'none') {
      throw new InternalServerErrorException('Route is not company scoped');
    }
    if (company.kind === 'invalid') {
      await this.deny(request, 'invalid_company_id', null, 'company', null);
      throw new NotFoundException('Not found');
    }
    const principal = readServicePrincipal(request);
    const session = readStaffSession(request);
    if (!principal && !session) {
      throw new UnauthorizedException('Authentication is required');
    }
    const built = principal
      ? this.serviceContext(principal, company.companyId)
      : await this.loadStaffAccess(this.prisma.client, {
          userId: session?.userId ?? '',
          mfaSatisfied: session?.mfaSatisfied ?? false,
          companyId: company.companyId,
        });
    if (!built.ok) {
      await this.deny(request, built.reason, built.companyId, 'company', company.companyId);
      throw new NotFoundException('Not found');
    }
    if (principal && principal.companyId !== company.companyId) {
      await this.deny(request, 'service_company_mismatch', company.companyId, 'service_identity', principal.id);
      throw new NotFoundException('Not found');
    }
    setRequestContext(request, built.context);
    const decision = await this.decision(built.context, required, request);
    if (decision === 'allow') {
      return;
    }
    if (decision === 'not_found') {
      await this.deny(request, 'out_of_scope', company.companyId, 'route', null, required.permission);
      throw new NotFoundException('Not found');
    }
    await this.deny(request, 'permission_missing', company.companyId, 'route', null, required.permission);
    throw new ForbiddenException('Forbidden');
  }

  async enforcePlatformOwner(request: Request): Promise<void> {
    const session = readStaffSession(request);
    if (!session) {
      throw new UnauthorizedException('Authentication is required');
    }
    const user = await this.prisma.client.userAccount.findUnique({ where: { id: session.userId } });
    const isOwner = Boolean(user && user.status === 'active' && user.isPlatformOwner);
    const policy = applyMfaPolicy({
      grants: [],
      isPlatformOwner: isOwner,
      mfaSatisfied: session.mfaSatisfied,
      requireMfaForPrivileged: this.config.authRequireMfaForPrivileged,
    });
    if (!isOwner) {
      await this.deny(request, 'not_platform_owner', null, 'platform', null);
      throw new NotFoundException('Not found');
    }
    if (!policy.isPlatformOwner) {
      await this.deny(request, 'mfa_required', null, 'platform', null);
      throw new ForbiddenException('Forbidden');
    }
  }

  /**
   * Loads membership grants inside the caller's transaction so a company row
   * lock sees the same snapshot as the write that follows.
   */
  async loadStaffAccess(
    db: TenantTransaction,
    input: { userId: string; mfaSatisfied: boolean; companyId: string },
  ): Promise<StaffAccess> {
    const company = await db.company.findUnique({ where: { id: input.companyId }, select: { id: true } });
    if (!company) {
      return { ok: false, reason: 'company_not_found', companyId: null };
    }
    const user = await db.userAccount.findUnique({ where: { id: input.userId } });
    if (!user || user.status !== 'active') {
      return { ok: false, reason: 'not_a_member', companyId: input.companyId };
    }
    const membership = await db.membership.findUnique({
      where: { userId_companyId: { userId: user.id, companyId: input.companyId } },
    });
    const membershipActive = membership !== null && membership.status === 'active';
    const memberGrants = membershipActive ? await grantsForMembership(db, membership.id) : [];
    const rawOwner = user.isPlatformOwner;
    const policy = applyMfaPolicy({
      grants: rawOwner ? platformOwnerGrants() : memberGrants,
      isPlatformOwner: rawOwner,
      mfaSatisfied: input.mfaSatisfied,
      requireMfaForPrivileged: this.config.authRequireMfaForPrivileged,
    });
    let grants = policy.grants;
    if (rawOwner && !policy.isPlatformOwner) {
      grants = applyMfaPolicy({
        grants: memberGrants,
        isPlatformOwner: false,
        mfaSatisfied: false,
        requireMfaForPrivileged: true,
      }).grants;
    }
    if (!policy.isPlatformOwner && !membershipActive) {
      return { ok: false, reason: 'not_a_member', companyId: input.companyId };
    }
    return {
      ok: true,
      context: {
        userId: user.id,
        serviceIdentityId: null,
        companyId: input.companyId,
        grants: dedupeGrants(grants),
        isPlatformOwner: policy.isPlatformOwner,
        correlationId: this.correlation(),
        mfaStepUpRequired: policy.mfaStepUpRequired,
        withheldPermissions: [...policy.withheldPermissions].sort(),
        actorLabel: user.email,
        mfaSatisfied: input.mfaSatisfied,
      },
    };
  }

  private serviceContext(
    principal: { id: string; companyId: string; name: string; permissions: readonly string[] },
    companyId: string,
  ): { ok: true; context: RequestContext } {
    return {
      ok: true,
      context: {
        userId: null,
        serviceIdentityId: principal.id,
        companyId,
        grants: dedupeGrants(
          principal.permissions.map((permission) => ({
            permission,
            scopeType: 'company' as const,
            scopeId: null,
          })),
        ),
        isPlatformOwner: false,
        correlationId: this.correlation(),
        mfaStepUpRequired: false,
        withheldPermissions: [],
        actorLabel: principal.name,
        mfaSatisfied: true,
      },
    };
  }

  private async decision(
    ctx: RequestContext,
    required: RequiredPermission,
    request: Request,
  ): Promise<AccessDecision> {
    const resolve = required.scope;
    if (!resolve) {
      return decideAccess(ctx.grants, required.permission);
    }
    const actor = ctx.userId ?? ctx.serviceIdentityId;
    if (!actor) {
      throw new InternalServerErrorException('Actor is missing');
    }
    return this.tenant.run({ companyId: ctx.companyId, actor, correlationId: ctx.correlationId }, (tx) =>
      resolvePermission(ctx.grants, required.permission, () => resolve(request, ctx, tx)),
    );
  }

  private correlation(): string {
    const correlationId = getCorrelationId();
    if (!correlationId) {
      throw new InternalServerErrorException('Correlation id is missing');
    }
    return correlationId;
  }

  private async deny(
    request: Request,
    reason: string,
    companyId: string | null,
    objectType: string,
    objectId: string | null,
    permission?: string,
  ): Promise<void> {
    const session = readStaffSession(request);
    const principal = readServicePrincipal(request);
    const meta = requestMeta(request);
    const actorType: AuditActorType = principal ? 'service' : session ? 'user' : 'system';
    await this.audit.recordDenial({
      companyId,
      actorType,
      actorId: principal?.id ?? session?.userId ?? null,
      actorLabel: principal?.name ?? session?.email ?? null,
      action: 'authorization.denied',
      objectType,
      objectId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: {
        reason,
        method: request.method,
        path: pathOnly(request.originalUrl),
        ...(permission ? { permission } : {}),
      },
    });
  }
}

export function contextHas(ctx: RequestContext, permission: string): boolean {
  return can(ctx.grants, permission);
}
