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
    expect(() => loadConfig(productionEnv({ APP_MASTER_KEYS: undefined }))).toThrow(/APP_MASTER_KEYS/);
    expect(() => loadConfig(productionEnv({ OIDC_CLIENT_SECRET: '' }))).toThrow(/OIDC_CLIENT_SECRET/);
    expect(() =>
      loadConfig(
        productionEnv({
          DATABASE_URL: 'postgresql://bp_app:placeholder@127.0.0.1:5432/business_platform',
        }),
      ),
    ).toThrow(/DATABASE_URL/);
  });

  it('applies the same refusals in uat', () => {
    expect(() => loadConfig(productionEnv({ APP_ENV: 'uat', AUTH_DEV_LOGIN_ENABLED: 'true' }))).toThrow(
      /AUTH_DEV_LOGIN_ENABLED=true/,
    );
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
    expect(development.masterKeys.k1).toHaveLength(32);
    expect(loadConfig(developmentEnv({ HOST: '0.0.0.0' })).host).toBe('0.0.0.0');
    expect(loadConfig(developmentEnv({ THROTTLE_AUTH_LIMIT: '7' })).throttleAuthLimit).toBe(7);
    expect(() => loadConfig(developmentEnv({ HOST: 'http://evil' }))).toThrow(/HOST/);
    expect(loadConfig(developmentEnv({ APP_ENV: 'test', THROTTLE_ENABLED_IN_TEST: 'true' })).throttleEnabledInTest).toBe(
      true,
    );
    expect(loadConfig(productionEnv({ THROTTLE_ENABLED_IN_TEST: 'true' })).throttleEnabledInTest).toBe(false);

    const test = loadConfig(developmentEnv({ APP_ENV: 'test' }));
    expect(test.authRequireMfaForPrivileged).toBe(false);
  });

  it('requires MFA for privileged permissions by default in production', () => {
    const config = loadConfig(productionEnv());
    expect(config.authRequireMfaForPrivileged).toBe(true);
    const disabled = loadConfig(productionEnv({ AUTH_REQUIRE_MFA_FOR_PRIVILEGED: 'false' }));
    expect(disabled.authRequireMfaForPrivileged).toBe(false);
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
