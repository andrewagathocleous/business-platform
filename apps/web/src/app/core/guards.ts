import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { CompanyContextStore } from './company-context.store';
import { firstAllowedPath, landingCompanyPath, visibleNav } from './nav';
import { safeAppPath } from './redirect';
import { SessionStore } from './session.store';

export const authGuard: CanActivateFn = async (_route, state) => {
  const session = inject(SessionStore);
  const router = inject(Router);
  const result = await session.load();
  if (result === 'error') {
    return unavailableTree(router, state.url);
  }
  if (session.user()) {
    return true;
  }
  return router.createUrlTree(['/login'], { queryParams: { redirect: state.url } });
};

export const entryGuard: CanActivateFn = async (_route, state) => {
  const session = inject(SessionStore);
  const router = inject(Router);
  const result = await session.load();
  if (result === 'error') {
    return unavailableTree(router, state.url);
  }
  if (!session.user()) {
    return router.parseUrl('/login');
  }
  return router.parseUrl(landingCompanyPath(session.companies()));
};

export const companyGuard: CanActivateFn = async (route, state) => {
  const session = inject(SessionStore);
  const router = inject(Router);
  const result = await session.load();
  if (result === 'error') {
    return unavailableTree(router, state.url);
  }
  if (!session.user()) {
    return router.createUrlTree(['/login'], { queryParams: { redirect: state.url } });
  }
  const companyId = route.paramMap.get('companyId');
  if (
    !companyId ||
    !session.companies().some((company) => company.id.toLowerCase() === companyId.toLowerCase())
  ) {
    return router.parseUrl('/not-found');
  }
  if (companyId !== companyId.toLowerCase()) {
    return router.parseUrl(canonicalCompanyUrl(state.url, companyId));
  }
  return true;
};

export const homeGuard: CanActivateFn = async (route) => {
  const context = inject(CompanyContextStore);
  const router = inject(Router);
  const companyId = route.parent?.paramMap.get('companyId') ?? route.paramMap.get('companyId');
  if (!companyId) {
    return router.parseUrl('/not-found');
  }
  const loaded = await context.load(companyId);
  if (loaded === 'forbidden') {
    return router.parseUrl('/forbidden');
  }
  if (loaded === 'not-found') {
    return router.parseUrl('/not-found');
  }
  const next = firstAllowedPath(companyId, context.grants());
  return next ? router.parseUrl(next) : true;
};

export const permissionGuard: CanActivateFn = async (route) => {
  const context = inject(CompanyContextStore);
  const router = inject(Router);
  const permission = permissionFrom(route.data);
  const companyId = route.parent?.paramMap.get('companyId') ?? route.paramMap.get('companyId');
  if (!companyId || !permission) {
    return router.parseUrl('/forbidden');
  }
  const loaded = await context.load(companyId);
  if (loaded === 'not-found') {
    return router.parseUrl('/not-found');
  }
  if (loaded === 'forbidden' || !context.has(permission)) {
    return router.parseUrl('/forbidden');
  }
  return true;
};

export const adminHomeGuard: CanActivateFn = async (route) => {
  const context = inject(CompanyContextStore);
  const router = inject(Router);
  const companyId = route.parent?.paramMap.get('companyId');
  if (!companyId) {
    return router.parseUrl('/not-found');
  }
  const loaded = await context.load(companyId);
  if (loaded !== 'ok') {
    return router.parseUrl(loaded === 'forbidden' ? '/forbidden' : '/not-found');
  }
  const first = visibleNav(context.grants()).find((item) => item.admin);
  if (!first) {
    return router.parseUrl('/forbidden');
  }
  return router.parseUrl(`/c/${companyId}/${first.path}`);
};

export function loginRedirect(value: string | null): string | null {
  return safeAppPath(value);
}

function unavailableTree(router: Router, url: string): UrlTree {
  return router.createUrlTree(['/unavailable'], { queryParams: { redirect: url } });
}

/** Rewrites only the company path segment, leaving the query string as it is. */
export function canonicalCompanyUrl(url: string, companyId: string): string {
  const canonical = companyId.toLowerCase();
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const withoutHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = withoutHash.indexOf('?');
  const path = queryAt >= 0 ? withoutHash.slice(0, queryAt) : withoutHash;
  const query = queryAt >= 0 ? withoutHash.slice(queryAt) : '';
  const parts = path.split('/');
  const index = parts.indexOf(companyId);
  if (index >= 0) {
    parts[index] = canonical;
  }
  return `${parts.join('/')}${query}${hash}`;
}

function permissionFrom(data: object): string | null {
  if (!('permission' in data)) {
    return null;
  }
  const value = data['permission'];
  return typeof value === 'string' ? value : null;
}
