import { SetMetadata } from '@nestjs/common';

export const AUTOMATION_ROUTE_KEY = 'bp:automation-route';

/** Marks a controller whose routes accept only automation bearer tokens. */
export function AutomationRoute(): ClassDecorator {
  return SetMetadata(AUTOMATION_ROUTE_KEY, true);
}

export function isAutomationRouteTarget(handler: object, classRef: object): boolean {
  return (
    Reflect.getMetadata(AUTOMATION_ROUTE_KEY, handler) === true ||
    Reflect.getMetadata(AUTOMATION_ROUTE_KEY, classRef) === true
  );
}
