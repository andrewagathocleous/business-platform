import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { type AppConfig } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { writeAudit } from './auth-audit';
import type { RequestMeta } from './request-meta';
import { SessionService } from './session.service';

export function devLoginEnabled(config: AppConfig): boolean {
  return config.authDevLoginEnabled && (config.appEnv === 'development' || config.appEnv === 'test');
}

export type DevUser = {
  email: string;
  displayName: string;
  isPlatformOwner: boolean;
  memberships: {
    companyId: string;
    tradingName: string;
    status: string;
    roles: string[];
  }[];
};

export type DevLoginResult =
  | {
      ok: true;
      token: string;
      sessionId: string;
      user: { id: string; email: string; displayName: string; isPlatformOwner: boolean };
      session: { idleExpiresAt: string; absoluteExpiresAt: string };
    }
  | { ok: false };

@Injectable()
export class DevLoginService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async listUsers(): Promise<DevUser[]> {
    const users = await this.prisma.client.userAccount.findMany({
      where: { identities: { some: { provider: 'dev' } } },
      orderBy: { email: 'asc' },
      include: {
        memberships: {
          orderBy: { company: { tradingName: 'asc' } },
          include: {
            company: { select: { id: true, tradingName: true } },
            roles: { include: { role: { select: { key: true } } } },
          },
        },
      },
    });
    return users.map((user) => ({
      email: user.email,
      displayName: user.displayName,
      isPlatformOwner: user.isPlatformOwner,
      memberships: user.memberships.map((membership) => ({
        companyId: membership.companyId,
        tradingName: membership.company.tradingName,
        status: membership.status,
        roles: membership.roles.map((assignment) => assignment.role.key).sort(),
      })),
    }));
  }

  async login(email: string, meta: RequestMeta, previousCookie: string | undefined): Promise<DevLoginResult> {
    const user = await this.prisma.client.userAccount.findFirst({
      where: { email, identities: { some: { provider: 'dev' } } },
    });
    if (!user || user.status !== 'active') {
      await writeAudit(this.prisma, this.audit, {
        actorType: 'system',
        action: 'auth.login',
        objectType: 'user_account',
        objectId: user?.id ?? null,
        outcome: 'failure',
        ip: meta.ip,
        userAgent: meta.userAgent,
        details: { method: 'dev', reason: user ? 'user_disabled' : 'unknown_user' },
      });
      return { ok: false };
    }
    const issued = await this.sessions.issue({
      user,
      authMethod: 'dev',
      mfaSatisfied: false,
      previousCookie,
      meta,
    });
    return {
      ok: true,
      token: issued.token,
      sessionId: issued.session.sessionId,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        isPlatformOwner: user.isPlatformOwner,
      },
      session: {
        idleExpiresAt: issued.session.idleExpiresAt.toISOString(),
        absoluteExpiresAt: issued.session.absoluteExpiresAt.toISOString(),
      },
    };
  }
}
