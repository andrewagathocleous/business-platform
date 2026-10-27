import type { Grant } from '@bp/domain';
import type { Request } from 'express';

export type RequestContext = {
  userId: string | null;
  serviceIdentityId: string | null;
  companyId: string;
  grants: Grant[];
  isPlatformOwner: boolean;
  correlationId: string;
  mfaStepUpRequired: boolean;
  withheldPermissions: string[];
  actorLabel: string | null;
  mfaSatisfied: boolean;
};

export type ServicePrincipal = {
  id: string;
  companyId: string;
  name: string;
  permissions: readonly string[];
};

const contexts = new WeakMap<Request, RequestContext>();
const principals = new WeakMap<Request, ServicePrincipal>();

export function setRequestContext(req: Request, context: RequestContext): void {
  contexts.set(req, context);
}

export function readRequestContext(req: Request): RequestContext | undefined {
  return contexts.get(req);
}

export function setServicePrincipal(req: Request, principal: ServicePrincipal): void {
  principals.set(req, principal);
}

export function readServicePrincipal(req: Request): ServicePrincipal | undefined {
  return principals.get(req);
}
