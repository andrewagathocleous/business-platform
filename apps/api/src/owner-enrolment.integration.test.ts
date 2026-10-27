import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createPrismaClient, type Prisma, type PrismaClient } from '@bp/db';
import { Logger } from 'nestjs-pino';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertDatabaseNameIsTest,
  assertEnvConnectionsTargetTestDatabase,
  assertTestDatabaseUrls,
} from '../../../tools/test-db-guard.mjs';
import { AppModule } from './app.module';
import { requireOrigin, runOwnerCli } from './cli/owner-commands';
import { correlationStorage } from './correlation/correlation';
import { PrismaService } from './database/prisma.service';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { SessionRefused, SessionService } from './identity/session.service';
import { hashToken } from './identity/tokens';
import { LOG_STREAM } from './logging/logging.module';

const run = randomUUID().split('-').join('').slice(0, 10);
const ORIGIN = 'http://127.0.0.1:3000';

type Agent = ReturnType<typeof request.agent>;

const profile = {
  sub: 'unset',
  email: undefined as string | undefined,
  emailVerified: false,
  preferredUsername: undefined as string | undefined,
  oid: undefined as string | undefined,
};

function useProfile(next: {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  preferredUsername?: string;
  oid?: string;
}) {
  profile.sub = next.sub;
  profile.email = next.email;
  profile.emailVerified = next.emailVerified ?? false;
  profile.preferredUsername = next.preferredUsername;
  profile.oid = next.oid;
}

const logs: string[] = [];
let app: INestApplication | undefined;
let oauth: { stop: () => Promise<void> } | undefined;
let issuerUrl = '';
let owner: PrismaClient | undefined;
const created: string[] = [];
const disabledByTest: string[] = [];

