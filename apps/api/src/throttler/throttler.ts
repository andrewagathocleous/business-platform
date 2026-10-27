import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import { isAutomationRouteTarget } from '../automation/automation-route.decorator';
import type { AppConfig } from '../config/env';
import { requestPath } from '../http/request-path';
import { DEFAULT_THROTTLE_TTL_MS } from './limits';

export {
  AUTH_THROTTLE_LIMIT,
  AUTOMATION_THROTTLE_LIMIT,
  DEFAULT_THROTTLE_LIMIT,
  DEFAULT_THROTTLE_TTL_MS,
} from './limits';

export function buildThrottlerOptions(config: AppConfig): ThrottlerModuleOptions {
  const enabled = config.appEnv !== 'test' || config.throttleEnabledInTest;
  return {
    throttlers: [
      {
        name: 'default',
        ttl: DEFAULT_THROTTLE_TTL_MS,
        limit: config.throttleDefaultLimit,
        skipIf: () => !enabled,
      },
      {
        name: 'auth',
        ttl: DEFAULT_THROTTLE_TTL_MS,
        limit: config.throttleAuthLimit,
        skipIf: (context) => !enabled || !requestPath(context).startsWith('/api/auth'),
      },
      {
        name: 'automation',
        ttl: DEFAULT_THROTTLE_TTL_MS,
        limit: config.throttleAutomationLimit,
        skipIf: (context) => !enabled || !isAutomationContext(context),
      },
    ],
  };
}

export { requestPath };

function isAutomationContext(context: ExecutionContext): boolean {
  return isAutomationRouteTarget(context.getHandler(), context.getClass());
}
