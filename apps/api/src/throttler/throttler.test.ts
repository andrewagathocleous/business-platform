import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AUTOMATION_ROUTE_KEY } from '../automation/automation-route.decorator';
import type { AppConfig } from '../config/env';
import {
  AUTH_THROTTLE_LIMIT,
  AUTOMATION_THROTTLE_LIMIT,
  buildThrottlerOptions,
  DEFAULT_THROTTLE_LIMIT,
  DEFAULT_THROTTLE_TTL_MS,
} from './throttler';

function config(appEnv: AppConfig['appEnv']): AppConfig {
  return {
    appEnv,
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
    databaseUrl: 'postgresql://bp_app:pw@127.0.0.1:5432/business_platform_test',
    port: 3000,
    host: '127.0.0.1',
    throttleDefaultLimit: DEFAULT_THROTTLE_LIMIT,
    throttleAuthLimit: AUTH_THROTTLE_LIMIT,
    throttleAutomationLimit: AUTOMATION_THROTTLE_LIMIT,
    throttleEnabledInTest: false,
    storageRoot: '/tmp/bp-storage',
    mockPrintRoot: '/tmp/bp-mock-print',
  };
}

function context(path: string, automation = false): ExecutionContext {
  function routeHandler(): void {}
  function RouteController(): void {}
  if (automation) {
    Reflect.defineMetadata(AUTOMATION_ROUTE_KEY, true, RouteController);
  }
  return {
    getClass: () => RouteController,
    getHandler: () => routeHandler,
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl: path }),
    }),
  } as unknown as ExecutionContext;
}

describe('throttler options', () => {
  it('applies the default limit and stricter auth and automation limits', () => {
    const options = buildThrottlerOptions(config('development'));
    if (Array.isArray(options)) {
      throw new Error('expected throttler options object');
    }
    expect(options.throttlers.map((item) => [item.name, item.limit, item.ttl])).toEqual([
      ['default', DEFAULT_THROTTLE_LIMIT, DEFAULT_THROTTLE_TTL_MS],
      ['auth', AUTH_THROTTLE_LIMIT, DEFAULT_THROTTLE_TTL_MS],
      ['automation', AUTOMATION_THROTTLE_LIMIT, DEFAULT_THROTTLE_TTL_MS],
    ]);
    const auth = options.throttlers[1]?.skipIf;
    const automation = options.throttlers[2]?.skipIf;
    expect(auth?.(context('/api/auth/dev/login'))).toBe(false);
    expect(auth?.(context('/API/auth/dev/login'))).toBe(true);
    expect(auth?.(context('/api/health/live'))).toBe(true);
    expect(automation?.(context('/api/automation/v1/c/company/events', true))).toBe(false);
    expect(automation?.(context('/api/automation/v1/c/company/events'))).toBe(true);
    expect(automation?.(context('/api/c/company/automation/switches'))).toBe(true);
  });

  it('skips every limiter when APP_ENV is test', () => {
    const options = buildThrottlerOptions(config('test'));
    if (Array.isArray(options)) {
      throw new Error('expected throttler options object');
    }
    for (const throttler of options.throttlers) {
      expect(throttler.skipIf?.(context('/api/auth/dev/login'))).toBe(true);
    }
  });

  it('runs the limiters in test when the test switch is on', () => {
    const options = buildThrottlerOptions({ ...config('test'), throttleEnabledInTest: true, throttleAuthLimit: 2 });
    if (Array.isArray(options)) {
      throw new Error('expected throttler options object');
    }
    const auth = options.throttlers[1]?.skipIf;
    expect(auth?.(context('/api/auth/dev/login'))).toBe(false);
    expect(options.throttlers[1]?.limit).toBe(2);
  });
});
