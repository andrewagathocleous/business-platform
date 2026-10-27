import { InternalServerErrorException } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';
import { readRequestContext, type RequestContext } from '../authz/request-context';

export function requireContext(req: Request, companyId: string): RequestContext {
  const ctx = readRequestContext(req);
  if (!ctx || ctx.companyId !== companyId.toLowerCase()) {
    throw new InternalServerErrorException('Company context is missing');
  }
  return ctx;
}

export function requireActor(ctx: RequestContext): string {
  if (!ctx.userId) {
    throw new InternalServerErrorException('Actor is missing');
  }
  return ctx.userId;
}

export function unknownBody(req: Request): unknown {
  return req.body as unknown;
}

export function queryRecord(req: Request): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req.query)) {
    query[key] = Array.isArray(value) ? value[0] : value;
  }
  return query;
}

export function issueMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
      return `${path}${issue.message}`;
    })
    .join(', ');
}
