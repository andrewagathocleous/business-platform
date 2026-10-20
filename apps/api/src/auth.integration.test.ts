import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertDatabaseNameIsTest,
  assertEnvConnectionsTargetTestDatabase,
  assertTestDatabaseUrls,
} from '../../../tools/test-db-guard.mjs';
import { AppModule } from './app.module';
import { PrismaService } from './database/prisma.service';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { CLOCK } from './identity/clock';
import { IDLE_TIMEOUT_MS } from './identity/session-rules';
import { hashToken } from './identity/tokens';
import { LOG_STREAM } from './logging/logging.module';

const run = randomUUID().split('-').join('').slice(0, 12);

function cid(name: string): string {
  return `${name}-${run}`;
}
const NUTBOX = 'Nutbox (demo data)';
const OLIVE = 'Olive Grove (demo data)';
const COMPANY_A = 'Demo Company A Ltd (fictional)';

type Agent = ReturnType<typeof request.agent>;

const clock = {
  instant: new Date(),
  now(): Date {
    return new Date(this.instant.getTime());
  },
};

const profile = {
  sub: 'unset',
  email: undefined as string | undefined,
  emailVerified: false,
  preferredUsername: undefined as string | undefined,
  name: 'OIDC Person',
  amr: ['pwd'] as string[],
  tid: 'tenant-test',
  oid: 'oid-test',
};

function useProfile(overrides: {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  preferredUsername?: string;
  name?: string;
  amr?: string[];
  tid?: string;
  oid?: string;
}): void {
  profile.sub = overrides.sub;
  profile.email = overrides.email;
  profile.emailVerified = overrides.emailVerified ?? false;
  profile.preferredUsername = overrides.preferredUsername;
  profile.name = overrides.name ?? 'OIDC Person';
  profile.amr = overrides.amr ?? ['pwd'];
  profile.tid = overrides.tid ?? 'tenant-test';
  profile.oid = overrides.oid ?? `oid-${overrides.sub}`;
}

