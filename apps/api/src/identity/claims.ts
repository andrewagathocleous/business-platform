import { containsControlCharacter } from './redirect';

export type ParsedOidcClaims = {
  issuer: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  preferredUsername?: string;
  name?: string;
  amr: unknown;
  tenantId?: string;
  entraOid?: string;
};

export type OidcClaimChecks = {
  clientId: string;
  nonce: string;
  nowMs: number;
};

/**
 * Issuer, audience, nonce and expiry are also checked by openid-client during
 * the code exchange. This repeats those checks on the claims we store.
 * `email` counts as verified only when `email_verified` is exactly true.
 */
export function parseOidcClaims(claims: object, expected: OidcClaimChecks): ParsedOidcClaims | undefined {
  const issuer = stringClaim(readClaim(claims, 'iss'));
  const subject = stringClaim(readClaim(claims, 'sub'));
  if (!issuer || !subject) {
    return undefined;
  }
  if (readClaim(claims, 'nonce') !== expected.nonce) {
    return undefined;
  }
  const exp = readClaim(claims, 'exp');
  if (typeof exp !== 'number' || exp * 1000 <= expected.nowMs) {
    return undefined;
  }
  if (!audienceMatches(readClaim(claims, 'aud'), expected.clientId)) {
    return undefined;
  }
  const email = stringClaim(readClaim(claims, 'email'));
  const preferredUsername = stringClaim(readClaim(claims, 'preferred_username'));
  const name = stringClaim(readClaim(claims, 'name'));
  const tenantId = stringClaim(readClaim(claims, 'tid'));
  const entraOid = stringClaim(readClaim(claims, 'oid'));
  return {
    issuer,
    subject,
    email,
    emailVerified: readClaim(claims, 'email_verified') === true,
    preferredUsername,
    name,
    amr: readClaim(claims, 'amr'),
    tenantId,
    entraOid,
  };
}

export function invitationEmailMatches(invitationEmail: string, claims: ParsedOidcClaims): boolean {
  const expected = invitationEmail.toLowerCase();
  if (claims.emailVerified && claims.email !== undefined && claims.email.toLowerCase() === expected) {
    return true;
  }
  if (claims.preferredUsername !== undefined && claims.preferredUsername.toLowerCase() === expected) {
    return true;
  }
  return false;
}

export function emailAtLink(claims: ParsedOidcClaims): string | null {
  if (claims.emailVerified && claims.email) {
    return claims.email;
  }
  return claims.preferredUsername ?? null;
}

export function displayNameFromClaims(claims: ParsedOidcClaims, fallback: string): string {
  const name = claims.name;
  if (name && name.length > 0 && name.length <= 200 && !containsControlCharacter(name)) {
    return name;
  }
  return fallback;
}

function readClaim(claims: object, key: string): unknown {
  const bag = claims as { [key: string]: unknown };
  return bag[key];
}

function stringClaim(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  return value;
}

function audienceMatches(audience: unknown, clientId: string): boolean {
  if (audience === clientId) {
    return true;
  }
  return Array.isArray(audience) && audience.some((item) => item === clientId);
}
