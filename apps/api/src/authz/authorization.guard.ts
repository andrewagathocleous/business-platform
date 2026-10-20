import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuditService, type AuditActorType } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { isAutomationRouteTarget } from '../automation/automation-route.decorator';
import { pathOnly } from '../http/request-path';
import { xsrfToken, xsrfTokensMatch } from '../identity/csrf';
import { XSRF_HEADER_NAME } from '../identity/cookies';
import { hasBearerAuthorization, isUnsafeMethod, readBearerToken, requestMeta } from '../identity/request-meta';
import { SessionService } from '../identity/session.service';
import { setStaffSession } from '../identity/staff-session';
import { CompanyAccessService } from './company-access.service';
import { companyIdFromPath } from './company-path';
import type { RequiredPermission } from './require-permission.decorator';
import { resolveRouteAccess } from './route-policy';
import { setServicePrincipal } from './request-context';
import { parseServiceToken, ServiceIdentityAuthenticator } from './service-identity-auth';

/**
 * Deny by default. Staff routes authenticate with the session cookie.
 * Automation routes authenticate only with `Authorization: Bearer bps_…`.
 * A session cookie is never accepted there, and a bearer token is never
 * accepted on a staff route. `@RequirePermission` is evaluated for every
 * classified permission route.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ServiceIdentityAuthenticator) private readonly serviceIdentities: ServiceIdentityAuthenticator,
    @Inject(CompanyAccessService) private readonly companyAccess: CompanyAccessService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = resolveRouteAccess(
      this.reflector,
      context.getHandler() as (...args: unknown[]) => unknown,
      context.getClass(),
    );
    if (access.kind === 'public') {
      return true;
    }
    if (access.kind === 'missing' || (access.kind === 'conflict' && !access.permission)) {
      throw new InternalServerErrorException('Route is not classified');
    }
    const request = context.switchToHttp().getRequest<Request>();
    const path = pathOnly(request.originalUrl);
    if (isAutomationRouteTarget(context.getHandler(), context.getClass())) {
      await this.authenticateAutomation(request, path);
    } else {
      await this.authenticateStaff(request);
    }
    if (access.kind === 'authenticated') {
      return true;
    }
    if (access.kind === 'platform') {
      await this.companyAccess.enforcePlatformOwner(request);
      return true;
    }
    const required = permissionOf(access);
    if (!required) {
      throw new InternalServerErrorException('Route is not classified');
    }
    await this.companyAccess.enforce(request, required);
    return true;
  }

  private async authenticateStaff(request: Request): Promise<void> {
    if (hasBearerAuthorization(request)) {
      await this.deny(request, 'bearer_on_staff_route', {
        actorType: 'system',
        actorId: null,
        companyId: null,
      });
      throw new UnauthorizedException('Bearer tokens are not accepted on staff routes');
    }
    const auth = await this.sessions.fromRequest(request);
    if (!auth.ok) {
      await this.deny(request, auth.reason, {
        actorType: auth.userId ? 'user' : 'system',
        actorId: auth.userId,
        companyId: null,
        objectId: auth.sessionId,
      });
      throw new UnauthorizedException('Authentication is required');
    }
    if (isUnsafeMethod(request.method)) {
      const expected = xsrfToken(auth.session.sessionId, this.config.csrfSecret);
      const presented = request.header(XSRF_HEADER_NAME);
      if (!xsrfTokensMatch(presented, expected)) {
        await this.deny(request, 'csrf', {
          actorType: 'user',
          actorId: auth.session.userId,
          companyId: null,
          objectId: auth.session.sessionId,
        });
        throw new ForbiddenException('CSRF token is missing or invalid');
      }
    }
    setStaffSession(request, auth.session);
  }

  private async authenticateAutomation(request: Request, path: string): Promise<void> {
    const parsed = parseServiceToken(readBearerToken(request) ?? '');
    if (!parsed) {
      await this.deny(request, 'automation_requires_bearer', {
        actorType: 'system',
        actorId: null,
        companyId: null,
      });
      throw new UnauthorizedException('Authentication is required');
    }
    const auth = await this.serviceIdentities.authenticate(parsed);
    if (!auth.ok) {
      await this.deny(request, auth.reason, {
        actorType: auth.identityId ? 'service' : 'system',
        actorId: auth.identityId,
        companyId: auth.companyId,
      });
      throw new UnauthorizedException('Authentication is required');
    }
    const company = companyIdFromPath(path);
    if (company.kind !== 'id') {
      await this.deny(request, 'invalid_company_id', {
        actorType: 'service',
        actorId: auth.identity.id,
        companyId: null,
      });
      throw new NotFoundException('Not found');
    }
    if (auth.identity.companyId !== company.companyId) {
      const row = await this.prisma.client.company.findUnique({
        where: { id: company.companyId },
        select: { id: true },
      });
      await this.deny(request, 'service_company_mismatch', {
        actorType: 'service',
        actorId: auth.identity.id,
        companyId: row?.id ?? null,
      });
      throw new NotFoundException('Not found');
    }
    await this.serviceIdentities.touch(auth.identity.id);
    setServicePrincipal(request, auth.identity);
  }

  private async deny(
    request: Request,
    reason: string,
    actor: {
      actorType: AuditActorType;
      actorId: string | null;
      companyId: string | null;
      objectId?: string | null;
    },
  ): Promise<void> {
    const meta = requestMeta(request);
    await this.audit.recordDenial({
      companyId: actor.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: 'authorization.denied',
      objectType: actor.actorType === 'service' ? 'service_identity' : 'route',
      objectId: actor.objectId ?? actor.actorId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: {
        reason,
        method: request.method,
        path: pathOnly(request.originalUrl),
      },
    });
  }
}

function permissionOf(
  access:
    | { kind: 'permission'; required: RequiredPermission }
    | { kind: 'conflict'; permission?: RequiredPermission }
    | { kind: 'authenticated' }
    | { kind: 'platform' }
    | { kind: 'public' }
    | { kind: 'missing' },
): RequiredPermission | undefined {
  if (access.kind === 'permission') {
    return access.required;
  }
  if (access.kind === 'conflict') {
    return access.permission;
  }
  return undefined;
}