describe('platform owner enrolment', () => {
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
      token.payload.sub = profile.sub;
      token.payload.amr = ['pwd', 'mfa'];
      token.payload.tid = 'tenant-test';
      token.payload.oid = profile.oid ?? `oid-${profile.sub}`;
      token.payload.name = 'Owner Person';
      token.payload.email = profile.email ?? null;
      token.payload.preferred_username = profile.preferredUsername ?? null;
      token.payload.email_verified = profile.email === undefined ? false : profile.emailVerified;
    });
    await server.start(0, '127.0.0.1');
    oauth = server;
    issuerUrl = server.issuer.url ?? '';
    if (!issuerUrl) {
      throw new Error('mock issuer URL is missing');
    }
    process.env.APP_ENV = 'test';
    process.env.AUTH_DEV_LOGIN_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECURE = 'false';
    process.env.CSRF_SECRET = 'integration-test-csrf-secret';
    process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED = 'false';
    process.env.OIDC_ISSUER = issuerUrl;
    process.env.OIDC_CLIENT_ID = 'bp-test-client';
    process.env.OIDC_CLIENT_SECRET = 'bp-test-secret';
    process.env.OIDC_REDIRECT_URI = `${ORIGIN}/api/auth/oidc/callback`;
    process.env.APP_MASTER_KEYS = JSON.stringify({ k1: Buffer.alloc(32, 11).toString('base64') });
    process.env.APP_MASTER_KEY_ACTIVE = 'k1';
    delete process.env.THROTTLE_ENABLED_IN_TEST;
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        callback();
      },
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOG_STREAM)
      .useValue(stream)
      .compile();
    app = moduleRef.createNestApplication(caseSensitiveAdapter(), { bodyParser: false, abortOnError: false });
    app.useLogger(app.get(Logger));
    configureHttp(app);
    await app.init();
    const databases = await started()
      .get(PrismaService)
      .client.$queryRaw<{ current_database: string; current_user: string }[]>`
        SELECT current_database() AS current_database, current_user AS current_user
      `;
    assertDatabaseNameIsTest(databases[0]?.current_database, 'DATABASE_URL');
    expect(databases[0]?.current_user).toBe('bp_app');
    const ownerUrl = process.env.DATABASE_URL_OWNER;
    if (!ownerUrl) {
      throw new Error('DATABASE_URL_OWNER is required');
    }
    owner = createPrismaClient(ownerUrl);
    const roles = await owner.$queryRaw<{ current_database: string; current_user: string }[]>`
      SELECT current_database() AS current_database, current_user AS current_user
    `;
    assertDatabaseNameIsTest(roles[0]?.current_database, 'DATABASE_URL_OWNER');
    expect(roles[0]?.current_user).toBe('bp_owner');
  }, 120_000);

  afterAll(async () => {
    if (owner) {
      if (disabledByTest.length > 0) {
        await owner.userAccount.updateMany({ where: { id: { in: disabledByTest } }, data: { status: 'active' } });
      }
      if (created.length > 0) {
        await owner.platformOwnerEnrolment.deleteMany({ where: { userId: { in: created } } });
        await owner.userSession.deleteMany({ where: { userId: { in: created } } });
        await owner.userIdentity.deleteMany({ where: { userId: { in: created } } });
        await owner.userAccount.deleteMany({ where: { id: { in: created } } });
      }
      await owner.$disconnect();
    }
    await app?.close();
    await oauth?.stop();
  });

  it('enrols a new owner, links the identity and starts a session', async () => {
    const email = `owner-new-${run}@example.test`;
    const { code, token, out } = await enrol(email);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain(`${ORIGIN}/api/auth/oidc/start?enrolment=`);
    const user = await ownerDb().userAccount.findFirstOrThrow({ where: { email } });
    created.push(user.id);
    expect(user.isPlatformOwner).toBe(true);
    const stored = await ownerDb().platformOwnerEnrolment.findFirstOrThrow({ where: { userId: user.id } });
    expect(stored.tokenHash).not.toContain(token);
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    useProfile({ sub: `sub-new-${run}`, email, emailVerified: true });
    const browser = agent();
    const done = await finishOidc(browser, token, cid('happy'));
    expect(done.status, JSON.stringify(done.body)).toBe(302);
    const me = await browser.get('/api/me');
    expect(me.status).toBe(200);
    expect(record(record(me.body).user).isPlatformOwner).toBe(true);
    expect(record(record(me.body).user).email).toBe(email);
    const identity = await ownerDb().userIdentity.findFirstOrThrow({ where: { userId: user.id, provider: 'entra' } });
    expect(identity.subject).toBe(`sub-new-${run}`);
    expect(identity.issuer).toBe(issuerUrl);
    const consumed = await ownerDb().platformOwnerEnrolment.findUniqueOrThrow({ where: { id: stored.id } });
    expect(consumed.consumedAt).not.toBeNull();
    expect(await auditActions(cid('happy'))).toContain('platform.owner_enrolled');

    const reused = await finishOidc(agent(), token, cid('reused'));
    expect(reused.status).toBe(403);
    expect(await denialReasons(cid('reused'))).toContain('enrolment_unavailable');
  });

  it('refuses an expired, revoked, unknown, mismatched or unverified link', async () => {
    const email = `owner-deny-${run}@example.test`;
    const first = await enrol(email);
    created.push((await ownerDb().userAccount.findFirstOrThrow({ where: { email } })).id);
    const second = await enrol(email);
    useProfile({ sub: `sub-deny-${run}`, email, emailVerified: true });
    const revoked = await finishOidc(agent(), first.token, cid('revoked'));
    expect(revoked.status).toBe(403);
    expect(await denialReasons(cid('revoked'))).toContain('enrolment_unavailable');

    const unknown = await finishOidc(agent(), 'not-a-real-enrolment-token', cid('unknown'));
    expect(unknown.status).toBe(403);
    expect(await denialReasons(cid('unknown'))).toContain('enrolment_not_found');

    useProfile({ sub: `sub-deny-${run}`, email: `someone-else-${run}@example.test`, emailVerified: true });
    const mismatch = await finishOidc(agent(), second.token, cid('mismatch'));
    expect(mismatch.status).toBe(403);
    expect(await denialReasons(cid('mismatch'))).toContain('enrolment_email_mismatch');

    // An unverified email, even with a matching preferred_username, is not enough for an owner.
    useProfile({ sub: `sub-deny-${run}`, email, emailVerified: false, preferredUsername: email });
    const unverified = await finishOidc(agent(), second.token, cid('unverified'));
    expect(unverified.status).toBe(403);
    expect(await denialReasons(cid('unverified'))).toContain('enrolment_email_mismatch');

    const stillOpen = await ownerDb().platformOwnerEnrolment.findFirstOrThrow({
      where: { user: { email }, consumedAt: null, revokedAt: null },
    });
    await ownerDb().platformOwnerEnrolment.update({
      where: { id: stillOpen.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    useProfile({ sub: `sub-deny-${run}`, email, emailVerified: true });
    const expired = await finishOidc(agent(), second.token, cid('expired'));
    expect(expired.status).toBe(403);
    expect(await denialReasons(cid('expired'))).toContain('enrolment_unavailable');
    expect(await ownerDb().userIdentity.count({ where: { user: { email } } })).toBe(0);
  });

  it('matches the Entra object id given at enrolment instead of the email', async () => {
    const email = `owner-oid-${run}@example.test`;
    const oid = randomUUID();
    const wrong = await enrol(email, ['--entra-oid', oid.toUpperCase()]);
    created.push((await ownerDb().userAccount.findFirstOrThrow({ where: { email } })).id);
    useProfile({ sub: `sub-oid-wrong-${run}`, email, emailVerified: true, oid: randomUUID() });
    const mismatch = await finishOidc(agent(), wrong.token, cid('oid-mismatch'));
    expect(mismatch.status).toBe(403);
    expect(await denialReasons(cid('oid-mismatch'))).toContain('enrolment_oid_mismatch');

    useProfile({ sub: `sub-oid-${run}`, oid });
    const matched = await finishOidc(agent(), wrong.token, cid('oid-match'));
    expect(matched.status, JSON.stringify(matched.body)).toBe(302);
    const identity = await ownerDb().userIdentity.findFirstOrThrow({ where: { user: { email }, provider: 'entra' } });
    expect(identity.entraOid).toBe(oid);
    expect((await cli(['enrol', '--email', 'y@example.test', '--name', 'Y', '--origin', ORIGIN, '--entra-oid', 'nope'])).code).toBe(2);
  });

  it('refuses an identity that already belongs to another user', async () => {
    const email = `owner-taken-${run}@example.test`;
    const { token } = await enrol(email);
    created.push((await ownerDb().userAccount.findFirstOrThrow({ where: { email } })).id);
    const other = await ownerDb().userAccount.create({
      data: { email: `other-${run}@example.test`, displayName: 'Other person (fictional)', locale: 'en' },
    });
    created.push(other.id);
    const subject = `sub-taken-${run}`;
    await ownerDb().userIdentity.create({
      data: { userId: other.id, provider: 'entra', issuer: issuerUrl, subject },
    });
    try {
      useProfile({ sub: subject, email, emailVerified: true });
      const taken = await finishOidc(agent(), token, cid('taken'));
      expect(taken.status).toBe(403);
      const reasons = await denialReasons(cid('taken'));
      expect(reasons.some((reason) => reason === 'identity_conflict')).toBe(true);
    } finally {
      await ownerDb().userIdentity.deleteMany({ where: { userId: other.id, provider: 'entra', subject } });
    }
  });

  it('lets exactly one of two concurrent callbacks with one link succeed', async () => {
    const email = `owner-race-${run}@example.test`;
    const { token } = await enrol(email);
    created.push((await ownerDb().userAccount.findFirstOrThrow({ where: { email } })).id);
    useProfile({ sub: `sub-race-${run}`, email, emailVerified: true });
    const left = agent();
    const right = agent();
    const leftCallback = await startAndAuthorize(left, token);
    const rightCallback = await startAndAuthorize(right, token);
    const [a, b] = await Promise.all([
      left.get(leftCallback).redirects(0),
      right.get(rightCallback).redirects(0),
    ]);
    expect([a.status, b.status].sort()).toEqual([302, 403]);
    expect(await ownerDb().userIdentity.count({ where: { user: { email }, provider: 'entra' } })).toBe(1);
  });

  it('gives no session when the identity was removed after the link was accepted', async () => {
    const email = `owner-race-session-${run}@example.test`;
    const user = await ownerDb().userAccount.create({
      data: { email, displayName: 'Session race (fictional)', locale: 'en', isPlatformOwner: true },
    });
    created.push(user.id);
    const sessions = started().get(SessionService);
    const issue = () =>
      correlationStorage.run({ correlationId: cid('session-guard') }, () =>
        sessions.issue({
          user: { ...user, locale: 'en' },
          authMethod: 'oidc',
          mfaSatisfied: true,
          previousCookie: undefined,
          meta: { ip: null, userAgent: null },
          requireIdentity: { issuer: issuerUrl, subject: `sub-gone-${run}` },
        }),
      );
    await expect(issue()).rejects.toBeInstanceOf(SessionRefused);
    expect(await ownerDb().userSession.count({ where: { userId: user.id } })).toBe(0);
  });

  it('does not let the application role make an owner or change an owner status', async () => {
    const appDb = started().get(PrismaService).client;
    await expect(
      appDb.$executeRaw`UPDATE user_account SET is_platform_owner = true WHERE email = 'admin.a@example.test'`,
    ).rejects.toThrow();
    await expect(
      appDb.userAccount.create({
        data: { email: `sneaky-${run}@example.test`, displayName: 'Sneaky (fictional)', locale: 'en', isPlatformOwner: true },
      }),
    ).rejects.toThrow();
    await expect(
      appDb.$executeRaw`UPDATE user_account SET status = 'disabled' WHERE email = 'owner@example.test'`,
    ).rejects.toThrow();
    await expect(
      appDb.$executeRaw`UPDATE user_account SET is_platform_owner = false WHERE email = 'owner@example.test'`,
    ).rejects.toThrow();
    expect((await ownerDb().userAccount.findFirstOrThrow({ where: { email: 'owner@example.test' } })).isPlatformOwner).toBe(
      true,
    );
    expect((await ownerDb().userAccount.findFirstOrThrow({ where: { email: 'admin.a@example.test' } })).isPlatformOwner).toBe(
      false,
    );
    const plain = await appDb.userAccount.create({
      data: { email: `plain-${run}@example.test`, displayName: 'Plain (fictional)', locale: 'en', isPlatformOwner: false },
    });
    created.push(plain.id);
  });

  it('refuses an invitation link to an account promoted to owner while the invitation waited', async () => {
    const email = `promoted-${run}@example.test`;
    const user = await ownerDb().userAccount.create({
      data: { email, displayName: 'Promoted (fictional)', locale: 'en' },
    });
    created.push(user.id);
    const company = await ownerDb().company.findFirstOrThrow({ where: { legalName: 'Demo Company A Ltd (fictional)' } });
    const inviter = await ownerDb().userAccount.findFirstOrThrow({ where: { email: 'admin.a@example.test' } });
    const invitationToken = randomBytes(32).toString('base64url');
    const invitation = await ownerDb().invitation.create({
      data: {
        companyId: company.id,
        email,
        roleAssignments: [{ roleKey: 'FIN', scopeType: 'company', scopeId: null }],
        tokenHash: hashToken(invitationToken),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        invitedById: inviter.id,
      },
    });
    try {
      // An unverified email with a matching username: enough for an ordinary invitation,
      // never for an owner.
      useProfile({ sub: `sub-promoted-${run}`, email, emailVerified: false, preferredUsername: email });
      const browser = agent();
      const start = await browser
        .get('/api/auth/oidc/start')
        .query({ redirect: '/', invitation: invitationToken })
        .redirects(0);
      const location = start.headers.location;
      if (typeof location !== 'string') {
        throw new Error('start redirect is missing');
      }
      const authorized = await fetch(location, { redirect: 'manual' });
      const callback = new URL(authorized.headers.get('location') ?? '');
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolveHeld) => {
        release = resolveHeld;
      });
      let lockTaken: () => void = () => undefined;
      const taken = new Promise<void>((resolveTaken) => {
        lockTaken = resolveTaken;
      });
      // The owner CLI's promotion: lock the account, set the flag, commit later.
      const promotion = ownerDb().$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM user_account WHERE id = ${user.id}::uuid FOR UPDATE`;
          await tx.userAccount.update({ where: { id: user.id }, data: { isPlatformOwner: true } });
          lockTaken();
          await held;
        },
        { timeout: 20_000 },
      );
      await taken;
      const pending = browser
        .get(`${callback.pathname}${callback.search}`)
        .set('X-Correlation-Id', cid('promoted'))
        .redirects(0)
        .then((response) => response);
      await waitForLockWait();
      release();
      await promotion;
      const response = await pending;
      expect(response.status).toBe(403);
      expect(await ownerDb().userIdentity.count({ where: { userId: user.id } })).toBe(0);
    } finally {
      await ownerDb().invitation.deleteMany({ where: { id: invitation.id } });
      await ownerDb().membership.deleteMany({ where: { userId: user.id } });
    }
  });

  it('does not let the application role create or alter an enrolment', async () => {
    const appDb = started().get(PrismaService).client;
    const user = await ownerDb().userAccount.findFirstOrThrow({ where: { email: 'owner@example.test' } });
    await expect(
      appDb.platformOwnerEnrolment.create({
        data: { userId: user.id, tokenHash: 'f'.repeat(64), expiresAt: new Date(Date.now() + 60_000) },
      }),
    ).rejects.toThrow();
    await expect(appDb.$executeRaw`UPDATE platform_owner_enrolment SET token_hash = token_hash`).rejects.toThrow();
    await expect(appDb.$executeRaw`UPDATE platform_owner_enrolment SET revoked_at = now()`).rejects.toThrow();
    await expect(appDb.$executeRaw`DELETE FROM platform_owner_enrolment`).rejects.toThrow();
    await expect(appDb.$executeRaw`UPDATE platform_owner_enrolment SET consumed_at = consumed_at WHERE false`).resolves.toBe(0);
  });

  it('refuses to re-enrol a linked owner without --relink, and relink revokes sessions', async () => {
    const email = `owner-relink-${run}@example.test`;
    const first = await enrol(email);
    const user = await ownerDb().userAccount.findFirstOrThrow({ where: { email } });
    created.push(user.id);
    useProfile({ sub: `sub-relink-${run}`, email, emailVerified: true });
    const browser = agent();
    expect((await finishOidc(browser, first.token, cid('relink-first'))).status).toBe(302);
    expect((await browser.get('/api/me')).status).toBe(200);

    const refused = await enrol(email);
    expect(refused.code).toBe(1);
    expect(refused.err.join('\n')).toContain('--relink');
    const relinked = await enrol(email, ['--relink']);
    expect(relinked.code).toBe(0);
    expect(await ownerDb().userIdentity.count({ where: { userId: user.id, provider: 'entra' } })).toBe(0);
    expect(await ownerDb().userSession.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    expect((await browser.get('/api/me')).status).toBe(401);

    useProfile({ sub: `sub-relink-new-${run}`, email, emailVerified: true });
    expect((await finishOidc(agent(), relinked.token, cid('relink-second'))).status).toBe(302);
    const identity = await ownerDb().userIdentity.findFirstOrThrow({ where: { userId: user.id, provider: 'entra' } });
    expect(identity.subject).toBe(`sub-relink-new-${run}`);
  });

  it('disables an owner but never the last active one', async () => {
    const keep = `owner-keep-${run}@example.test`;
    const drop = `owner-drop-${run}@example.test`;
    await enrol(keep);
    await enrol(drop);
    created.push((await ownerDb().userAccount.findFirstOrThrow({ where: { email: keep } })).id);
    created.push((await ownerDb().userAccount.findFirstOrThrow({ where: { email: drop } })).id);
    const dropped = await cli(['disable', '--email', drop]);
    expect(dropped.code).toBe(0);
    expect((await ownerDb().userAccount.findFirstOrThrow({ where: { email: drop } })).status).toBe('disabled');
    expect(
      await ownerDb().platformOwnerEnrolment.count({ where: { user: { email: drop }, consumedAt: null, revokedAt: null } }),
    ).toBe(0);

    const others = await ownerDb().userAccount.findMany({
      where: { isPlatformOwner: true, status: 'active', NOT: { email: keep } },
      select: { id: true },
    });
    await ownerDb().userAccount.updateMany({
      where: { id: { in: others.map((row) => row.id) } },
      data: { status: 'disabled' },
    });
    disabledByTest.push(...others.map((row) => row.id));
    const last = await cli(['disable', '--email', keep]);
    expect(last.code).toBe(1);
    expect(last.err.join('\n')).toContain('last active platform owner');
    expect((await ownerDb().userAccount.findFirstOrThrow({ where: { email: keep } })).status).toBe('active');
    const denied = await platformAudits({ action: 'platform.owner_disabled', outcome: 'denied', actorLabel: 'cli' });
    expect(record(denied[0]?.details).reason).toBe('last_owner');
    await ownerDb().userAccount.updateMany({
      where: { id: { in: disabledByTest } },
      data: { status: 'active' },
    });
    disabledByTest.length = 0;
  });

  it('lists owners without tokens and keeps tokens out of logs and audits', async () => {
    const email = `owner-list-${run}@example.test`;
    const { token } = await enrol(email);
    created.push((await ownerDb().userAccount.findFirstOrThrow({ where: { email } })).id);
    const listed = await cli(['list']);
    expect(listed.code).toBe(0);
    const text = listed.out.join('\n');
    expect(text).toContain(email);
    expect(text).toContain('microsoft: not linked');
    expect(text).not.toContain(token);
    const hash = (await ownerDb().platformOwnerEnrolment.findFirstOrThrow({ where: { user: { email } } })).tokenHash;
    expect(text).not.toContain(hash);
    useProfile({ sub: `sub-list-${run}`, email, emailVerified: true });
    await finishOidc(agent(), token, cid('list-login'));
    const joined = logs.join('\n');
    expect(joined).not.toContain(token);
    const audits = await platformAudits({ action: { startsWith: 'platform.' } });
    for (const event of audits) {
      expect(JSON.stringify(event.details)).not.toContain(token);
      expect(JSON.stringify(event.details)).not.toContain(hash);
    }
  });

  it('accepts an origin written with its default port', () => {
    expect(requireOrigin('https://example.test:443')).toBe('https://example.test');
    expect(requireOrigin('http://localhost:80')).toBe('http://localhost');
    expect(requireOrigin('https://localhost:8443/')).toBe('https://localhost:8443');
    expect(() => requireOrigin('https://example.test/?a=1')).toThrow();
    expect(() => requireOrigin('https://example.test/#x')).toThrow();
  });

  it('rejects bad arguments with usage and an invalid origin', async () => {
    expect((await cli([])).code).toBe(2);
    expect((await cli(['enrol', '--email', 'x@example.test', '--name', 'X'])).code).toBe(2);
    expect(
      (await cli(['enrol', '--email', 'x@example.test', '--name', 'X', '--origin', 'http://example.test'])).code,
    ).toBe(2);
    expect(
      (await cli(['enrol', '--email', 'x@example.test', '--name', 'X', '--origin', 'https://example.test/path'])).code,
    ).toBe(2);
    expect(await ownerDb().userAccount.count({ where: { email: 'x@example.test' } })).toBe(0);
  });
});

async function enrol(
  email: string,
  extra: string[] = [],
): Promise<{ code: number; token: string; out: string[]; err: string[] }> {
  const result = await cli(['enrol', '--email', email, '--name', 'Owner Test (fictional)', '--origin', ORIGIN, ...extra]);
  const link = result.out.find((line) => line.includes('enrolment='));
  const token = link ? (new URL(link).searchParams.get('enrolment') ?? '') : '';
  return { ...result, token };
}

async function cli(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOwnerCli(argv, ownerDb(), { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err };
}

async function startAndAuthorize(browser: Agent, token: string): Promise<string> {
  const start = await browser.get('/api/auth/oidc/start').query({ redirect: '/', enrolment: token }).redirects(0);
  expect(start.status).toBe(302);
  const location = start.headers.location;
  if (typeof location !== 'string') {
    throw new Error('start redirect is missing');
  }
  const response = await fetch(location, { redirect: 'manual' });
  const next = response.headers.get('location');
  if (response.status !== 302 || !next) {
    throw new Error(`authorize returned ${String(response.status)}`);
  }
  const callback = new URL(next);
  return `${callback.pathname}${callback.search}`;
}

async function finishOidc(browser: Agent, token: string, correlationId: string): Promise<request.Response> {
  const callback = await startAndAuthorize(browser, token);
  return browser.get(callback).set('X-Correlation-Id', correlationId).redirects(0);
}

/** Platform audit rows (no company) are visible only with platform scope on, even to bp_owner. */
function platformAudits(where: Prisma.AuditEventWhereInput) {
  return ownerDb().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform_scope', 'on', true)`;
    return tx.auditEvent.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      select: { action: true, outcome: true, details: true },
    });
  });
}

async function auditActions(correlationId: string): Promise<string[]> {
  const rows = await platformAudits({ correlationId });
  return rows.map((row) => row.action);
}

async function denialReasons(correlationId: string): Promise<string[]> {
  const rows = await platformAudits({ correlationId, outcome: 'denied' });
  return rows.map((row) => String(record(row.details).reason));
}

/** Waits until some backend is blocked on a lock. */
async function waitForLockWait(): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = await ownerDb().$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`;
    if ((rows[0]?.n ?? 0) > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for a lock wait');
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

function agent(): Agent {
  return request.agent(started().getHttpServer() as App);
}

function ownerDb(): PrismaClient {
  if (!owner) {
    throw new Error('owner client is missing');
  }
  return owner;
}

function started(): INestApplication {
  if (!app) {
    throw new Error('the API was not started');
  }
  return app;
}

function cid(name: string): string {
  return `r0a-${name}-${run}`;
}

function seedDatabase(): void {
  const root = resolve(process.cwd(), '../..');
  const result = spawnSync('pnpm', ['--filter', '@bp/db', 'seed'], { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`seed exited ${String(result.status ?? result.signal)}`);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('expected an object');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
