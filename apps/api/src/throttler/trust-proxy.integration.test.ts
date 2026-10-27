import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { Writable } from 'node:stream';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertDatabaseNameIsTest,
  assertEnvConnectionsTargetTestDatabase,
  assertTestDatabaseUrls,
} from '../../../../tools/test-db-guard.mjs';
import { AppModule } from '../app.module';
import { PrismaService } from '../database/prisma.service';
import { configureHttp } from '../http/configure-http';
import { caseSensitiveAdapter } from '../http/express-adapter';
import { LOG_STREAM } from '../logging/logging.module';

const FORWARDED_A = '203.0.113.10';
const FORWARDED_B = '203.0.113.20';
const FORWARDED_LOGIN = '203.0.113.30';
const SPOOFED = '198.51.100.20';
const SPOOFED_NEXT = '198.51.100.21';
const SPOOFED_LAST = '198.51.100.22';

function applyEnv(hops: '0' | '1'): void {
  process.env.APP_ENV = 'test';
  process.env.AUTH_DEV_LOGIN_ENABLED = 'true';
  process.env.SESSION_COOKIE_SECURE = 'false';
  process.env.CSRF_SECRET = 'integration-test-csrf-secret';
  process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED = 'false';
  process.env.OIDC_ISSUER = '';
  process.env.OIDC_CLIENT_ID = '';
  process.env.OIDC_CLIENT_SECRET = '';
  process.env.OIDC_REDIRECT_URI = '';
  process.env.APP_MASTER_KEYS = JSON.stringify({ k1: Buffer.alloc(32, 9).toString('base64') });
  process.env.APP_MASTER_KEY_ACTIVE = 'k1';
  process.env.THROTTLE_ENABLED_IN_TEST = 'true';
  process.env.THROTTLE_AUTH_LIMIT = '2';
  process.env.TRUST_PROXY_HOPS = hops;
}

describe('trust proxy hops', () => {
  describe('TRUST_PROXY_HOPS=1', () => {
    let app: INestApplication | undefined;

    beforeAll(async () => {
      applyEnv('1');
      app = await boot();
    }, 120_000);

    afterAll(async () => {
      clearProxyEnv();
      if (app) {
        await app.close();
      }
    });

    it('throttles different forwarded addresses separately and audits the forwarded login address', async () => {
      const server = httpServer(app);
      const first = await request(server).get('/api/auth/dev/users').set('X-Forwarded-For', FORWARDED_A);
      const second = await request(server).get('/api/auth/dev/users').set('X-Forwarded-For', FORWARDED_A);
      const third = await request(server).get('/api/auth/dev/users').set('X-Forwarded-For', FORWARDED_A);
      const other = await request(server).get('/api/auth/dev/users').set('X-Forwarded-For', FORWARDED_B);
      expect(first.status).not.toBe(429);
      expect(second.status).not.toBe(429);
      expect(third.status).toBe(429);
      expect(errorField(responseBody(third), 'code')).toBe('too_many_requests');
      expect(other.status).not.toBe(429);

      const correlationId = `trust-proxy-forwarded-${String(Date.now())}`;
      const login = await request(server)
        .post('/api/auth/dev/login')
        .set('X-Forwarded-For', FORWARDED_LOGIN)
        .set('X-Correlation-Id', correlationId)
        .send({ email: 'admin.a@example.test' });
      expect(login.status).toBe(200);
      const events = await auditEvents(started(app), correlationId);
      expect(events).toEqual([
        expect.objectContaining({
          action: 'auth.login',
          outcome: 'success',
          ip: FORWARDED_LOGIN,
        }),
      ]);
    });
  });

  describe('TRUST_PROXY_HOPS=0', () => {
    let app: INestApplication | undefined;

    beforeAll(async () => {
      applyEnv('0');
      app = await boot();
    }, 120_000);

    afterAll(async () => {
      clearProxyEnv();
      if (app) {
        await app.close();
      }
    });

    it('ignores a client-supplied X-Forwarded-For for the limit and the audit ip', async () => {
      const server = httpServer(app);
      const correlationId = `trust-proxy-ignored-${String(Date.now())}`;
      const login = await request(server)
        .post('/api/auth/dev/login')
        .set('X-Forwarded-For', SPOOFED)
        .set('X-Correlation-Id', correlationId)
        .send({ email: 'admin.a@example.test' });
      expect(login.status).toBe(200);
      const events = await auditEvents(started(app), correlationId);
      const ip = events[0]?.ip;
      expect(ip).not.toBe(SPOOFED);
      expect(ip === '127.0.0.1' || ip === '::ffff:127.0.0.1' || ip === '::1').toBe(true);

      const first = await request(server).get('/api/auth/dev/users').set('X-Forwarded-For', SPOOFED);
      const second = await request(server).get('/api/auth/dev/users').set('X-Forwarded-For', SPOOFED_NEXT);
      const third = await request(server).get('/api/auth/dev/users').set('X-Forwarded-For', SPOOFED_LAST);
      expect(first.status).not.toBe(429);
      expect(second.status).not.toBe(429);
      expect(third.status).toBe(429);
      expect(errorField(responseBody(third), 'code')).toBe('too_many_requests');
    });
  });
});

function clearProxyEnv(): void {
  delete process.env.THROTTLE_ENABLED_IN_TEST;
  delete process.env.THROTTLE_AUTH_LIMIT;
  delete process.env.TRUST_PROXY_HOPS;
}

async function boot(): Promise<INestApplication> {
  const refusal = assertTestDatabaseUrls();
  if (refusal) {
    throw new Error(refusal);
  }
  await assertEnvConnectionsTargetTestDatabase();
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LOG_STREAM)
    .useValue(stream)
    .compile();
  const app = moduleRef.createNestApplication(caseSensitiveAdapter(), {
    bodyParser: false,
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  configureHttp(app);
  await app.init();
  const prisma = app.get(PrismaService);
  const databases = await prisma.client.$queryRaw<{ current_database: string }[]>`
    SELECT current_database() AS current_database
  `;
  assertDatabaseNameIsTest(databases[0]?.current_database, 'DATABASE_URL');
  return app;
}

function started(app: INestApplication | undefined): INestApplication {
  if (!app) {
    throw new Error('the API was not started');
  }
  return app;
}

function httpServer(app: INestApplication | undefined): App {
  return started(app).getHttpServer() as App;
}

function responseBody(response: request.Response): unknown {
  return response.body as unknown;
}

function errorField(body: unknown, field: string): unknown {
  if (!isRecord(body) || !isRecord(body.error)) {
    return undefined;
  }
  return body.error[field];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function auditEvents(application: INestApplication, correlationId: string) {
  const prisma = application.get(PrismaService);
  return prisma.client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform_scope', 'on', true)`;
    return tx.auditEvent.findMany({ where: { correlationId }, orderBy: { occurredAt: 'asc' } });
  });
}
