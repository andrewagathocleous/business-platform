import { Controller, Get, type INestApplication, Module, Post, Req } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { Logger } from 'nestjs-pino';
import { Writable } from 'node:stream';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertDatabaseNameIsTest,
  assertEnvConnectionsTargetTestDatabase,
  assertTestDatabaseUrls,
} from '../../../tools/test-db-guard.mjs';
import { AppModule } from './app.module';
import { AuditService } from './audit/audit.service';
import { Public } from './authz/public.decorator';
import { RequirePermission } from './authz/require-permission.decorator';
import { correlationStorage } from './correlation/correlation';
import { PrismaService } from './database/prisma.service';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { LOG_STREAM } from './logging/logging.module';

@Controller('probe')
class ProbeController {
  @Get()
  @RequirePermission('member.view')
  denied(): { ok: true } {
    return { ok: true };
  }

  @Post('raw')
  @Public()
  raw(@Req() req: Request & { rawBody?: Buffer }): { bytes: number } {
    return { bytes: req.rawBody?.length ?? 0 };
  }
}

@Module({
  controllers: [ProbeController],
})
class ProbeModule {}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const runId = randomUUID().slice(0, 8);

function cid(name: string): string {
  return `http-${name}-${runId}`;
}

function httpServer(application: INestApplication): App {
  return application.getHttpServer() as App;
}

function responseBody(response: request.Response): unknown {
  return response.body as unknown;
}

function applyTestEnv(): void {
  process.env.APP_ENV = 'test';
  process.env.AUTH_DEV_LOGIN_ENABLED = 'false';
  process.env.SESSION_COOKIE_SECURE = 'false';
  process.env.CSRF_SECRET = 'integration-test-csrf-secret';
  process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED = 'false';
  process.env.OIDC_ISSUER = '';
  process.env.OIDC_CLIENT_ID = '';
  process.env.OIDC_CLIENT_SECRET = '';
  delete process.env.THROTTLE_ENABLED_IN_TEST;
  process.env.OIDC_REDIRECT_URI = '';
  process.env.APP_MASTER_KEYS = JSON.stringify({ k1: Buffer.alloc(32, 9).toString('base64') });
  process.env.APP_MASTER_KEY_ACTIVE = 'k1';
}

