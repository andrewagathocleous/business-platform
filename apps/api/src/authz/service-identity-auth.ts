import { Inject, Injectable } from '@nestjs/common';
import { hashToken, tokenHashesMatch } from '../identity/tokens';
import { clockNow, CLOCK, type Clock } from '../identity/clock';
import { PrismaService } from '../database/prisma.service';
import { SESSION_TOUCH_MS } from '../identity/session-rules';
import type { ServicePrincipal } from './request-context';

const SERVICE_TOKEN =
  /^bps_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{16,})$/i;

const DUMMY_HASH = hashToken('service-identity-not-found');

export type ParsedServiceToken = {
  id: string;
  secret: string;
};

export type ServiceAuthentication =
  | { ok: true; identity: ServicePrincipal }
  | {
      ok: false;
      reason: 'service_token_invalid' | 'service_token_revoked' | 'service_token_expired';
      companyId: string | null;
      identityId: string | null;
    };

export function parseServiceToken(token: string): ParsedServiceToken | null {
  const match = SERVICE_TOKEN.exec(token);
  const id = match?.[1];
  const secret = match?.[2];
  if (!id || !secret) {
    return null;
  }
  return { id: id.toLowerCase(), secret };
}

@Injectable()
export class ServiceIdentityAuthenticator {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Looks the token up by id, compares the secret hash in constant time, then
   * checks status and expiry. Company matching is the caller's job.
   */
  async authenticate(parsed: ParsedServiceToken): Promise<ServiceAuthentication> {
    const row = await this.prisma.client.serviceIdentity.findUnique({ where: { id: parsed.id } });
    const presented = hashToken(parsed.secret);
    const matches = tokenHashesMatch(presented, row?.secretHash ?? DUMMY_HASH);
    if (!row || !matches) {
      return { ok: false, reason: 'service_token_invalid', companyId: null, identityId: null };
    }
    if (row.status !== 'active' || row.revokedAt) {
      return {
        ok: false,
        reason: 'service_token_revoked',
        companyId: row.companyId,
        identityId: row.id,
      };
    }
    const now = clockNow(this.clock);
    // The column is NOT NULL. Widen anyway so a null that reaches the process
    // another way is rejected rather than treated as never-expires.
    const expiresAt = row.expiresAt as unknown as Date | null;
    if (
      expiresAt == null ||
      Number.isNaN(expiresAt.getTime()) ||
      expiresAt.getTime() <= now.getTime()
    ) {
      return {
        ok: false,
        reason: 'service_token_expired',
        companyId: row.companyId,
        identityId: row.id,
      };
    }
    return {
      ok: true,
      identity: {
        id: row.id,
        companyId: row.companyId,
        name: row.name,
        permissions: row.permissions,
      },
    };
  }

  /** Writes `last_used_at` at most once a minute. */
  async touch(id: string): Promise<void> {
    const now = clockNow(this.clock);
    await this.prisma.client.serviceIdentity.updateMany({
      where: {
        id,
        OR: [
          { lastUsedAt: null },
          { lastUsedAt: { lte: new Date(now.getTime() - SESSION_TOUCH_MS) } },
        ],
      },
      data: { lastUsedAt: now },
    });
  }
}
