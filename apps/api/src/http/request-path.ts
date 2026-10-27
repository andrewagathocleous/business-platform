import type { ExecutionContext } from '@nestjs/common';

export function pathOnly(value: string): string {
  const query = value.indexOf('?');
  return query === -1 ? value : value.slice(0, query);
}

export function requestPath(context: ExecutionContext): string {
  const request = context.switchToHttp().getRequest<{ originalUrl?: string; url?: string; path?: string }>();
  return pathOnly(request.originalUrl ?? request.url ?? request.path ?? '');
}
