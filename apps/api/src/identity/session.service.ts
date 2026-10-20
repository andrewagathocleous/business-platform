import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { clockNow, CLOCK, type Clock } from './clock';
import { applyMfaPolicy } from './mfa-policy';
import { readSessionCookie } from './cookies';
import { hashToken, randomToken } from './tokens';
import type { RequestMeta } from './request-meta';
import {
  ABSOLUTE_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  SESSION_TOUCH_MS,
  sessionStatus,
  shouldTouchSession,
} from './session-rules';
import { type StaffAuth, type StaffSession } from './staff-session';

type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  locale: string;
  isPlatformOwner: boolean;
  status: string;
};

export type IssuedSession = {
  token: string;
  session: StaffSession;
};

export type CompanySummary = {
  id: string;
  legalName: string;
  tradingName: string;
  status: string;
};

@Injectable()
export class SessionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async fromRequest(req: Request): Promise<StaffAuth> {
    const cookie = readSessionCookie(req, this.config);
    if (!cookie) {
      return { ok: false, reason: 'missing', userId: null, sessionId: null };
    }
    const tokenHash = hashToken(cookie);
    const row = await this.prisma.client.userSession.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!row) {
      return { ok: false, reason: 'invalid', userId: null, sessionId: null };
    }
    const now = clockNow(this.clock);
    const status = sessionStatus(row, now);
    if (status === 'revoked') {
      return { ok: false, reason: 'revoked', userId: row.userId, sessionId: row.id };
    }
    if (status === 'expired') {
      return { ok: false, reason: 'expired', userId: row.userId, sessionId: row.id };
    }
    if (row.user.status !== 'active') {
      return { ok: false, reason: 'disabled', userId: row.userId, sessionId: row.id };
    }
    let idleExpiresAt = row.idleExpiresAt;
    if (shouldTouchSession(row.lastSeenAt, now)) {
      idleExpiresAt = new Date(now.getTime() + IDLE_TIMEOUT_MS);
      await this.prisma.client.userSession.updateMany({
        where: {
          id: row.id,
          revokedAt: null,
          lastSeenAt: { lte: new Date(now.getTime() - SESSION_TOUCH_MS) },
        },
        data: { lastSeenAt: now, idleExpiresAt },
      });
    }
    return {
      ok: true,
      session: toStaffSession(row.user, {
        sessionId: row.id,
        mfaSatisfied: row.mfaSatisfied,
        idleExpiresAt,
        absoluteExpiresAt: row.absoluteExpiresAt,
      }),
    };
  }

  async issue(input: {
    user: SessionUser;
    authMethod: 'dev' | 'oidc';
    mfaSatisfied: boolean;
    previousCookie: string | undefined;
    meta: RequestMeta;
  }): Promise<IssuedSession> {
    const token = randomToken();
    const tokenHash = hashToken(token);
    const now = clockNow(this.clock);
    const previousHash = input.previousCookie ? hashToken(input.previousCookie) : null;
    const idleExpiresAt = new Date(now.getTime() + IDLE_TIMEOUT_MS);
    const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS);
    const created = await this.prisma.client.$transaction(async (tx) => {
      if (previousHash) {
        await tx.userSession.updateMany({
          where: { tokenHash: previousHash, revokedAt: null },
          data: { revokedAt: now, revokedReason: 'replaced' },
        });
      }
      const session = await tx.userSession.create({
        data: {
          userId: input.user.id,
          tokenHash,
          authMethod: input.authMethod,
          mfaSatisfied: input.mfaSatisfied,
          lastSeenAt: now,
          idleExpiresAt,
          absoluteExpiresAt,
          ip: input.meta.ip,
          userAgent: input.meta.userAgent,
        },
      });
      await this.audit.record(tx, {
        actorType: 'user',
        actorId: input.user.id,
        actorLabel: input.user.email,
        action: 'auth.login',
        objectType: 'user_session',
        objectId: session.id,
        outcome: 'success',
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
        details: { method: input.authMethod, mfaSatisfied: input.mfaSatisfied },
      });
      return session;
    });
    return {
      token,
      session: toStaffSession(input.user, {
        sessionId: created.id,
        mfaSatisfied: input.mfaSatisfied,
        idleExpiresAt,
        absoluteExpiresAt,
      }),
    };
  }

  async revoke(session: StaffSession, meta: RequestMeta): Promise<void> {
    const now = clockNow(this.clock);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.userSession.updateMany({
        where: { id: session.sessionId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'logout' },
      });
      await this.audit.record(tx, {
        actorType: 'user',
        actorId: session.userId,
        actorLabel: session.email,
        action: 'auth.logout',
        objectType: 'user_session',
        objectId: session.sessionId,
        outcome: 'success',
        ip: meta.ip,
        userAgent: meta.userAgent,
        details: { reason: 'logout' },
      });
    });
  }

  async authorisedCompanies(session: StaffSession): Promise<CompanySummary[]> {
    const owner = applyMfaPolicy({
      grants: [],
      isPlatformOwner: session.isPlatformOwner,
      mfaSatisfied: session.mfaSatisfied,
      requireMfaForPrivileged: this.config.authRequireMfaForPrivileged,
    }).isPlatformOwner;
    if (owner) {
      return this.prisma.client.company.findMany({
        where: { status: 'active' },
        orderBy: [{ tradingName: 'asc' }, { id: 'asc' }],
        select: { id: true, legalName: true, tradingName: true, status: true },
      });
    }
    const memberships = await this.prisma.client.membership.findMany({
      where: { userId: session.userId, status: 'active' },
      orderBy: [{ company: { tradingName: 'asc' } }, { company: { id: 'asc' } }],
      select: {
        company: { select: { id: true, legalName: true, tradingName: true, status: true } },
      },
    });
    return memberships.map((membership) => membership.company);
  }
}

function toStaffSession(
  user: SessionUser,
  session: {
    sessionId: string;
    mfaSatisfied: boolean;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  },
): StaffSession {
  return {
    sessionId: session.sessionId,
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    locale: user.locale === 'el' ? 'el' : 'en',
    isPlatformOwner: user.isPlatformOwner,
    mfaSatisfied: session.mfaSatisfied,
    idleExpiresAt: session.idleExpiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
  };
}
