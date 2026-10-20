import { type INestApplication } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, urlencoded, type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { API_GLOBAL_PREFIX } from './api-prefix';
import { CorrelationMiddleware } from '../correlation/correlation.middleware';
import { CORRELATION_HEADER, getCorrelationId, uuidv7 } from '../correlation/correlation';
import { mountSwagger } from '../openapi/swagger';
import { errorBody } from './error-body';

const BODY_LIMIT = '1mb';

export function captureRawBody(req: IncomingMessage, _res: ServerResponse, buf: Buffer): void {
  (req as IncomingMessage & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
}

export function configureHttp(app: INestApplication): void {
  const config = app.get<AppConfig>(APP_CONFIG);
  const correlation = new CorrelationMiddleware();
  // The adapter is created with this already on. Setting it again covers a router
  // created after this call. `/API/...` must not match `/api/...`.
  (app.getHttpAdapter().getInstance() as Express).set('case sensitive routing', true);
  app.setGlobalPrefix(API_GLOBAL_PREFIX);
  app.use((req: Request, res: Response, next: NextFunction) => {
    correlation.use(req, res, next);
  });
  app.use(apiHelmet(config));
  app.use(json({ limit: BODY_LIMIT, verify: captureRawBody }));
  app.use(urlencoded({ extended: true, limit: BODY_LIMIT, verify: captureRawBody }));
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const correlationId = getCorrelationId() ?? readHeader(res.getHeader(CORRELATION_HEADER)) ?? uuidv7();
    res.setHeader(CORRELATION_HEADER, correlationId);
    const rendered = errorBody(error, correlationId);
    res.status(rendered.status).json(rendered.body);
  });
  mountSwagger(app, config);
}

function apiHelmet(config: AppConfig) {
  const strict = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  });
  // Swagger UI needs inline scripts. Only the docs page in development and test gets them.
  const docs = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  return (req: Request, res: Response, next: NextFunction): void => {
    const docsPage =
      (config.appEnv === 'development' || config.appEnv === 'test') &&
      (req.path === '/api/docs' || req.path.startsWith('/api/docs/'));
    if (docsPage) {
      docs(req, res, next);
      return;
    }
    strict(req, res, next);
  };
}

function readHeader(value: number | string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return undefined;
}
