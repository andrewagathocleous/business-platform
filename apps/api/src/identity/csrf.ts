import { createHmac, timingSafeEqual } from 'node:crypto';

export function xsrfToken(sessionId: string, secret: string): string {
  return createHmac('sha256', secret).update(sessionId).digest('base64url');
}

/** Compares the header to the expected token. A length mismatch still touches the expected bytes. */
export function xsrfTokensMatch(presented: string | undefined, expected: string): boolean {
  const right = Buffer.from(expected);
  const left = Buffer.from(presented ?? '');
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}
