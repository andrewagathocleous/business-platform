import type { Request } from 'express';

export type StaffSession = {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  locale: 'en' | 'el';
  isPlatformOwner: boolean;
  mfaSatisfied: boolean;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
};

export type StaffAuthFailure = {
  ok: false;
  reason: 'missing' | 'invalid' | 'expired' | 'revoked' | 'disabled';
  userId: string | null;
  sessionId: string | null;
};

export type StaffAuth = { ok: true; session: StaffSession } | StaffAuthFailure;

const sessions = new WeakMap<Request, StaffSession>();

export function setStaffSession(req: Request, session: StaffSession): void {
  sessions.set(req, session);
}

export function readStaffSession(req: Request): StaffSession | undefined {
  return sessions.get(req);
}
