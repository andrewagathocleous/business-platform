import {
  HttpErrorResponse,
  HttpInterceptorFn,
  HttpRequest,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoService } from '@jsverse/transloco';
import { MessageService } from 'primeng/api';
import { catchError, throwError } from 'rxjs';
import { isVersionConflict, readApiError } from './api-error';
import { CompanyContextStore } from './company-context.store';
import { NAVIGATE_ON_DENIED } from './navigate-on-denied';
import { SessionStore } from './session.store';

export { NAVIGATE_ON_DENIED } from './navigate-on-denied';

export const apiInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);
  const messages = inject(MessageService);
  const transloco = inject(TranslocoService);
  const context = inject(CompanyContextStore);
  const session = inject(SessionStore);
  const sentGeneration = session.currentGeneration();
  const sentNavigation = activeNavigationId(router);
  return next(req.clone({ withCredentials: true })).pipe(
    catchError((error: unknown) => {
      handleError(error, router, messages, transloco, req, context, session, sentGeneration, sentNavigation);
      return throwError(() => error);
    }),
  );
};

/** The navigation this request belongs to: the one in progress, otherwise the last one that succeeded. */
export function activeNavigationId(router: Router): number {
  return router.currentNavigation()?.id ?? router.lastSuccessfulNavigation()?.id ?? 0;
}

function handleError(
  error: unknown,
  router: Router,
  messages: MessageService,
  transloco: TranslocoService,
  req: HttpRequest<unknown>,
  context: CompanyContextStore,
  session: SessionStore,
  sentGeneration: number,
  sentNavigation: number,
): void {
  if (!(error instanceof HttpErrorResponse)) {
    return;
  }
  if (error.status === 401) {
    if (session.currentGeneration() !== sentGeneration) {
      return;
    }
    context.reset();
    session.abandon();
    if (!isSessionProbe(req) && !router.url.startsWith('/login')) {
      const redirect = router.url.startsWith('/') ? router.url : '/';
      void router.navigate(['/login'], { queryParams: { redirect } });
    }
    return;
  }
  if (isVersionConflict(error)) {
    return;
  }
  const body = readApiError(error);
  const correlation = body.correlationId
    ? `${transloco.translate('errors.correlation')}: ${body.correlationId}`
    : '';
  messages.add({
    severity: error.status === 403 || error.status === 404 ? 'warn' : 'error',
    summary: body.message.length > 0 ? body.message : transloco.translate('errors.generic'),
    detail: correlation,
    life: 8000,
  });
  if (!req.context.get(NAVIGATE_ON_DENIED)) {
    return;
  }
  if (activeNavigationId(router) !== sentNavigation) {
    return;
  }
  if (error.status === 403) {
    void router.navigateByUrl('/forbidden');
  } else if (error.status === 404) {
    void router.navigateByUrl('/not-found');
  }
}

/** The startup session read. A 401 there means signed out, so the route guard sends the user to login. */
function isSessionProbe(req: HttpRequest<unknown>): boolean {
  return (
    req.method === 'GET' && req.headers.get('X-Session-Probe') === '1' && /\/api\/me$/.test(req.url)
  );
}