describe('authentication', () => {
  let app: INestApplication | undefined;
  let issuerUrl = '';
  let companyAId = '';
  let ownerId = '';
  let adminAId = '';
  let oauth: { stop: () => Promise<void> } | undefined;
  const stream = new Writable({
    write(_chunk: Buffer | string, _encoding, callback) {
      callback();
    },
  });

  beforeAll(async () => {
    const refusal = assertTestDatabaseUrls();
    if (refusal) {
      throw new Error(refusal);
    }
    await assertEnvConnectionsTargetTestDatabase();
    seedDatabase();

    const imported = await import('oauth2-mock-server');
    const server = new imported.OAuth2Server();
    await server.issuer.keys.generate('RS256');
    server.service.on('beforeTokenSigning', (...args: unknown[]) => {
      const token = args[0];
      if (!isRecord(token) || !isRecord(token.payload)) {
        return;
      }
      assignClaims(token.payload);
    });
    await server.start(0, '127.0.0.1');
    oauth = server;
    const url = server.issuer.url;
    if (!url) {
      throw new Error('mock issuer URL is missing');
    }
    issuerUrl = url;

    process.env.APP_ENV = 'test';
    process.env.AUTH_DEV_LOGIN_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECURE = 'false';
    process.env.CSRF_SECRET = 'integration-test-csrf-secret';
    process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED = 'false';
    process.env.OIDC_ISSUER = issuerUrl;
    process.env.OIDC_CLIENT_ID = 'bp-test-client';
    process.env.OIDC_CLIENT_SECRET = 'bp-test-secret';
    process.env.OIDC_REDIRECT_URI = 'http://127.0.0.1:3000/api/auth/oidc/callback';
    process.env.APP_MASTER_KEYS = JSON.stringify({ k1: Buffer.alloc(32, 11).toString('base64') });
    process.env.APP_MASTER_KEY_ACTIVE = 'k1';
    delete process.env.THROTTLE_ENABLED_IN_TEST;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOG_STREAM)
      .useValue(stream)
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication(caseSensitiveAdapter(), {
      bodyParser: false,
      abortOnError: false,
    });
    app.useLogger(app.get(Logger));
    configureHttp(app);
    await app.init();

    const prisma = started().get(PrismaService);
    const databases = await prisma.client.$queryRaw<{ current_database: string; current_user: string }[]>`
      SELECT current_database() AS current_database, current_user AS current_user
    `;
    assertDatabaseNameIsTest(databases[0]?.current_database, 'DATABASE_URL');
    expect(databases[0]?.current_user).toBe('bp_app');

    const company = await prisma.client.company.findFirst({ where: { legalName: COMPANY_A } });
    const owner = await prisma.client.userAccount.findFirst({ where: { email: 'owner@example.test' } });
    if (!company || !owner) {
      throw new Error('seed company A or platform owner is missing');
    }
    companyAId = company.id;
    ownerId = owner.id;
    adminAId = (
      await prisma.client.userAccount.findFirstOrThrow({ where: { email: 'admin.a@example.test' } })
    ).id;
  }, 120_000);

  beforeEach(() => {
    clock.instant = new Date();
  });

  afterAll(async () => {
    await app?.close();
    await oauth?.stop();
  });

  it('logs in through the development picker and lists only authorised companies', async () => {
    const server = httpServer(started());
    const users = await request(server).get('/api/auth/dev/users');
    expect(users.status).toBe(200);
    const emails = userEmails(responseBody(users));
    expect(emails).toEqual(expect.arrayContaining(['admin.a@example.test', 'multi@example.test', 'admin.b@example.test']));

    const correlationId = cid('dev-login-admin-a');
    const agent = request.agent(server);
    const login = await agent
      .post('/api/auth/dev/login')
      .set('X-Correlation-Id', correlationId)
      .send({ email: 'admin.a@example.test' });
    expect(login.status).toBe(200);
    const sessionHeader = cookieHeader(login, 'bp_session');
    const xsrfHeader = cookieHeader(login, 'XSRF-TOKEN');
    expect(cookieAttributes(sessionHeader)).toEqual(expect.arrayContaining(['httponly', 'samesite=lax', 'path=/']));
    expect(cookieAttributes(sessionHeader)).not.toContain('secure');
    expect(cookieAttributes(xsrfHeader)).toContain('samesite=strict');
    expect(cookieAttributes(xsrfHeader)).not.toContain('httponly');
    const sessionCookie = cookieValue(sessionHeader, 'bp_session');
    expect(JSON.stringify(responseBody(login))).not.toContain(sessionCookie);

    const row = await started().get(PrismaService).client.userSession.findUnique({
      where: { tokenHash: hashToken(sessionCookie) },
    });
    expect(row?.mfaSatisfied).toBe(false);
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.tokenHash).not.toBe(sessionCookie);

    const events = await auditEvents(started(), correlationId);
    expect(events).toEqual([
      expect.objectContaining({ action: 'auth.login', outcome: 'success', correlationId, actorType: 'user' }),
    ]);

    const me = await agent.get('/api/me');
    expect(me.status).toBe(200);
    expect(tradingNames(responseBody(me))).toEqual([NUTBOX]);
    expect(await companyNames('multi@example.test')).toEqual([NUTBOX, OLIVE]);
    expect(await companyNames('admin.b@example.test')).toEqual([OLIVE]);
    const active = await started().get(PrismaService).client.company.findMany({
      where: { status: 'active' },
      orderBy: [{ tradingName: 'asc' }, { id: 'asc' }],
      select: { tradingName: true },
    });
    expect(active.map((company) => company.tradingName)).toEqual(expect.arrayContaining([NUTBOX, OLIVE]));
    expect(await companyNames('owner@example.test')).toEqual(active.map((company) => company.tradingName));
    expect(await companyNames('suspended.a@example.test')).toEqual([]);
  });

  it('revokes the previous session cookie when the same browser logs in again', async () => {
    const agent = request.agent(httpServer(started()));
    const first = await agent.post('/api/auth/dev/login').send({ email: 'admin.a@example.test' });
    expect(first.status).toBe(200);
    const firstCookie = cookieValue(cookieHeader(first, 'bp_session'), 'bp_session');
    const second = await agent.post('/api/auth/dev/login').send({ email: 'admin.a@example.test' });
    expect(second.status).toBe(200);
    const stale = await request(httpServer(started())).get('/api/me').set('Cookie', `bp_session=${firstCookie}`);
    expect(stale.status).toBe(401);
    expect(errorMessage(responseBody(stale))).toBe('Authentication is required');
    const current = await agent.get('/api/me');
    expect(current.status).toBe(200);
  });

  it('returns 401 and an audit event for a revoked session', async () => {
    const correlationId = cid('revoked-session');
    const signedIn = await devLogin('admin.a@example.test');
    const row = await started().get(PrismaService).client.userSession.findUnique({
      where: { tokenHash: hashToken(signedIn.sessionCookie) },
    });
    if (!row) {
      throw new Error('session row is missing');
    }
    await started().get(PrismaService).client.userSession.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
    const denied = await signedIn.browser.get('/api/me').set('X-Correlation-Id', correlationId);
    expect(denied.status).toBe(401);
    expect(errorMessage(responseBody(denied))).toBe('Authentication is required');
    const events = await auditEvents(started(), correlationId);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'authorization.denied',
        outcome: 'denied',
        correlationId,
        actorType: 'user',
      }),
    ]);
    expect(detailReason(events[0]?.details)).toBe('revoked');
  });

  it('rejects logout without a matching CSRF token, then revokes the session', async () => {
    const signedIn = await devLogin('admin.b@example.test');
    const me = await signedIn.browser.get('/api/me');
    expect(me.status).toBe(200);
    const xsrf = cookieValue(cookieHeader(me, 'XSRF-TOKEN'), 'XSRF-TOKEN');

    const missingId = cid('csrf-missing');
    const missing = await signedIn.browser.post('/api/auth/logout').set('X-Correlation-Id', missingId);
    expect(missing.status).toBe(403);
    expect(errorMessage(responseBody(missing))).toBe('CSRF token is missing or invalid');
    const missingEvents = await auditEvents(started(), missingId);
    expect(missingEvents).toEqual([
      expect.objectContaining({ action: 'authorization.denied', outcome: 'denied', correlationId: missingId }),
    ]);
    expect(detailReason(missingEvents[0]?.details)).toBe('csrf');
    expect((await signedIn.browser.get('/api/me')).status).toBe(200);

    const wrongId = cid('csrf-wrong');
    const wrong = await signedIn.browser
      .post('/api/auth/logout')
      .set('X-Correlation-Id', wrongId)
      .set('X-XSRF-TOKEN', 'wrong-token');
    expect(wrong.status).toBe(403);
    expect(detailReason((await auditEvents(started(), wrongId))[0]?.details)).toBe('csrf');
    expect((await signedIn.browser.get('/api/me')).status).toBe(200);

    const logoutId = cid('logout-ok');
    const logout = await signedIn.browser
      .post('/api/auth/logout')
      .set('X-Correlation-Id', logoutId)
      .set('X-XSRF-TOKEN', xsrf);
    expect(logout.status).toBe(204);
    const after = await signedIn.browser.get('/api/me');
    expect(after.status).toBe(401);
    const events = await auditEvents(started(), logoutId);
    expect(events).toEqual([
      expect.objectContaining({ action: 'auth.logout', outcome: 'success', correlationId: logoutId }),
    ]);
  });

  it('records a login failure when the development email is unknown', async () => {
    const correlationId = cid('dev-unknown');
    const response = await request(httpServer(started()))
      .post('/api/auth/dev/login')
      .set('X-Correlation-Id', correlationId)
      .send({ email: 'nobody@example.test' });
    expect(response.status).toBe(401);
    expect(errorMessage(responseBody(response))).toBe('Authentication failed');
    const events = await auditEvents(started(), correlationId);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'auth.login',
        outcome: 'failure',
        correlationId,
        actorType: 'system',
      }),
    ]);
    expect(detailReason(events[0]?.details)).toBe('unknown_user');
  });

  it('rejects a bearer token on a staff route that also has a session cookie', async () => {
    const correlationId = cid('bearer-staff');
    const signedIn = await devLogin('admin.a@example.test');
    const denied = await signedIn.browser
      .get('/api/me')
      .set('Authorization', 'Bearer bps_not-a-staff-token')
      .set('X-Correlation-Id', correlationId);
    expect(denied.status).toBe(401);
    expect(errorMessage(responseBody(denied))).toBe('Bearer tokens are not accepted on staff routes');
    expect(detailReason((await auditEvents(started(), correlationId))[0]?.details)).toBe('bearer_on_staff_route');
    expect((await signedIn.browser.get('/api/me')).status).toBe(200);
  });

  it('expires a session on the idle deadline and extends last_seen at most once a minute', async () => {
    const signedIn = await devLogin('finance.a@example.test');
    const prisma = started().get(PrismaService).client;
    const sessionRow = await prisma.userSession.findUniqueOrThrow({
      where: { tokenHash: hashToken(signedIn.sessionCookie) },
    });
    const seenAt = sessionRow.lastSeenAt.getTime();

    clock.instant = new Date(seenAt + 30_000);
    expect((await signedIn.browser.get('/api/me')).status).toBe(200);
    const untouched = await prisma.userSession.findUniqueOrThrow({ where: { id: sessionRow.id } });
    expect(untouched.lastSeenAt.getTime()).toBe(seenAt);

    const touchedAt = seenAt + 61_000;
    clock.instant = new Date(touchedAt);
    expect((await signedIn.browser.get('/api/me')).status).toBe(200);
    const touched = await prisma.userSession.findUniqueOrThrow({ where: { id: sessionRow.id } });
    expect(touched.lastSeenAt.getTime()).toBe(touchedAt);
    expect(touched.idleExpiresAt.getTime()).toBe(touchedAt + IDLE_TIMEOUT_MS);

    clock.instant = new Date(touched.idleExpiresAt.getTime());
    const expired = await signedIn.browser.get('/api/me');
    expect(expired.status).toBe(401);
    clock.instant = new Date(touched.idleExpiresAt.getTime() - 1);
    expect((await signedIn.browser.get('/api/me')).status).toBe(200);
  });

  it('expires a session on the absolute deadline even after the idle window was refreshed', async () => {
    const signedIn = await devLogin('ops.a@example.test');
    const prisma = started().get(PrismaService).client;
    let sessionRow = await prisma.userSession.findUniqueOrThrow({
      where: { tokenHash: hashToken(signedIn.sessionCookie) },
    });
    for (let step = 0; step < 30 && sessionRow.idleExpiresAt.getTime() <= sessionRow.absoluteExpiresAt.getTime(); step += 1) {
      clock.instant = new Date(sessionRow.idleExpiresAt.getTime() - 1);
      expect((await signedIn.browser.get('/api/me')).status).toBe(200);
      sessionRow = await prisma.userSession.findUniqueOrThrow({ where: { id: sessionRow.id } });
    }
    expect(sessionRow.idleExpiresAt.getTime()).toBeGreaterThan(sessionRow.absoluteExpiresAt.getTime());
    clock.instant = new Date(sessionRow.absoluteExpiresAt.getTime() - 1);
    expect((await signedIn.browser.get('/api/me')).status).toBe(200);
    clock.instant = new Date(sessionRow.absoluteExpiresAt.getTime());
    expect((await signedIn.browser.get('/api/me')).status).toBe(401);
  });

  it('completes an OIDC login and records whether amr includes mfa', async () => {
    const subject = uniqueSubject('happy');
    const user = await started().get(PrismaService).client.userAccount.findFirstOrThrow({
      where: { email: 'admin.a@example.test' },
    });
    useProfile({ sub: subject, amr: ['pwd', 'mfa'], email: user.email, emailVerified: true, tid: 'tid-happy', oid: 'oid-happy' });
    await started().get(PrismaService).client.userIdentity.create({
      data: {
        userId: user.id,
        provider: 'entra',
        issuer: issuerUrl,
        subject,
        tenantId: 'tid-happy',
        entraOid: 'oid-happy',
      },
    });
    const agent = request.agent(httpServer(started()));
    const done = await finishOidc(agent, { redirect: '/after-login' });
    expect(done.status).toBe(302);
    expect(done.headers.location).toBe('/after-login');
    const me = await agent.get('/api/me');
    expect(me.status).toBe(200);
    expect(userEmail(responseBody(me))).toBe('admin.a@example.test');
    const cookie = cookieValue(cookieHeader(done, 'bp_session'), 'bp_session');
    const session = await started().get(PrismaService).client.userSession.findUniqueOrThrow({
      where: { tokenHash: hashToken(cookie) },
    });
    expect(session.mfaSatisfied).toBe(true);
    const identity = await started().get(PrismaService).client.userIdentity.findUniqueOrThrow({
      where: { provider_issuer_subject: { provider: 'entra', issuer: issuerUrl, subject } },
    });
    expect(identity.entraOid).toBe('oid-happy');
    expect(identity.tenantId).toBe('tid-happy');

    const plainSubject = uniqueSubject('plain');
    useProfile({ sub: plainSubject, amr: ['pwd'], oid: 'oid-plain' });
    await started().get(PrismaService).client.userIdentity.create({
      data: { userId: user.id, provider: 'entra', issuer: issuerUrl, subject: plainSubject },
    });
    const plainAgent = request.agent(httpServer(started()));
    const plain = await finishOidc(plainAgent, { redirect: '/after-login' });
    const plainCookie = cookieValue(cookieHeader(plain, 'bp_session'), 'bp_session');
    const plainSession = await started().get(PrismaService).client.userSession.findUniqueOrThrow({
      where: { tokenHash: hashToken(plainCookie) },
    });
    expect(plainSession.mfaSatisfied).toBe(false);
  });

  it('rejects a callback whose state does not match the stored flow', async () => {
    const agent = request.agent(httpServer(started()));
    const start = await agent.get('/api/auth/oidc/start').query({ redirect: '/after-login' }).redirects(0);
    expect(start.status).toBe(302);
    const callback = await authorize(locationOf(start));
    const state = callback.searchParams.get('state');
    if (!state) {
      throw new Error('state is missing');
    }
    callback.searchParams.set('state', 'wrong-state-value');
    const response = await agent.get(callbackTarget(callback)).redirects(0);
    expect(response.status).toBe(400);
    expect(errorMessage(responseBody(response))).toBe('Sign-in could not be completed');
    const flow = await started().get(PrismaService).client.authFlow.findFirst({ where: { stateHash: hashToken(state) } });
    expect(flow?.consumedAt).toBeNull();
  });

  it('rejects a callback whose nonce does not match and consumes the flow', async () => {
    const agent = request.agent(httpServer(started()));
    const start = await agent.get('/api/auth/oidc/start').query({ redirect: '/after-login' }).redirects(0);
    const callback = await authorize(locationOf(start));
    const state = callback.searchParams.get('state');
    if (!state) {
      throw new Error('state is missing');
    }
    await started().get(PrismaService).client.authFlow.updateMany({
      where: { stateHash: hashToken(state) },
      data: { nonce: 'different-nonce' },
    });
    const response = await agent.get(callbackTarget(callback)).redirects(0);
    expect(response.status).toBe(400);
    const flow = await started().get(PrismaService).client.authFlow.findFirstOrThrow({
      where: { stateHash: hashToken(state) },
    });
    expect(flow.consumedAt).toBeTruthy();
  });

  it('rejects a replayed callback', async () => {
    const subject = uniqueSubject('replay');
    const user = await started().get(PrismaService).client.userAccount.findFirstOrThrow({
      where: { email: 'admin.b@example.test' },
    });
    useProfile({ sub: subject, amr: ['mfa'] });
    await started().get(PrismaService).client.userIdentity.create({
      data: { userId: user.id, provider: 'entra', issuer: issuerUrl, subject },
    });
    const agent = request.agent(httpServer(started()));
    const start = await agent.get('/api/auth/oidc/start').query({ redirect: '/after-login' }).redirects(0);
    const flowCookie = cookieValue(cookieHeader(start, 'bp_oidc_flow'), 'bp_oidc_flow');
    const callback = await authorize(locationOf(start));
    const first = await agent.get(callbackTarget(callback)).redirects(0);
    expect(first.status).toBe(302);
    const second = await request(httpServer(started()))
      .get(callbackTarget(callback))
      .set('Cookie', `bp_oidc_flow=${flowCookie}`)
      .redirects(0);
    expect(second.status).toBe(400);
    expect(errorMessage(responseBody(second))).toBe('Sign-in could not be completed');
  });

  it('rejects a callback from another cookie jar or with no flow cookie, without consuming the flow', async () => {
    const subject = uniqueSubject('binding');
    const user = await started().get(PrismaService).client.userAccount.findFirstOrThrow({
      where: { email: 'multi@example.test' },
    });
    useProfile({ sub: subject, amr: ['mfa'] });
    await started().get(PrismaService).client.userIdentity.create({
      data: { userId: user.id, provider: 'entra', issuer: issuerUrl, subject },
    });
    const agent = request.agent(httpServer(started()));
    const start = await agent.get('/api/auth/oidc/start').query({ redirect: '/after-login' }).redirects(0);
    const callback = await authorize(locationOf(start));
    const state = callback.searchParams.get('state');
    if (!state) {
      throw new Error('state is missing');
    }
    const bare = await request(httpServer(started())).get(callbackTarget(callback)).redirects(0);
    expect(bare.status).toBe(400);
    const other = await request(httpServer(started()))
      .get(callbackTarget(callback))
      .set('Cookie', 'bp_oidc_flow=different-browser-token')
      .redirects(0);
    expect(other.status).toBe(400);
    const flow = await started().get(PrismaService).client.authFlow.findFirstOrThrow({
      where: { stateHash: hashToken(state) },
    });
    expect(flow.consumedAt).toBeNull();
    const success = await agent.get(callbackTarget(callback)).redirects(0);
    expect(success.status).toBe(302);
  });

  it('denies and audits an unprovisioned identity', async () => {
    const correlationId = cid('oidc-none');
    useProfile({ sub: uniqueSubject('none'), amr: ['mfa'], email: 'nobody-oidc@example.test', emailVerified: true });
    const agent = request.agent(httpServer(started()));
    const response = await finishOidc(agent, { redirect: '/after-login' }, correlationId);
    expect(response.status).toBe(403);
    expect(errorMessage(responseBody(response))).toBe('account not provisioned');
    const events = await auditEvents(started(), correlationId);
    expect(events).toEqual([
      expect.objectContaining({ action: 'auth.login', outcome: 'denied', correlationId, actorType: 'system' }),
    ]);
    expect(detailReason(events[0]?.details)).toBe('not_provisioned');
  });

  it('rejects open redirects', async () => {
    const server = httpServer(started());
    for (const redirect of ['https://evil.example/phish', '//evil.example', '/%2f%2fevil.example']) {
      const response = await request(server).get('/api/auth/oidc/start').query({ redirect }).redirects(0);
      expect(response.status).toBe(400);
      expect(errorMessage(responseBody(response))).toBe('redirect must be a relative path');
    }
    const allowed = await request(server)
      .get('/api/auth/oidc/start')
      .query({ redirect: '/after-login?x=1' })
      .redirects(0);
    expect(allowed.status).toBe(302);
  });

  it('accepts an invitation when the verified email matches and links the identity', async () => {
    const correlationId = cid('invite-match');
    const email = `Invitee.Fin.${randomUUID()}@example.test`;
    const token = await createInvitation(email);
    useProfile({
      sub: uniqueSubject('invite'),
      email: email.toLowerCase(),
      emailVerified: true,
      name: 'Invited Finance',
      amr: ['mfa'],
      tid: 'tid-invite',
      oid: 'oid-invite',
    });
    const agent = request.agent(httpServer(started()));
    const response = await finishOidc(agent, { redirect: '/welcome', invitation: token }, correlationId);
    expect(response.status).toBe(302);
    const user = await started().get(PrismaService).client.userAccount.findFirst({
      where: { email },
      include: { identities: true, memberships: { include: { roles: { include: { role: true } } } } },
    });
    expect(user?.displayName).toBe('Invited Finance');
    expect(user?.identities[0]?.issuer).toBe(issuerUrl);
    expect(user?.identities[0]?.entraOid).toBe('oid-invite');
    expect(user?.identities[0]?.tenantId).toBe('tid-invite');
    expect(user?.memberships[0]?.status).toBe('active');
    expect(user?.memberships[0]?.roles[0]?.role.key).toBe('FIN');
    expect(user?.memberships[0]?.roles[0]?.scopeType).toBe('company');
    expect(user?.memberships[0]?.roles[0]?.scopeId).toBeNull();
    const events = await auditEvents(started(), correlationId, companyAId);
    const actions = events.map((event) => event.action).sort();
    expect(actions).toEqual(['auth.login', 'invitation.accepted']);
    expect(events.every((event) => event.correlationId === correlationId && event.outcome === 'success')).toBe(true);
  });

  it('accepts an invitation when only preferred_username matches', async () => {
    const email = `Invitee.User.${randomUUID()}@example.test`;
    const token = await createInvitation(email);
    useProfile({
      sub: uniqueSubject('username'),
      email: 'other@example.test',
      emailVerified: false,
      preferredUsername: email.toUpperCase(),
      amr: ['pwd'],
    });
    const agent = request.agent(httpServer(started()));
    const response = await finishOidc(agent, { redirect: '/welcome', invitation: token });
    expect(response.status).toBe(302);
    const user = await started().get(PrismaService).client.userAccount.findFirst({ where: { email } });
    expect(user).toBeTruthy();
  });

  it('denies an invitation when neither email nor preferred_username matches', async () => {
    const correlationId = cid('invite-miss');
    const email = `Invitee.Miss.${randomUUID()}@example.test`;
    const token = await createInvitation(email);
    const subject = uniqueSubject('mismatch');
    useProfile({
      sub: subject,
      email: 'someone-else@example.test',
      emailVerified: true,
      preferredUsername: 'also-else@example.test',
    });
    const agent = request.agent(httpServer(started()));
    const response = await finishOidc(agent, { redirect: '/welcome', invitation: token }, correlationId);
    expect(response.status).toBe(403);
    expect(errorMessage(responseBody(response))).toBe('account not provisioned');
    const user = await started().get(PrismaService).client.userAccount.findFirst({ where: { email } });
    const identity = await started().get(PrismaService).client.userIdentity.findUnique({
      where: { provider_issuer_subject: { provider: 'entra', issuer: issuerUrl, subject } },
    });
    expect(user).toBeNull();
    expect(identity).toBeNull();
    const events = await auditEvents(started(), correlationId, companyAId);
    expect(detailReason(events[0]?.details)).toBe('invitation_email_mismatch');
    expect(events[0]?.outcome).toBe('denied');
    expect(events[0]?.correlationId).toBe(correlationId);
  });

  it('accepts one of two concurrent callbacks for the same invitation', async () => {
    const email = `Invitee.Race.${randomUUID()}@example.test`;
    const token = await createInvitation(email);
    useProfile({
      sub: uniqueSubject('race'),
      email,
      emailVerified: true,
      amr: ['mfa'],
    });
    const firstAgent = request.agent(httpServer(started()));
    const secondAgent = request.agent(httpServer(started()));
    const firstStart = await firstAgent.get('/api/auth/oidc/start').query({ redirect: '/welcome', invitation: token }).redirects(0);
    const secondStart = await secondAgent
      .get('/api/auth/oidc/start')
      .query({ redirect: '/welcome', invitation: token })
      .redirects(0);
    const firstCallback = await authorize(locationOf(firstStart));
    const secondCallback = await authorize(locationOf(secondStart));
    const [first, second] = await Promise.all([
      firstAgent.get(callbackTarget(firstCallback)).redirects(0),
      secondAgent.get(callbackTarget(secondCallback)).redirects(0),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([302, 403]);
    const users = await started().get(PrismaService).client.userAccount.findMany({ where: { email } });
    expect(users).toHaveLength(1);
    const invitation = await started().get(PrismaService).client.invitation.findUniqueOrThrow({
      where: { tokenHash: hashToken(token) },
    });
    expect(invitation.acceptedAt).toBeTruthy();
  });

  it('rejects acceptance when the inviter membership is no longer active', async () => {
    const correlationId = cid('invite-suspended');
    const email = `Invitee.Suspended.${randomUUID()}@example.test`;
    const permissions = [...new Set(['member.invite', ...(await finPermissions())])];
    const inviterId = await createAuthority(permissions, 'suspended');
    const token = await createInvitation(email, inviterId);
    useProfile({ sub: uniqueSubject('suspended-inviter'), email, emailVerified: true, amr: ['mfa'] });
    const response = await finishOidc(
      request.agent(httpServer(started())),
      { redirect: '/welcome', invitation: token },
      correlationId,
    );
    expect(response.status).toBe(403);
    expect(errorMessage(responseBody(response))).toBe('account not provisioned');
    await expectInvitationOpen(token, correlationId, 'inviter_not_authorized');
  });

  it('rejects acceptance when the inviter no longer holds member.invite', async () => {
    const correlationId = cid('invite-permission');
    const email = `Invitee.Permission.${randomUUID()}@example.test`;
    const inviterId = await createAuthority(await finPermissions(), 'active');
    const token = await createInvitation(email, inviterId);
    useProfile({ sub: uniqueSubject('permission-inviter'), email, emailVerified: true, amr: ['mfa'] });
    const response = await finishOidc(
      request.agent(httpServer(started())),
      { redirect: '/welcome', invitation: token },
      correlationId,
    );
    expect(response.status).toBe(403);
    expect(errorMessage(responseBody(response))).toBe('account not provisioned');
    await expectInvitationOpen(token, correlationId, 'inviter_permission_missing');
  });

  it('rejects acceptance when the inviter can no longer grant a stored role', async () => {
    const correlationId = cid('invite-grant');
    const email = `Invitee.Grant.${randomUUID()}@example.test`;
    const inviterId = await createAuthority(['member.invite'], 'active');
    const token = await createInvitation(email, inviterId);
    useProfile({ sub: uniqueSubject('grant-inviter'), email, emailVerified: true, amr: ['mfa'] });
    const response = await finishOidc(
      request.agent(httpServer(started())),
      { redirect: '/welcome', invitation: token },
      correlationId,
    );
    expect(response.status).toBe(403);
    expect(errorMessage(responseBody(response))).toBe('account not provisioned');
    await expectInvitationOpen(token, correlationId, 'grant_not_allowed');
  });

  it('rejects email linking when the account already has a different Entra identity', async () => {
    const correlationId = cid('invite-conflict');
    const email = `Linked.${randomUUID()}@example.test`;
    const prisma = started().get(PrismaService).client;
    const user = await prisma.userAccount.create({
      data: { email, displayName: 'Linked account', locale: 'en', status: 'active', isPlatformOwner: false },
    });
    await prisma.userIdentity.create({
      data: {
        userId: user.id,
        provider: 'entra',
        issuer: issuerUrl,
        subject: uniqueSubject('existing-entra'),
      },
    });
    const token = await createInvitation(email);
    useProfile({ sub: uniqueSubject('other-entra'), email, emailVerified: true, amr: ['mfa'] });
    const response = await finishOidc(
      request.agent(httpServer(started())),
      { redirect: '/welcome', invitation: token },
      correlationId,
    );
    expect(response.status).toBe(403);
    expect(errorMessage(responseBody(response))).toBe('account not provisioned');
    const identities = await prisma.userIdentity.count({ where: { userId: user.id, provider: 'entra' } });
    expect(identities).toBe(1);
    await expectInvitationOpen(token, correlationId, 'account_identity_conflict');
  });

  it('rejects an invitation that would link an Entra identity to a platform owner', async () => {
    const correlationId = cid('invite-owner');
    const prisma = started().get(PrismaService).client;
    const before = await prisma.userIdentity.count({ where: { userId: ownerId, provider: 'entra' } });
    const token = await createInvitation('owner@example.test');
    useProfile({
      sub: uniqueSubject('owner-link'),
      email: 'owner@example.test',
      emailVerified: true,
      amr: ['mfa'],
    });
    const response = await finishOidc(
      request.agent(httpServer(started())),
      { redirect: '/welcome', invitation: token },
      correlationId,
    );
    expect(response.status).toBe(403);
    expect(errorMessage(responseBody(response))).toBe('account not provisioned');
    const after = await prisma.userIdentity.count({ where: { userId: ownerId, provider: 'entra' } });
    expect(after).toBe(before);
    await expectInvitationOpen(token, correlationId, 'platform_owner_link');
  });

  it('links an Entra identity when the invited account does not have one yet', async () => {
    const email = `Unlinked.${randomUUID()}@example.test`;
    const prisma = started().get(PrismaService).client;
    const user = await prisma.userAccount.create({
      data: { email, displayName: 'Unlinked account', locale: 'en', status: 'active', isPlatformOwner: false },
    });
    const subject = uniqueSubject('first-entra');
    const token = await createInvitation(email);
    useProfile({ sub: subject, email, emailVerified: true, amr: ['mfa'] });
    const response = await finishOidc(request.agent(httpServer(started())), {
      redirect: '/welcome',
      invitation: token,
    });
    expect(response.status).toBe(302);
    const identity = await prisma.userIdentity.findUniqueOrThrow({
      where: { provider_issuer_subject: { provider: 'entra', issuer: issuerUrl, subject } },
    });
    expect(identity.userId).toBe(user.id);
  });

  function started(): INestApplication {
    if (!app) {
      throw new Error('the API was not started');
    }
    return app;
  }

  async function companyNames(email: string): Promise<string[]> {
    const signedIn = await devLogin(email);
    const me = await signedIn.browser.get('/api/me');
    expect(me.status).toBe(200);
    return tradingNames(responseBody(me));
  }

  async function devLogin(email: string): Promise<{ browser: Agent; sessionCookie: string }> {
    const browser = request.agent(httpServer(started()));
    const response = await browser.post('/api/auth/dev/login').send({ email });
    expect(response.status).toBe(200);
    return {
      browser,
      sessionCookie: cookieValue(cookieHeader(response, 'bp_session'), 'bp_session'),
    };
  }

  async function createInvitation(email: string, invitedById = adminAId): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await started().get(PrismaService).client.invitation.create({
      data: {
        companyId: companyAId,
        email,
        roleAssignments: [{ roleKey: 'FIN', scopeType: 'company', scopeId: null }],
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        invitedById,
      },
    });
    return token;
  }

  async function finPermissions(): Promise<string[]> {
    const role = await started().get(PrismaService).client.role.findUniqueOrThrow({
      where: { companyId_key: { companyId: companyAId, key: 'FIN' } },
      include: { permissions: true },
    });
    return role.permissions.map((permission) => permission.permission);
  }

  async function createAuthority(permissions: string[], status: 'active' | 'suspended'): Promise<string> {
    const prisma = started().get(PrismaService).client;
    const email = `inviter.${randomUUID()}@example.test`;
    const user = await prisma.userAccount.create({
      data: { email, displayName: 'Inviter', locale: 'en', status: 'active', isPlatformOwner: false },
    });
    const role = await prisma.role.create({
      data: {
        companyId: companyAId,
        key: `inv-${user.id}`,
        name: 'Invitation authority',
        permissions: { create: permissions.map((permission) => ({ permission })) },
      },
    });
    const membership = await prisma.membership.create({
      data: {
        userId: user.id,
        companyId: companyAId,
        status,
        suspendedAt: status === 'suspended' ? new Date() : null,
      },
    });
    await prisma.membershipRole.create({
      data: {
        membershipId: membership.id,
        roleId: role.id,
        scopeType: 'company',
        scopeId: null,
        grantedById: user.id,
      },
    });
    return user.id;
  }

  async function expectInvitationOpen(token: string, correlationId: string, reason: string): Promise<void> {
    const invitation = await started().get(PrismaService).client.invitation.findUniqueOrThrow({
      where: { tokenHash: hashToken(token) },
    });
    expect(invitation.acceptedAt).toBeNull();
    const events = await auditEvents(started(), correlationId, companyAId);
    expect(events[0]?.outcome).toBe('denied');
    expect(events[0]?.correlationId).toBe(correlationId);
    expect(detailReason(events[0]?.details)).toBe(reason);
  }

  async function finishOidc(
    browser: Agent,
    query: { redirect: string; invitation?: string },
    correlationId?: string,
  ): Promise<request.Response> {
    const params: Record<string, string> = { redirect: query.redirect };
    if (query.invitation) {
      params.invitation = query.invitation;
    }
    const start = await browser.get('/api/auth/oidc/start').query(params).redirects(0);
    expect(start.status).toBe(302);
    const callback = await authorize(locationOf(start));
    const follow = browser.get(callbackTarget(callback)).redirects(0);
    if (correlationId) {
      follow.set('X-Correlation-Id', correlationId);
    }
    return follow;
  }
});

