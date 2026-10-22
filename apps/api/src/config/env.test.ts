import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './env';

const masterKey = Buffer.alloc(32, 4).toString('base64');

function developmentEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    APP_ENV: 'development',
    CSRF_SECRET: 'dev-csrf-secret-value',
    APP_MASTER_KEYS: JSON.stringify({ k1: masterKey }),
    APP_MASTER_KEY_ACTIVE: 'k1',
    DATABASE_URL: 'postgresql://bp_app:dev-password@127.0.0.1:5432/business_platform',
    ...overrides,
  };
}

function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return developmentEnv({
    APP_ENV: 'production',
    AUTH_DEV_LOGIN_ENABLED: 'false',
    SESSION_COOKIE_SECURE: 'true',
    CSRF_SECRET: 'production-csrf-secret-value',
    OIDC_ISSUER: 'https://login.example.test/tenant',
    OIDC_CLIENT_ID: 'fictional-client',
    OIDC_CLIENT_SECRET: 'production-oidc-client-secret',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/auth/oidc/callback',
    DATABASE_URL: 'postgresql://bp_app:production-db-password@127.0.0.1:5432/business_platform',
    ...overrides,
  });
}

describe('loadConfig', () => {
  it('refuses to start when APP_ENV is missing', () => {
    expect(() => loadConfig({})).toThrow(/APP_ENV is required/);
  });

  it('refuses an invalid APP_ENV', () => {
    expect(() => loadConfig(developmentEnv({ APP_ENV: 'staging' }))).toThrow(/APP_ENV/);
  });

  it('refuses dev login, insecure cookies, placeholders and missing secrets in production', () => {
    expect(() => loadConfig(productionEnv({ AUTH_DEV_LOGIN_ENABLED: 'true' }))).toThrow(
      /AUTH_DEV_LOGIN_ENABLED=true/,
    );
    expect(() => loadConfig(productionEnv({ SESSION_COOKIE_SECURE: 'false' }))).toThrow(
      /SESSION_COOKIE_SECURE=false/,
    );
    expect(() => loadConfig(productionEnv({ CSRF_SECRET: 'generate' }))).toThrow(/CSRF_SECRET/);
    expect(() => loadConfig(productionEnv({ APP_MASTER_KEYS: undefined }))).toThrow(
      /APP_MASTER_KEYS/,
    );
    expect(() => loadConfig(productionEnv({ OIDC_CLIENT_SECRET: '' }))).toThrow(
      /OIDC_CLIENT_SECRET/,
    );
    expect(() =>
      loadConfig(
        productionEnv({
          DATABASE_URL: 'postgresql://bp_app:placeholder@127.0.0.1:5432/business_platform',
        }),
      ),
    ).toThrow(/DATABASE_URL/);
  });

  it('applies the same refusals in uat', () => {
    expect(() =>
      loadConfig(productionEnv({ APP_ENV: 'uat', AUTH_DEV_LOGIN_ENABLED: 'true' })),
    ).toThrow(/AUTH_DEV_LOGIN_ENABLED=true/);
  });

  it('allows dev login and optional OIDC in development and test', () => {
    const development = loadConfig(
      developmentEnv({ AUTH_DEV_LOGIN_ENABLED: 'true', SESSION_COOKIE_SECURE: 'false' }),
    );
    expect(development.authDevLoginEnabled).toBe(true);
    expect(development.sessionCookieSecure).toBe(false);
    expect(development.oidcIssuer).toBe('');
    expect(development.authRequireMfaForPrivileged).toBe(false);
    expect(development.port).toBe(3000);
    expect(development.host).toBe('127.0.0.1');
    expect(development.throttleDefaultLimit).toBe(300);
    expect(development.throttleAuthLimit).toBe(20);
    expect(development.throttleAutomationLimit).toBe(120);
    expect(development.throttleEnabledInTest).toBe(false);
    expect(development.trustProxyHops).toBe(0);
    expect(development.masterKeys.k1).toHaveLength(32);
    expect(loadConfig(developmentEnv({ HOST: '0.0.0.0' })).host).toBe('0.0.0.0');
    expect(loadConfig(developmentEnv({ THROTTLE_AUTH_LIMIT: '7' })).throttleAuthLimit).toBe(7);
    expect(() => loadConfig(developmentEnv({ HOST: 'http://evil' }))).toThrow(/HOST/);
    expect(
      loadConfig(developmentEnv({ APP_ENV: 'test', THROTTLE_ENABLED_IN_TEST: 'true' }))
        .throttleEnabledInTest,
    ).toBe(true);
    expect(
      loadConfig(productionEnv({ THROTTLE_ENABLED_IN_TEST: 'true' })).throttleEnabledInTest,
    ).toBe(false);

    const test = loadConfig(developmentEnv({ APP_ENV: 'test' }));
    expect(test.authRequireMfaForPrivileged).toBe(false);
  });

  it('requires MFA for privileged permissions by default in production', () => {
    const config = loadConfig(productionEnv());
    expect(config.authRequireMfaForPrivileged).toBe(true);
    const disabled = loadConfig(productionEnv({ AUTH_REQUIRE_MFA_FOR_PRIVILEGED: 'false' }));
    expect(disabled.authRequireMfaForPrivileged).toBe(false);
  });

  it('resolves STORAGE_ROOT and MOCK_PRINT_ROOT from the repository root', () => {
    const repoRoot = resolve(__dirname, '../../../..');
    expect(loadConfig(developmentEnv()).storageRoot).toBe(resolve(repoRoot, 'var/storage'));
    expect(loadConfig(developmentEnv({ STORAGE_ROOT: 'tmp/docs' })).storageRoot).toBe(
      resolve(repoRoot, 'tmp/docs'),
    );
    expect(loadConfig(developmentEnv({ STORAGE_ROOT: '/tmp/bp-storage' })).storageRoot).toBe(
      '/tmp/bp-storage',
    );
    expect(() => loadConfig(developmentEnv({ STORAGE_ROOT: 's3://bucket/docs' }))).toThrow(
      /STORAGE_ROOT/,
    );
    expect(() => loadConfig(developmentEnv({ STORAGE_ROOT: 'var/storage\0hidden' }))).toThrow(
      /STORAGE_ROOT/,
    );
    expect(loadConfig(developmentEnv()).mockPrintRoot).toBe(
      resolve(repoRoot, 'var/mock-print-output'),
    );
    expect(loadConfig(developmentEnv({ MOCK_PRINT_ROOT: 'tmp/prints' })).mockPrintRoot).toBe(
      resolve(repoRoot, 'tmp/prints'),
    );
    expect(loadConfig(developmentEnv({ MOCK_PRINT_ROOT: '/tmp/bp-print' })).mockPrintRoot).toBe(
      '/tmp/bp-print',
    );
    expect(() => loadConfig(developmentEnv({ MOCK_PRINT_ROOT: 's3://bucket/prints' }))).toThrow(
      /MOCK_PRINT_ROOT/,
    );
  });

  it('trusts no proxy hops unless TRUST_PROXY_HOPS is 1 or 2', () => {
    expect(loadConfig(developmentEnv()).trustProxyHops).toBe(0);
    expect(loadConfig(developmentEnv({ TRUST_PROXY_HOPS: '1' })).trustProxyHops).toBe(1);
    expect(loadConfig(developmentEnv({ TRUST_PROXY_HOPS: '2' })).trustProxyHops).toBe(2);
    expect(loadConfig(productionEnv()).trustProxyHops).toBe(0);
    expect(() => loadConfig(developmentEnv({ TRUST_PROXY_HOPS: '3' }))).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => loadConfig(developmentEnv({ TRUST_PROXY_HOPS: '-1' }))).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => loadConfig(productionEnv({ TRUST_PROXY_HOPS: 'no' }))).toThrow(/TRUST_PROXY_HOPS/);
  });

  it('rejects a master key that is not 32 bytes', () => {
    expect(() =>
      loadConfig(
        developmentEnv({
          APP_MASTER_KEYS: JSON.stringify({ k1: Buffer.alloc(16, 1).toString('base64') }),
        }),
      ),
    ).toThrow(/32 bytes/);
  });
});
