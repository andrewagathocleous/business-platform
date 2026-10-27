import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/env';
import { publicAuthProviders } from './auth-providers';
import { invitationEmailMatches, parseOidcClaims, type ParsedOidcClaims } from './claims';
import { xsrfToken, xsrfTokensMatch } from './csrf';
import { applyMfaPolicy, mfaSatisfiedFromAmr, PRIVILEGED_PERMISSIONS } from './mfa-policy';
import { relativeRedirect } from './redirect';
import { openSecret, seal } from './secret-box';
import { sessionCookieName } from './cookies';
import { sessionStatus, shouldTouchSession } from './session-rules';
import { hashToken, tokenHashesMatch } from './tokens';

const key = Buffer.alloc(32, 7);

describe('public auth providers', () => {
  it('reports development login and OIDC from configuration without copying secrets', () => {
    expect(publicAuthProviders(providerConfig({}))).toEqual({ devLogin: false, oidc: false });
    expect(
      publicAuthProviders(
        providerConfig({
          authDevLoginEnabled: true,
          appEnv: 'development',
          oidcIssuer: 'https://login.example.test/tenant',
          oidcClientId: 'client',
          oidcClientSecret: 'secret-value',
          oidcRedirectUri: 'http://127.0.0.1:3000/api/auth/oidc/callback',
        }),
      ),
    ).toEqual({ devLogin: true, oidc: true });
    expect(
      publicAuthProviders(providerConfig({ authDevLoginEnabled: true, appEnv: 'production' })),
    ).toEqual({ devLogin: false, oidc: false });
    expect(
      publicAuthProviders(
        providerConfig({
          oidcIssuer: 'https://login.example.test/tenant',
          oidcClientId: 'client',
          oidcRedirectUri: 'http://127.0.0.1:3000/api/auth/oidc/callback',
        }),
      ),
    ).toEqual({ devLogin: false, oidc: false });
  });
});

describe('session cookies and CSRF', () => {
  it('names the session cookie from the secure flag', () => {
    expect(sessionCookieName(true)).toBe('__Host-bp_session');
    expect(sessionCookieName(false)).toBe('bp_session');
  });

  it('compares CSRF tokens in constant time and rejects a different length', () => {
    const token = xsrfToken('session-id', 'csrf-secret');
    expect(xsrfTokensMatch(token, token)).toBe(true);
    expect(xsrfTokensMatch(`${token}x`, token)).toBe(false);
    expect(xsrfTokensMatch(undefined, token)).toBe(false);
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(xsrfTokensMatch(flipped, token)).toBe(false);
  });

  it('hashes tokens so the stored value is not the secret', () => {
    const secret = 'cookie-value';
    const hash = hashToken(secret);
    expect(hash).not.toBe(secret);
    expect(tokenHashesMatch(hash, hash)).toBe(true);
    expect(tokenHashesMatch(hashToken('other'), hash)).toBe(false);
  });
});

describe('secret box', () => {
  it('round-trips a code verifier and rejects a tampered tag', () => {
    const sealed = seal('verifier-value', { k1: key }, 'k1');
    expect(sealed.startsWith('v1.k1.')).toBe(true);
    expect(openSecret(sealed, { k1: key })).toBe('verifier-value');
    const parts = sealed.split('.');
    parts[4] = 'aaaa';
    expect(() => openSecret(parts.join('.'), { k1: key })).toThrow(/ciphertext is not valid/);
  });
});

describe('relative redirects', () => {
  it('allows a relative path and rejects open redirects', () => {
    expect(relativeRedirect('/after-login')).toBe('/after-login');
    expect(relativeRedirect('/after-login?next=1')).toBe('/after-login?next=1');
    expect(relativeRedirect('/')).toBe('/');
    expect(relativeRedirect('https://evil.example/phish')).toBeUndefined();
    expect(relativeRedirect('//evil.example')).toBeUndefined();
    expect(relativeRedirect('/\\evil')).toBeUndefined();
    expect(relativeRedirect('/%2f%2fevil.example')).toBeUndefined();
    expect(relativeRedirect('')).toBeUndefined();
  });
});

