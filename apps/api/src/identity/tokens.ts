import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex of the secret string. Session cookies, OIDC state, binding cookies and invitation tokens use this. */
export function hashToken(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function tokenHashesMatch(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, 'hex');
  const right = Buffer.from(rightHex, 'hex');
  if (left.length !== right.length || left.length !== 32) {
    return false;
  }
  return timingSafeEqual(left, right);
}
