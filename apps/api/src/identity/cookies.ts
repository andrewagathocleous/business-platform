import type { CookieOptions, Request, Response } from 'express';
import type { AppConfig } from '../config/env';
import { xsrfToken } from './csrf';
import { ABSOLUTE_TIMEOUT_MS, OIDC_COOKIE_MAX_AGE_SECONDS } from './session-rules';

export const XSRF_COOKIE_NAME = 'XSRF-TOKEN';
export const XSRF_HEADER_NAME = 'x-xsrf-token';
export const OIDC_FLOW_COOKIE_NAME = 'bp_oidc_flow';
export const OIDC_FLOW_COOKIE_PATH = '/api/auth/oidc';

export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-bp_session' : 'bp_session';
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    if (key !== name) {
      continue;
    }
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function readSessionCookie(req: Request, config: AppConfig): string | undefined {
  return readCookie(req.header('cookie'), sessionCookieName(config.sessionCookieSecure));
}

export function setSessionCookie(res: Response, config: AppConfig, token: string): void {
  res.cookie(sessionCookieName(config.sessionCookieSecure), token, sessionCookieOptions(config));
}

export function clearSessionCookie(res: Response, config: AppConfig): void {
  res.clearCookie(sessionCookieName(config.sessionCookieSecure), sessionCookieOptions(config));
}

export function setXsrfCookie(res: Response, config: AppConfig, sessionId: string): void {
  res.cookie(XSRF_COOKIE_NAME, xsrfToken(sessionId, config.csrfSecret), {
    ...xsrfCookieOptions(config),
    maxAge: ABSOLUTE_TIMEOUT_MS,
  });
}

export function clearXsrfCookie(res: Response, config: AppConfig): void {
  res.clearCookie(XSRF_COOKIE_NAME, xsrfCookieOptions(config));
}

export function setOidcFlowCookie(res: Response, config: AppConfig, token: string): void {
  res.cookie(OIDC_FLOW_COOKIE_NAME, token, {
    ...oidcFlowCookieOptions(config),
    maxAge: OIDC_COOKIE_MAX_AGE_SECONDS * 1000,
  });
}

export function clearOidcFlowCookie(res: Response, config: AppConfig): void {
  res.clearCookie(OIDC_FLOW_COOKIE_NAME, oidcFlowCookieOptions(config));
}

function sessionCookieOptions(config: AppConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: config.sessionCookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: ABSOLUTE_TIMEOUT_MS,
  };
}

function xsrfCookieOptions(config: AppConfig): CookieOptions {
  return {
    httpOnly: false,
    secure: config.sessionCookieSecure,
    sameSite: 'strict',
    path: '/',
  };
}

function oidcFlowCookieOptions(config: AppConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: config.sessionCookieSecure,
    sameSite: 'lax',
    path: OIDC_FLOW_COOKIE_PATH,
  };
}