function seedDatabase(): void {
  const root = resolve(process.cwd(), '../..');
  const result = spawnSync('pnpm', ['--filter', '@bp/db', 'seed'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`seed exited ${String(result.status ?? result.signal)}`);
  }
}

function assignClaims(payload: Record<string, unknown>): void {
  payload.sub = profile.sub;
  payload.amr = [...profile.amr];
  payload.tid = profile.tid;
  payload.oid = profile.oid;
  payload.name = profile.name;
  payload.email = profile.email ?? null;
  payload.preferred_username = profile.preferredUsername ?? null;
  payload.email_verified = profile.email === undefined ? false : profile.emailVerified;
}

async function authorize(location: string): Promise<URL> {
  const response = await fetch(location, { redirect: 'manual' });
  if (response.status !== 302) {
    throw new Error(`authorize returned ${String(response.status)}`);
  }
  const next = response.headers.get('location');
  if (!next) {
    throw new Error('authorize redirect is missing');
  }
  return new URL(next);
}

function callbackTarget(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function locationOf(response: request.Response): string {
  const location = response.headers.location;
  if (typeof location !== 'string' || location.length === 0) {
    throw new Error('start redirect is missing');
  }
  return location;
}

function httpServer(application: INestApplication): App {
  return application.getHttpServer() as App;
}

function responseBody(response: request.Response): unknown {
  return response.body as unknown;
}

function setCookies(response: request.Response): string[] {
  const header = response.headers['set-cookie'];
  if (header === undefined) {
    return [];
  }
  return typeof header === 'string' ? [header] : [...header];
}

function cookieHeader(response: request.Response, name: string): string {
  const header = setCookies(response).find((line) => line.startsWith(`${name}=`));
  if (!header) {
    throw new Error(`cookie ${name} was not set`);
  }
  return header;
}

function cookieValue(header: string, name: string): string {
  const value = header.slice(name.length + 1).split(';')[0];
  if (!value) {
    throw new Error(`cookie ${name} is empty`);
  }
  return value;
}

function cookieAttributes(header: string): string[] {
  return header
    .split(';')
    .slice(1)
    .map((part) => part.trim().toLowerCase());
}

function uniqueSubject(label: string): string {
  return `${label}-${randomUUID()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function userEmails(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.users)) {
    return [];
  }
  return body.users.flatMap((user) => (isRecord(user) && typeof user.email === 'string' ? [user.email] : []));
}

function userEmail(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.user) || typeof body.user.email !== 'string') {
    return undefined;
  }
  return body.user.email;
}

function tradingNames(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.companies)) {
    return [];
  }
  return body.companies.flatMap((company) =>
    isRecord(company) && typeof company.tradingName === 'string' ? [company.tradingName] : [],
  );
}

function errorMessage(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error) || typeof body.error.message !== 'string') {
    return undefined;
  }
  return body.error.message;
}

function detailReason(details: unknown): string | undefined {
  if (!isRecord(details) || typeof details.reason !== 'string') {
    return undefined;
  }
  return details.reason;
}

async function auditEvents(application: INestApplication, correlationId: string, companyId?: string) {
  const prisma = application.get(PrismaService);
  return prisma.client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform_scope', 'on', true)`;
    if (companyId) {
      await tx.$executeRaw`SELECT set_config('app.company_id', ${companyId}, true)`;
    }
    return tx.auditEvent.findMany({ where: { correlationId }, orderBy: { occurredAt: 'asc' } });
  });
}