describe('HTTP API', () => {
  let app: INestApplication;
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const spy = vi.spyOn(stream, 'write');

  beforeAll(async () => {
    applyTestEnv();
    const refusal = assertTestDatabaseUrls();
    if (refusal) {
      throw new Error(refusal);
    }
    await assertEnvConnectionsTargetTestDatabase();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, ProbeModule],
    })
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
    const roles = await prisma.client.$queryRaw<{ current_user: string }[]>`SELECT current_user`;
    expect(roles[0]?.current_user).toBe('bp_app');
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers live and ready and echoes a valid correlation id', async () => {
    const server = httpServer(app);
    const live = await request(server)
      .get('/api/health/live')
      .set('X-Correlation-Id', 'abcd-1234');
    expect(live.status).toBe(200);
    expect(responseBody(live)).toEqual({ status: 'ok' });
    expect(live.headers['x-correlation-id']).toBe('abcd-1234');
    expect(live.headers['access-control-allow-origin']).toBeUndefined();
    expect(String(live.headers['content-security-policy'])).toContain("default-src 'none'");

    const ready = await request(server).get('/api/health/ready');
    expect(ready.status).toBe(200);
    expect(responseBody(ready)).toEqual({ status: 'ok' });
    expect(ready.headers['x-correlation-id']).toMatch(UUID_V7);
  });

  it('echoes E2E_RUN_ID from ready only while that variable is set', async () => {
    const previous = process.env.E2E_RUN_ID;
    process.env.E2E_RUN_ID = '22222222-2222-4222-8222-222222222222';
    try {
      const marked = await request(httpServer(app)).get('/api/health/ready');
      expect(marked.status).toBe(200);
      expect(responseBody(marked)).toEqual({
        status: 'ok',
        runId: '22222222-2222-4222-8222-222222222222',
      });
    } finally {
      if (previous === undefined) {
        delete process.env.E2E_RUN_ID;
      } else {
        process.env.E2E_RUN_ID = previous;
      }
    }
    const plain = await request(httpServer(app)).get('/api/health/ready');
    expect(responseBody(plain)).toEqual({ status: 'ok' });
  });

  it('replaces an invalid correlation id', async () => {
    const response = await request(httpServer(app))
      .get('/api/health/live')
      .set('X-Correlation-Id', 'bad id');
    expect(response.headers['x-correlation-id']).toMatch(UUID_V7);
    expect(response.headers['x-correlation-id']).not.toBe('bad id');
  });

  it('returns the error shape without a stack trace', async () => {
    const response = await request(httpServer(app))
      .get('/api/missing-route')
      .set('X-Correlation-Id', 'missing-route-01');
    expect(response.status).toBe(404);
    const body = responseBody(response);
    expect(errorField(body, 'code')).toBe('not_found');
    expect(errorField(body, 'correlationId')).toBe('missing-route-01');
    expect(typeof errorField(body, 'message')).toBe('string');
    expect(JSON.stringify(body)).not.toContain('stack');
    expect(errorField(body, 'stack')).toBeUndefined();
  });

  it('rejects an oversized body', async () => {
    const response = await request(httpServer(app))
      .post('/api/probe/raw')
      .set('Content-Type', 'application/json')
      .send({ blob: 'x'.repeat(1_100_000) });
    expect(response.status).toBe(413);
    const body = responseBody(response);
    expect(errorField(body, 'code')).toBe('payload_too_large');
    expect(typeof errorField(body, 'correlationId')).toBe('string');
    expect(JSON.stringify(body)).not.toContain('stack');
  });

  it('captures the raw body for webhook routes', async () => {
    const response = await request(httpServer(app))
      .post('/api/probe/raw')
      .set('Content-Type', 'application/json')
      .send({ a: 1 });
    expect(response.status).toBe(201);
    const body = responseBody(response);
    expect(isRecord(body) && typeof body.bytes === 'number' ? body.bytes : 0).toBeGreaterThan(0);
  });

  it('redacts cookie and authorization headers in request logs', async () => {
    await request(httpServer(app))
      .get('/api/health/live')
      .set('Cookie', 'session=super-secret-cookie-value')
      .set('Authorization', 'Bearer super-secret-authorization-value');
    expect(spy).toHaveBeenCalled();
    const output = lines.join('');
    expect(output).not.toContain('super-secret-cookie-value');
    expect(output).not.toContain('super-secret-authorization-value');
    expect(output).toContain('[Redacted]');
  });

  it('redacts invitation tokens and OIDC query values in request logs', async () => {
    const sentinel = 'fictional-sentinel-token';
    await request(httpServer(app))
      .get('/api/health/live')
      .query({
        invitation: sentinel,
        code: sentinel,
        state: sentinel,
        session_state: sentinel,
        id_token: sentinel,
        token: sentinel,
        access_token: sentinel,
        keep: 'visible-query',
      });
    const output = lines.join('');
    expect(output).not.toContain(sentinel);
    expect(output).toContain('[Redacted]');
    expect(output).toContain('visible-query');
  });

  it('returns 401 and an audit event for a route without a session', async () => {
    const correlationId = cid('denied-route');
    const response = await request(httpServer(app))
      .get('/api/probe')
      .set('X-Correlation-Id', correlationId);
    expect(response.status).toBe(401);
    expect(responseBody(response)).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Authentication is required',
        correlationId,
      },
    });
    const events = await auditEvents(app, correlationId);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'authorization.denied',
        outcome: 'denied',
        correlationId,
        actorType: 'system',
      }),
    ]);
  });

  it('redacts secrets in audit details', async () => {
    const correlationId = cid('audit-redact');
    const audit = app.get(AuditService);
    const prisma = app.get(PrismaService);
    await correlationStorage.run({ correlationId }, async () => {
      await prisma.client.$transaction(async (tx) => {
        await audit.record(tx, {
          actorType: 'system',
          action: 'test.redact',
          objectType: 'test',
          outcome: 'success',
          details: { token: 'super-secret-token', note: 'visible' },
        });
      });
    });
    const events = await auditEvents(app, correlationId);
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toEqual({ token: '[Redacted]', note: 'visible' });
  });

  it('returns 404 for dev login and OIDC when they are disabled', async () => {
    const users = await request(httpServer(app)).get('/api/auth/dev/users');
    expect(users.status).toBe(404);
    expect(errorField(responseBody(users), 'code')).toBe('not_found');

    const start = await request(httpServer(app)).get('/api/auth/oidc/start');
    expect(start.status).toBe(404);
    expect(errorField(responseBody(start), 'code')).toBe('not_found');
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorField(body: unknown, field: string): unknown {
  if (!isRecord(body) || !isRecord(body.error)) {
    return undefined;
  }
  return body.error[field];
}

async function auditEvents(app: INestApplication, correlationId: string) {
  const prisma = app.get(PrismaService);
  return prisma.client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform_scope', 'on', true)`;
    return tx.auditEvent.findMany({ where: { correlationId } });
  });
}