describe('MFA policy', () => {
  const grant = { permission: 'member.manage', scopeType: 'company' as const, scopeId: null };
  const ordinary = { permission: 'order.view', scopeType: 'company' as const, scopeId: null };

  it('reads amr case-sensitively', () => {
    expect(mfaSatisfiedFromAmr(['pwd', 'mfa'])).toBe(true);
    expect(mfaSatisfiedFromAmr(['pwd'])).toBe(false);
    expect(mfaSatisfiedFromAmr('mfa')).toBe(true);
    expect(mfaSatisfiedFromAmr(['MFA'])).toBe(false);
    expect(mfaSatisfiedFromAmr(undefined)).toBe(false);
  });

  it('withholds privileged permissions and platform ownership until MFA', () => {
    const result = applyMfaPolicy({
      grants: [grant, ordinary],
      isPlatformOwner: true,
      mfaSatisfied: false,
      requireMfaForPrivileged: true,
    });
    expect(result.grants).toEqual([ordinary]);
    expect(result.isPlatformOwner).toBe(false);
    expect(result.mfaStepUpRequired).toBe(true);
    expect(result.withheldPermissions).toEqual(
      expect.arrayContaining(['member.manage', 'platform-owner']),
    );
    expect(PRIVILEGED_PERMISSIONS).toContain('member.manage');
  });

  it('keeps privileges when MFA is satisfied or the requirement is off', () => {
    const satisfied = applyMfaPolicy({
      grants: [grant],
      isPlatformOwner: true,
      mfaSatisfied: true,
      requireMfaForPrivileged: true,
    });
    expect(satisfied.isPlatformOwner).toBe(true);
    expect(satisfied.grants).toEqual([grant]);
    const development = applyMfaPolicy({
      grants: [grant],
      isPlatformOwner: false,
      mfaSatisfied: false,
      requireMfaForPrivileged: false,
    });
    expect(development.grants).toEqual([grant]);
    expect(development.mfaStepUpRequired).toBe(false);
  });
});

describe('OIDC claims', () => {
  const expected = { clientId: 'client', nonce: 'nonce-1', nowMs: 1_000_000 };

  function claims(overrides: Record<string, unknown> = {}): ParsedOidcClaims | undefined {
    return parseOidcClaims(
      {
        iss: 'https://login.example.test/tenant',
        sub: 'subject-1',
        aud: 'client',
        nonce: 'nonce-1',
        exp: 2_000,
        email: 'Person@example.test',
        email_verified: true,
        preferred_username: 'person@example.test',
        amr: ['mfa'],
        tid: 'tenant',
        oid: 'object',
        ...overrides,
      },
      expected,
    );
  }

  it('accepts a token and matches an invitation email case-insensitively', () => {
    const parsed = claims();
    expect(parsed?.subject).toBe('subject-1');
    expect(parsed?.tenantId).toBe('tenant');
    expect(parsed?.entraOid).toBe('object');
    expect(parsed && invitationEmailMatches('person@example.test', parsed)).toBe(true);
  });

  it('rejects a bad nonce, audience or expiry, and an unverified email', () => {
    expect(claims({ nonce: 'other' })).toBeUndefined();
    expect(claims({ aud: 'other-client' })).toBeUndefined();
    expect(claims({ exp: 1 })).toBeUndefined();
    const unverified = claims({ email_verified: false, preferred_username: 'nope@example.test' });
    expect(unverified && invitationEmailMatches('person@example.test', unverified)).toBe(false);
    const username = claims({ email_verified: false, preferred_username: 'Person@example.test' });
    expect(username && invitationEmailMatches('person@example.test', username)).toBe(true);
  });
});

describe('session expiry rules', () => {
  const start = new Date('2026-01-01T00:00:00.000Z');

  it('expires at the idle and absolute deadlines and touches at most once a minute', () => {
    const session = {
      revokedAt: null,
      idleExpiresAt: new Date(start.getTime() + 8 * 60 * 60 * 1000),
      absoluteExpiresAt: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000),
    };
    expect(sessionStatus(session, new Date(session.idleExpiresAt.getTime() - 1))).toBe('ok');
    expect(sessionStatus(session, session.idleExpiresAt)).toBe('expired');
    expect(
      sessionStatus(
        { ...session, idleExpiresAt: session.absoluteExpiresAt },
        session.absoluteExpiresAt,
      ),
    ).toBe('expired');
    expect(sessionStatus({ ...session, revokedAt: start }, start)).toBe('revoked');
    expect(shouldTouchSession(start, new Date(start.getTime() + 59_999))).toBe(false);
    expect(shouldTouchSession(start, new Date(start.getTime() + 60_000))).toBe(true);
  });
});

function providerConfig(
  overrides: Partial<
    Pick<
      AppConfig,
      | 'appEnv'
      | 'authDevLoginEnabled'
      | 'oidcIssuer'
      | 'oidcClientId'
      | 'oidcClientSecret'
      | 'oidcRedirectUri'
    >
  >,
): AppConfig {
  return {
    appEnv: 'test',
    authDevLoginEnabled: false,
    sessionCookieSecure: false,
    csrfSecret: 'csrf',
    authRequireMfaForPrivileged: false,
    oidcIssuer: '',
    oidcClientId: '',
    oidcClientSecret: '',
    oidcRedirectUri: '',
    masterKeys: {},
    activeMasterKeyId: 'k1',
    databaseUrl: 'configured',
    port: 3000,
    host: '127.0.0.1',
    throttleDefaultLimit: 300,
    throttleAuthLimit: 20,
    throttleAutomationLimit: 120,
    throttleEnabledInTest: false,
    trustProxyHops: 0,
    storageRoot: '/tmp/bp-storage',
    mockPrintRoot: '/tmp/bp-mock-print',
    outboundAllowLoopbackForTests: false,
    printNodeBaseUrl: null,
    ...overrides,
  };
}
