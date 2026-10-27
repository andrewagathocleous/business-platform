export const IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_TOUCH_MS = 60 * 1000;
export const OIDC_FLOW_TTL_MS = 10 * 60 * 1000;
export const OIDC_COOKIE_MAX_AGE_SECONDS = 600;

export type SessionTimestamps = {
  revokedAt: Date | null;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
};

export function sessionStatus(session: SessionTimestamps, now: Date): 'ok' | 'revoked' | 'expired' {
  if (session.revokedAt) {
    return 'revoked';
  }
  if (now.getTime() >= session.absoluteExpiresAt.getTime()) {
    return 'expired';
  }
  if (now.getTime() >= session.idleExpiresAt.getTime()) {
    return 'expired';
  }
  return 'ok';
}

export function shouldTouchSession(lastSeenAt: Date, now: Date): boolean {
  return now.getTime() - lastSeenAt.getTime() >= SESSION_TOUCH_MS;
}
