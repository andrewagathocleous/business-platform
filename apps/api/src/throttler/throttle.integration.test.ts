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

function applyThrottleEnv(): void {
  process.env.APP_ENV = 'test';
  process.env.AUTH_DEV_LOGIN_ENABLED = 'false';
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
}

describe('auth rate limit', () => {
  let app: INestApplication | undefined;
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  beforeAll(async () => {
    applyThrottleEnv();
    const refusal = assertTestDatabaseUrls();
    if (refusal) {
      throw new Error(refusal);
    }
    await assertEnvConnectionsTargetTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOG_STREAM)
      .useValue(stream)
      .compile();
    app = moduleRef.createNestApplication(caseSensitiveAdapter(), {
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
  }, 120_000);

  afterAll(async () => {
    delete process.env.THROTTLE_ENABLED_IN_TEST;
    if (app) {
      await app.close();
    }
  });

  it('returns 404 for an uppercase auth path and 429 on the normal path', async () => {
    if (!app) {
      throw new Error('the API was not started');
    }
    const server = app.getHttpServer() as App;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const upper = await request(server).get('/API/auth/dev/users');
      expect(upper.status).toBe(404);
      expect(upper.text).toContain('Cannot GET /API/auth/dev/users');
    }
    const first = await request(server).get('/api/auth/dev/users');
    const second = await request(server).get('/api/auth/dev/users');
    const third = await request(server).get('/api/auth/dev/users');
    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(third.status).toBe(429);
    expect(errorField(responseBody(third), 'code')).toBe('too_many_requests');
  });
});

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
