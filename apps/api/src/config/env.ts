import { z } from 'zod';
import {
  AUTH_THROTTLE_LIMIT,
  AUTOMATION_THROTTLE_LIMIT,
  DEFAULT_THROTTLE_LIMIT,
} from '../throttler/limits';

const APP_ENVS = ['development', 'test', 'uat', 'production'] as const;

export type AppEnv = (typeof APP_ENVS)[number];

const PLACEHOLDER =
  /^(generate|placeholder|changeme|change-me|change_me|replace-me|replace_me|secret|password|todo|xxx+|your-secret)$/i;

const envSchema = z.object({
  APP_ENV: z.enum(APP_ENVS, {
    error: (issue) =>
      issue.input === undefined || issue.input === ''
        ? 'APP_ENV is required'
        : 'APP_ENV must be one of development, test, uat or production',
  }),
  AUTH_DEV_LOGIN_ENABLED: z.string().optional(),
  SESSION_COOKIE_SECURE: z.string().optional(),
  CSRF_SECRET: z.string().optional(),
  AUTH_REQUIRE_MFA_FOR_PRIVILEGED: z.string().optional(),
  OIDC_ISSUER: z.string().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().optional(),
  APP_MASTER_KEYS: z.string().optional(),
  APP_MASTER_KEY_ACTIVE: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  PORT: z.string().optional(),
  HOST: z.string().optional(),
  THROTTLE_DEFAULT_LIMIT: z.string().optional(),
  THROTTLE_AUTH_LIMIT: z.string().optional(),
  THROTTLE_AUTOMATION_LIMIT: z.string().optional(),
  THROTTLE_ENABLED_IN_TEST: z.string().optional(),
});

