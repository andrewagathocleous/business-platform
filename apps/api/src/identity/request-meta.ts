import { isIP } from 'node:net';
import type { Request } from 'express';

export type RequestMeta = {
  ip: string | null;
  userAgent: string | null;
};

export function requestMeta(req: Request): RequestMeta {
  const ip = req.ip;
  const userAgent = req.header('user-agent');
  return {
    ip: ip && isIP(ip) !== 0 ? ip : null,
    userAgent: userAgent ? userAgent.slice(0, 1000) : null,
  };
}

export function hasBearerAuthorization(req: Request): boolean {
  return readBearerToken(req) !== null;
}

export function readBearerToken(req: Request): string | null {
  const value = req.header('authorization');
  if (!value) {
    return null;
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value.trim());
  const token = match?.[1];
  return token ? token : null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isUnsafeMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}
