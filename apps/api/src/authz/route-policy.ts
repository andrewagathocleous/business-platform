import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { AUTOMATION_ROUTE_KEY } from '../automation/automation-route.decorator';
import { API_GLOBAL_PREFIX } from '../http/api-prefix';
import { AUTHENTICATED_KEY } from './authenticated.decorator';
import { PLATFORM_OWNER_KEY } from './platform-owner.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import { REQUIRE_PERMISSION_KEY, type RequiredPermission } from './require-permission.decorator';

export type RouteAccess =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'platform' }
  | { kind: 'permission'; required: RequiredPermission }
  | { kind: 'missing' }
  | { kind: 'conflict'; permission?: RequiredPermission };

type ReflectorView = Pick<Reflector, 'get' | 'getAllAndOverride'>;

/**
 * A handler that declares `@RequirePermission()` is never public, even when the
 * class is marked `@Public()`. Declaring both is a conflict and boot fails.
 */
export function resolveRouteAccess(
  reflector: ReflectorView,
  handler: (...args: unknown[]) => unknown,
  classRef: new (...args: unknown[]) => unknown,
): RouteAccess {
  const isPublic = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, classRef]);
  const authenticated = reflector.getAllAndOverride<boolean>(AUTHENTICATED_KEY, [handler, classRef]);
  const platform = reflector.getAllAndOverride<boolean>(PLATFORM_OWNER_KEY, [handler, classRef]);
  const permission = reflector.getAllAndOverride<RequiredPermission | undefined>(REQUIRE_PERMISSION_KEY, [
    handler,
    classRef,
  ]);
  const handlerPermission = reflector.get<RequiredPermission | undefined>(REQUIRE_PERMISSION_KEY, handler);
  const effectivePermission = handlerPermission ?? permission;
  const flags = [isPublic, authenticated, platform, effectivePermission !== undefined].filter(Boolean).length;
  if (flags > 1) {
    return { kind: 'conflict', permission: effectivePermission };
  }
  if (handlerPermission) {
    return { kind: 'permission', required: handlerPermission };
  }
  if (permission) {
    return { kind: 'permission', required: permission };
  }
  if (platform) {
    return { kind: 'platform' };
  }
  if (authenticated) {
    return { kind: 'authenticated' };
  }
  if (isPublic) {
    return { kind: 'public' };
  }
  return { kind: 'missing' };
}

/**
 * Boot fails when any HTTP handler is unclassified or combines public access
 * with a permission. Swagger's static routes are not Nest controllers.
 */
@Injectable()
export class RoutePolicyChecker implements OnApplicationBootstrap {
  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly metadataScanner: MetadataScanner,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const missing: string[] = [];
    const conflicts: string[] = [];
    const automationMissing: string[] = [];
    const automationOutside: string[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const instance: unknown = wrapper.instance;
      const metatype = wrapper.metatype;
      if (typeof instance !== 'object' || instance === null || typeof metatype !== 'function') {
        continue;
      }
      const prototype: unknown = Object.getPrototypeOf(instance);
      if (typeof prototype !== 'object' || prototype === null) {
        continue;
      }
      const marked = this.reflector.get<boolean | undefined>(AUTOMATION_ROUTE_KEY, metatype) === true;
      const paths = controllerBasePaths(metatype as new (...args: never[]) => unknown);
      const underAutomation = paths.some((path) => isUnderAutomationPrefix(path));
      const outsideAutomation = paths.some((path) => !isUnderAutomationPrefix(path));
      if (underAutomation && !marked) {
        automationMissing.push(metatype.name);
      }
      if (marked && outsideAutomation) {
        automationOutside.push(metatype.name);
      }
      const handlers = prototype as Record<string, unknown>;
      for (const methodName of this.metadataScanner.getAllMethodNames(prototype)) {
        const handler = handlers[methodName];
        if (typeof handler !== 'function') {
          continue;
        }
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) {
          continue;
        }
        const access = resolveRouteAccess(
          this.reflector,
          handler as (...args: unknown[]) => unknown,
          metatype as new (...args: unknown[]) => unknown,
        );
        const name = `${metatype.name}.${methodName}`;
        if (access.kind === 'missing') {
          missing.push(name);
        }
        if (access.kind === 'conflict') {
          conflicts.push(name);
        }
      }
    }
    const lines: string[] = [];
    if (missing.length > 0) {
      lines.push(
        `neither @Public(), @RequirePermission(), @Authenticated() nor @PlatformOwner(): ${missing.join(', ')}`,
      );
    }
    if (conflicts.length > 0) {
      lines.push(`public and permission: ${conflicts.join(', ')}`);
    }
    if (automationMissing.length > 0) {
      lines.push(`automation route missing @AutomationRoute(): ${automationMissing.join(', ')}`);
    }
    if (automationOutside.length > 0) {
      lines.push(`@AutomationRoute() outside /${API_GLOBAL_PREFIX}/automation: ${automationOutside.join(', ')}`);
    }
    if (lines.length > 0) {
      throw new Error(`Route self-check failed. ${lines.join('; ')}`);
    }
  }
}

export function isUnderAutomationPrefix(path: string): boolean {
  const prefix = `/${API_GLOBAL_PREFIX}/automation`;
  return path === prefix || path.startsWith(`${prefix}/`);
}

function controllerBasePaths(metatype: new (...args: never[]) => unknown): string[] {
  const raw: unknown = Reflect.getMetadata(PATH_METADATA, metatype);
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((value) => {
    const segment = typeof value === 'string' ? value.replace(/^\/+|\/+$/g, '') : '';
    if (segment.length === 0) {
      return `/${API_GLOBAL_PREFIX}`;
    }
    return `/${API_GLOBAL_PREFIX}/${segment}`.replace(/\/{2,}/g, '/');
  });
}