export type AppConfig = {
  appEnv: AppEnv;
  authDevLoginEnabled: boolean;
  sessionCookieSecure: boolean;
  csrfSecret: string;
  authRequireMfaForPrivileged: boolean;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcRedirectUri: string;
  masterKeys: Readonly<Record<string, Buffer>>;
  activeMasterKeyId: string;
  databaseUrl: string;
  port: number;
  host: string;
  throttleDefaultLimit: number;
  throttleAuthLimit: number;
  throttleAutomationLimit: number;
  /** Honoured only when APP_ENV is test. Production limits always run. */
  throttleEnabledInTest: boolean;
};

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${formatIssues(parsed.error)}`);
  }
  const raw = parsed.data;
  const problems: string[] = [];
  const appEnv = raw.APP_ENV;
  const authDevLoginEnabled = parseBoolean(raw.AUTH_DEV_LOGIN_ENABLED, false, 'AUTH_DEV_LOGIN_ENABLED', problems);
  const sessionCookieSecure = parseBoolean(
    raw.SESSION_COOKIE_SECURE,
    false,
    'SESSION_COOKIE_SECURE',
    problems,
  );
  const csrfSecret = requiredSecret(raw.CSRF_SECRET, 'CSRF_SECRET', problems);
  const databaseUrl = requiredSecret(raw.DATABASE_URL, 'DATABASE_URL', problems);
  const activeMasterKeyId = requiredSecret(raw.APP_MASTER_KEY_ACTIVE, 'APP_MASTER_KEY_ACTIVE', problems);
  const masterKeys = parseMasterKeys(raw.APP_MASTER_KEYS, activeMasterKeyId, problems);
  const port = parsePort(raw.PORT, problems);
  const host = parseHost(raw.HOST, problems);
  const throttleDefaultLimit = parsePositiveInt(
    raw.THROTTLE_DEFAULT_LIMIT,
    DEFAULT_THROTTLE_LIMIT,
    'THROTTLE_DEFAULT_LIMIT',
    problems,
  );
  const throttleAuthLimit = parsePositiveInt(
    raw.THROTTLE_AUTH_LIMIT,
    AUTH_THROTTLE_LIMIT,
    'THROTTLE_AUTH_LIMIT',
    problems,
  );
  const throttleAutomationLimit = parsePositiveInt(
    raw.THROTTLE_AUTOMATION_LIMIT,
    AUTOMATION_THROTTLE_LIMIT,
    'THROTTLE_AUTOMATION_LIMIT',
    problems,
  );
  const throttleEnabledInTest =
    appEnv === 'test' &&
    parseBoolean(raw.THROTTLE_ENABLED_IN_TEST, false, 'THROTTLE_ENABLED_IN_TEST', problems);
  const oidcIssuer = raw.OIDC_ISSUER?.trim() ?? '';
  const oidcClientId = raw.OIDC_CLIENT_ID?.trim() ?? '';
  const oidcClientSecret = raw.OIDC_CLIENT_SECRET?.trim() ?? '';
  const oidcRedirectUri = raw.OIDC_REDIRECT_URI?.trim() ?? '';
  const mfaExplicit = parseOptionalBoolean(
    raw.AUTH_REQUIRE_MFA_FOR_PRIVILEGED,
    'AUTH_REQUIRE_MFA_FOR_PRIVILEGED',
    problems,
  );

  if (isLockedDown(appEnv)) {
    if (authDevLoginEnabled) {
      problems.push('AUTH_DEV_LOGIN_ENABLED=true is refused when APP_ENV is uat or production');
    }
    if (!sessionCookieSecure) {
      problems.push('SESSION_COOKIE_SECURE=false is refused when APP_ENV is uat or production');
    }
    for (const [name, value] of [
      ['CSRF_SECRET', csrfSecret],
      ['DATABASE_URL', databaseUrl],
      ['APP_MASTER_KEYS', raw.APP_MASTER_KEYS?.trim() ?? ''],
      ['APP_MASTER_KEY_ACTIVE', activeMasterKeyId],
      ['OIDC_ISSUER', oidcIssuer],
      ['OIDC_CLIENT_ID', oidcClientId],
      ['OIDC_CLIENT_SECRET', oidcClientSecret],
      ['OIDC_REDIRECT_URI', oidcRedirectUri],
    ] as const) {
      if (isPlaceholder(value)) {
        problems.push(`${name} is missing or still a placeholder`);
      }
    }
    if (databaseUrl.length > 0 && databaseUrlLooksPlaceholder(databaseUrl)) {
      problems.push('DATABASE_URL is missing or still a placeholder');
    }
  }

  if (problems.length > 0) {
    throw new Error(`Refusing to start:\n${problems.map((line) => `- ${line}`).join('\n')}`);
  }
  if (!masterKeys || !activeMasterKeyId || !csrfSecret || !databaseUrl) {
    throw new Error('Refusing to start:\n- configuration is incomplete');
  }

  return {
    appEnv,
    authDevLoginEnabled,
    sessionCookieSecure,
    csrfSecret,
    authRequireMfaForPrivileged: mfaExplicit ?? (appEnv === 'uat' || appEnv === 'production'),
    oidcIssuer,
    oidcClientId,
    oidcClientSecret,
    oidcRedirectUri,
    masterKeys,
    activeMasterKeyId,
    databaseUrl,
    port,
    host,
    throttleDefaultLimit,
    throttleAuthLimit,
    throttleAutomationLimit,
    throttleEnabledInTest,
  };
}

function isLockedDown(appEnv: AppEnv): boolean {
  return appEnv === 'uat' || appEnv === 'production';
}

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return true;
  }
  return PLACEHOLDER.test(trimmed) || /placeholder|changeme|replace-me|replace_me/i.test(trimmed);
}

function databaseUrlLooksPlaceholder(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isPlaceholder(decodeURIComponent(parsed.password));
  } catch {
    return true;
  }
}

function requiredSecret(value: string | undefined, name: string, problems: string[]): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) {
    problems.push(`${name} is required`);
    return '';
  }
  return trimmed;
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
  problems: string[],
): boolean {
  const parsed = parseOptionalBoolean(value, name, problems);
  return parsed ?? fallback;
}

function parseOptionalBoolean(
  value: string | undefined,
  name: string,
  problems: string[],
): boolean | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  problems.push(`${name} must be true or false`);
  return undefined;
}

function parseHost(value: string | undefined, problems: string[]): string {
  if (value === undefined || value.trim() === '') {
    return '127.0.0.1';
  }
  const host = value.trim();
  if (host.length > 255 || /[\s/]/.test(host) || host.includes('://')) {
    problems.push('HOST must be a hostname or IP address');
    return '127.0.0.1';
  }
  return host;
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string, problems: string[]): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  if (!/^[0-9]+$/.test(value.trim())) {
    problems.push(`${name} must be a positive integer`);
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000_000) {
    problems.push(`${name} must be a positive integer`);
    return fallback;
  }
  return parsed;
}

function parsePort(value: string | undefined, problems: string[]): number {
  if (value === undefined || value.trim() === '') {
    return 3000;
  }
  if (!/^[0-9]+$/.test(value.trim())) {
    problems.push('PORT must be an integer from 1 to 65535');
    return 3000;
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    problems.push('PORT must be an integer from 1 to 65535');
    return 3000;
  }
  return port;
}

function parseMasterKeys(
  raw: string | undefined,
  active: string,
  problems: string[],
): Record<string, Buffer> | undefined {
  const trimmed = raw?.trim() ?? '';
  if (trimmed.length === 0) {
    problems.push('APP_MASTER_KEYS is required');
    return undefined;
  }
  if (isPlaceholder(trimmed)) {
    problems.push('APP_MASTER_KEYS must be a JSON object of key id to base64-encoded 32-byte keys');
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    problems.push('APP_MASTER_KEYS must be a JSON object of key id to base64-encoded 32-byte keys');
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    problems.push('APP_MASTER_KEYS must be a JSON object of key id to base64-encoded 32-byte keys');
    return undefined;
  }
  const keys: Record<string, Buffer> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || value.length === 0) {
      problems.push(`APP_MASTER_KEYS entry "${id}" must be a base64 string`);
      continue;
    }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== 32) {
      problems.push(`APP_MASTER_KEYS entry "${id}" must decode to 32 bytes`);
      continue;
    }
    keys[id] = bytes;
  }
  if (active.length > 0 && !keys[active]) {
    problems.push('APP_MASTER_KEY_ACTIVE must name a key in APP_MASTER_KEYS');
  }
  if (Object.keys(keys).length === 0) {
    return undefined;
  }
  return keys;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'configuration';
      return `- ${path}: ${issue.message}`;
    })
    .join('\n');
}
