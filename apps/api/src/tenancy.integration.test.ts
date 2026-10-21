import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permittedScopeFilter, type Grant, type ScopeType } from '@bp/domain';
import {
  assertDatabaseNameIsTest,
  assertEnvConnectionsTargetTestDatabase,
  assertTestDatabaseUrls,
} from '../../../tools/test-db-guard.mjs';
import { AppModule } from './app.module';
import { resolvePermission } from './authz/resolve-permission';
import { PrismaService } from './database/prisma.service';
import { configureHttp } from './http/configure-http';
import { caseSensitiveAdapter } from './http/express-adapter';
import { hashToken } from './identity/tokens';
import { LOG_STREAM } from './logging/logging.module';

const COMPANY_A = 'Demo Company A Ltd (fictional)';
const COMPANY_B = 'Demo Company B Ltd (fictional)';
const SHOPIFY = 'Nutbox Demo Shopify';
const runId = randomUUID().slice(0, 8);

type Agent = ReturnType<typeof request.agent>;

describe('authorisation and tenancy', () => {
  let app: INestApplication | undefined;
  let companyA = '';
  let companyB = '';
  let ownerId = '';
  let shopifyStoreId = '';

  beforeAll(async () => {
    const refusal = assertTestDatabaseUrls();
    if (refusal) {
      throw new Error(refusal);
    }
    await assertEnvConnectionsTargetTestDatabase();
    seedDatabase();
    process.env.APP_ENV = 'test';
    process.env.AUTH_DEV_LOGIN_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECURE = 'false';
    process.env.CSRF_SECRET = 'integration-test-csrf-secret';
    process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED = 'false';
    delete process.env.THROTTLE_ENABLED_IN_TEST;
    app = await bootApp();
    primary = app;
    const prisma = app.get(PrismaService);
    const databases = await prisma.client.$queryRaw<{ current_database: string; current_user: string }[]>`
      SELECT current_database() AS current_database, current_user AS current_user
    `;
    assertDatabaseNameIsTest(databases[0]?.current_database, 'DATABASE_URL');
    expect(databases[0]?.current_user).toBe('bp_app');
    companyA = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_A } })).id;
    companyB = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_B } })).id;
    ownerId = (await prisma.client.userAccount.findFirstOrThrow({ where: { email: 'owner@example.test' } })).id;
    const stores = await prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.company_id', ${companyA}, true)`;
      return tx.store.findMany({ select: { id: true, name: true } });
    });
    const shopify = stores.find((store) => store.name === SHOPIFY);
    if (!shopify) {
      throw new Error('shopify store was not seeded');
    }
    shopifyStoreId = shopify.id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('returns company context, members and audit events to a member', async () => {
    const admin = await login('admin.a@example.test');
    const context = await admin.agent.get(`/api/c/${companyA}/context`);
    expect(context.status).toBe(200);
    const contextBody = record(payload(context));
    const company = record(contextBody.company);
    expect(company.legalName).toBe(COMPANY_A);
    expect(contextBody.mfaStepUpRequired).toBe(false);
    expect(contextBody.withheldPermissions).toEqual([]);
    expect(grants(contextBody).some((grant) => grant.permission === 'member.manage' && grant.scopeType === 'company')).toBe(
      true,
    );
    const switchRows = Array.isArray(contextBody.switches) ? contextBody.switches.flatMap((item) => [record(item)]) : [];
    const printing = switchRows.find((item) => item.key === 'printing');
    expect(printing?.enabled).toBe(true);

    const members = await admin.agent.get(`/api/c/${companyA}/members`);
    expect(members.status).toBe(200);
    expect(emails(record(payload(members)).members)).toContain('admin.a@example.test');

    const roles = await admin.agent.get(`/api/c/${companyA}/roles`);
    expect(roles.status).toBe(200);
    expect(keys(record(payload(roles)).roles)).toEqual(expect.arrayContaining(['CA', 'BASE', 'FS']));

    const audit = await admin.agent.get(`/api/c/${companyA}/audit-events`);
    expect(audit.status).toBe(200);
    expect(Array.isArray(record(payload(audit)).events)).toBe(true);
  });

  it('gives another company 404 and audits the denial', async () => {
    const correlationId = cid('cross-members');
    const adminB = await login('admin.b@example.test');
    const response = await adminB.agent.get(`/api/c/${companyA}/members`).set('X-Correlation-Id', correlationId);
    expect(response.status).toBe(404);
    expect(errorCode(payload(response))).toBe('not_found');
    const events = await auditEvents(correlationId, companyA);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'authorization.denied',
        outcome: 'denied',
        correlationId,
        companyId: companyA,
      }),
    ]);
    expect(detailReason(events[0]?.details)).toBe('not_a_member');
  });

  it('hides a guessed membership id from the other company', async () => {
    const correlationId = cid('guessed-member');
    const adminA = await login('admin.a@example.test');
    const listed = await adminA.agent.get(`/api/c/${companyA}/members`);
    const membershipId = memberId(record(payload(listed)).members, 'admin.a@example.test');
    const adminB = await login('admin.b@example.test');
    const response = await adminB.agent
      .get(`/api/c/${companyB}/members/${membershipId}`)
      .set('X-Correlation-Id', correlationId);
    expect(response.status).toBe(404);
    expect(errorCode(payload(response))).toBe('not_found');
    const events = await auditEvents(correlationId, companyB);
    expect(events[0]).toEqual(
      expect.objectContaining({ action: 'authorization.denied', outcome: 'denied', correlationId }),
    );
    expect(detailReason(events[0]?.details)).toBe('membership_not_found');
  });

  it('returns 403 and an audit event when the session lacks the permission', async () => {
    const correlationId = cid('missing-perm');
    const fulfil = await login('fulfil.a@example.test');
    const response = await fulfil.agent.get(`/api/c/${companyA}/members`).set('X-Correlation-Id', correlationId);
    expect(response.status).toBe(403);
    expect(errorCode(payload(response))).toBe('forbidden');
    const events = await auditEvents(correlationId, companyA);
    expect(detailReason(events[0]?.details)).toBe('permission_missing');
    expect(record(events[0]?.details).permission).toBe('member.view');
    expect(events[0]?.correlationId).toBe(correlationId);
  });

  it('keeps fulfilment scoped to one store and hides a store outside that scope', async () => {
    const fulfil = await login('fulfil.a@example.test');
    const context = await fulfil.agent.get(`/api/c/${companyA}/context`);
    expect(context.status).toBe(200);
    const actorGrants = grants(record(payload(context)));
    const order = actorGrants.filter((grant) => grant.permission === 'order.view');
    expect(order).toEqual([{ permission: 'order.view', scopeType: 'store', scopeId: shopifyStoreId }]);
    expect(actorGrants).toEqual(
      expect.arrayContaining([
        { permission: 'company.view', scopeType: 'company', scopeId: null },
        { permission: 'catalog.view', scopeType: 'company', scopeId: null },
      ]),
    );
    expect(actorGrants.some((grant) => grant.permission === 'member.manage')).toBe(false);
    const fakeStoreId = '00000000-0000-4000-8000-000000000099';
    await expect(
      resolvePermission(actorGrants, 'order.view', () =>
        Promise.resolve({ found: true, scopes: [{ type: 'store', id: fakeStoreId }] }),
      ),
    ).resolves.toBe('not_found');
    await expect(
      resolvePermission(actorGrants, 'order.view', () =>
        Promise.resolve({ found: true, scopes: [{ type: 'store', id: shopifyStoreId }] }),
      ),
    ).resolves.toBe('allow');
    expect(permittedScopeFilter(actorGrants, 'order.view', 'store')).toEqual({ kind: 'ids', ids: [shopifyStoreId] });
    expect(permittedScopeFilter(actorGrants, 'catalog.view', 'store')).toEqual({ kind: 'all' });
  });

  it('denies a suspended membership immediately and keeps the other company', async () => {
    const multi = await login('multi@example.test');
    const before = await multi.agent.get(`/api/c/${companyA}/members`);
    expect(before.status).toBe(200);
    const membershipId = await membershipFor('multi@example.test', companyA);
    const admin = await login('admin.a@example.test');
    const correlationId = cid('suspend-multi');
    try {
      const suspended = await admin.agent
        .patch(`/api/c/${companyA}/members/${membershipId}`)
        .set('X-Correlation-Id', correlationId)
        .set('X-XSRF-TOKEN', admin.xsrf)
        .send({ status: 'suspended' });
      expect(suspended.status).toBe(200);
      const afterId = cid('multi-after');
      const denied = await multi.agent.get(`/api/c/${companyA}/members`).set('X-Correlation-Id', afterId);
      expect(denied.status).toBe(404);
      expect(detailReason((await auditEvents(afterId, companyA))[0]?.details)).toBe('not_a_member');
      const other = await multi.agent.get(`/api/c/${companyB}/context`);
      expect(other.status).toBe(200);
      const events = await auditEvents(correlationId, companyA);
      expect(events).toEqual([
        expect.objectContaining({ action: 'membership.suspended', outcome: 'success', correlationId }),
      ]);
      const session = await started().get(PrismaService).client.userSession.findFirst({
        where: { user: { email: 'multi@example.test' }, revokedAt: null },
      });
      expect(session).toBeTruthy();
    } finally {
      await admin.agent
        .patch(`/api/c/${companyA}/members/${membershipId}`)
        .set('X-XSRF-TOKEN', admin.xsrf)
        .send({ status: 'active' });
    }
  });

  it('revokes sessions and the old cookie then returns 401', async () => {
    const finance = await login('finance.a@example.test');
    const membershipId = await membershipFor('finance.a@example.test', companyA);
    const admin = await login('admin.a@example.test');
    const correlationId = cid('revoke-sessions');
    const revoked = await admin.agent
      .post(`/api/c/${companyA}/members/${membershipId}/revoke-sessions`)
      .set('X-Correlation-Id', correlationId)
      .set('X-XSRF-TOKEN', admin.xsrf);
    expect(revoked.status).toBe(200);
    expect(record(payload(revoked)).revoked).toBeGreaterThan(0);
    const again = await finance.agent.get('/api/me').set('X-Correlation-Id', cid('revoked-me'));
    expect(again.status).toBe(401);
    const events = await auditEvents(correlationId, companyA);
    expect(events[0]).toEqual(
      expect.objectContaining({ action: 'member.sessions.revoked', outcome: 'success', correlationId }),
    );
    const denial = await auditEvents(cid('revoked-me'));
    expect(denial[0]).toEqual(expect.objectContaining({ action: 'authorization.denied', outcome: 'denied' }));
  });

  it('stops an operations manager from inviting', async () => {
    const correlationId = cid('ops-invite');
    const ops = await login('ops.a@example.test');
    const response = await ops.agent
      .post(`/api/c/${companyA}/invitations`)
      .set('X-Correlation-Id', correlationId)
      .set('X-XSRF-TOKEN', ops.xsrf)
      .send({ email: `ops.invite.${runId}@example.test`, assignments: [{ roleKey: 'FS', scopeType: 'company', scopeId: null }] });
    expect(response.status).toBe(403);
    const events = await auditEvents(correlationId, companyA);
    expect(detailReason(events[0]?.details)).toBe('permission_missing');
    expect(record(events[0]?.details).permission).toBe('member.invite');
  });

  it('enforces escalation and returns an invitation link once', async () => {
    const admin = await login('admin.a@example.test');
    const ownId = await membershipFor('admin.a@example.test', companyA);
    const self = await admin.agent
      .patch(`/api/c/${companyA}/members/${ownId}`)
      .set('X-Correlation-Id', cid('self-role'))
      .set('X-XSRF-TOKEN', admin.xsrf)
      .send({ assignments: [{ roleKey: 'FS', scopeType: 'company', scopeId: null }] });
    expect(self.status).toBe(403);
    expect(detailReason((await auditEvents(cid('self-role'), companyA))[0]?.details)).toBe('self_modification');
    const stillAdmin = await membershipGrants(ownId);
    expect(stillAdmin.some((grant) => grant.permission === 'member.manage')).toBe(true);

    const ownerFlag = await admin.agent
      .patch(`/api/c/${companyA}/members/${ownId}`)
      .set('X-XSRF-TOKEN', admin.xsrf)
      .send({ status: 'active', isPlatformOwner: true });
    expect(ownerFlag.status).toBe(400);
    const owner = await started().get(PrismaService).client.userAccount.findFirstOrThrow({
      where: { email: 'admin.a@example.test' },
    });
    expect(owner.isPlatformOwner).toBe(false);

    const suspendSelf = await admin.agent
      .patch(`/api/c/${companyA}/members/${ownId}`)
      .set('X-Correlation-Id', cid('self-suspend'))
      .set('X-XSRF-TOKEN', admin.xsrf)
      .send({ status: 'suspended' });
    expect(suspendSelf.status).toBe(403);
    expect(detailReason((await auditEvents(cid('self-suspend'), companyA))[0]?.details)).toBe('self_modification');

    const missingId = cid('missing-scope');
    const missing = await admin.agent
      .post(`/api/c/${companyA}/invitations`)
      .set('X-Correlation-Id', missingId)
      .set('X-XSRF-TOKEN', admin.xsrf)
      .send({ email: `missing.scope.${runId}@example.test`, assignments: [{ roleKey: 'FS', scopeType: 'store', scopeId: '00000000-0000-4000-8000-000000000099' }] });
    expect(missing.status).toBe(404);
    expect(detailReason((await auditEvents(missingId, companyA))[0]?.details)).toBe('scope_not_found');

    const correlationId = cid('invite-ok');
    const email = `invitee.${runId}@example.test`;
    const created = await admin.agent
      .post(`/api/c/${companyA}/invitations`)
      .set('X-Correlation-Id', correlationId)
      .set('X-XSRF-TOKEN', admin.xsrf)
      .send({
        email,
        assignments: [{ roleKey: 'FS', scopeType: 'store', scopeId: shopifyStoreId }, { roleKey: 'BASE', scopeType: 'company', scopeId: null }],
      });
    expect(created.status).toBe(200);
    const invitation = record(record(payload(created)).invitation);
    const link = String(invitation.link);
    const token = new URL(link, 'http://127.0.0.1').searchParams.get('invitation');
    expect(token).toBeTruthy();
    const row = await started().get(PrismaService).client.invitation.findUniqueOrThrow({ where: { id: String(invitation.id) } });
    expect(row.tokenHash).toBe(hashToken(token ?? ''));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(link).toContain('/api/auth/oidc/start?');
    const events = await auditEvents(correlationId, companyA);
    expect(events[0]).toEqual(expect.objectContaining({ action: 'invitation.created', outcome: 'success', correlationId }));

    const csrfId = cid('invite-csrf');
    const bare = await admin.agent
      .post(`/api/c/${companyA}/invitations`)
      .set('X-Correlation-Id', csrfId)
      .send({
        email: `csrf.${runId}@example.test`,
        assignments: [{ roleKey: 'BASE', scopeType: 'company', scopeId: null }],
      });
    expect(bare.status).toBe(403);
    expect(errorMessage(payload(bare))).toBe('CSRF token is missing or invalid');
    expect(detailReason((await auditEvents(csrfId))[0]?.details)).toBe('csrf');

    const ownerUser = await started().get(PrismaService).client.userAccount.findFirstOrThrow({
      where: { email: 'owner@example.test' },
    });
    const ownerMembership = await started().get(PrismaService).client.membership.create({
      data: { userId: ownerUser.id, companyId: companyA, status: 'active' },
    });
    try {
      const blocked = await admin.agent
        .patch(`/api/c/${companyA}/members/${ownerMembership.id}`)
        .set('X-Correlation-Id', cid('owner-target'))
        .set('X-XSRF-TOKEN', admin.xsrf)
        .send({ status: 'suspended' });
      expect(blocked.status).toBe(403);
      expect(detailReason((await auditEvents(cid('owner-target'), companyA))[0]?.details)).toBe('platform_owner_target');
    } finally {
      await started().get(PrismaService).client.membership.delete({ where: { id: ownerMembership.id } });
    }
  });

  it('refuses a grant the actor does not hold and audits a role change', async () => {
    const limited = await installUser(`grant.limit.${runId}@example.test`, companyA, ['member.invite', 'company.view']);
    const signer = await login(limited.email);
    const correlationId = cid('grant-no');
    const refused = await signer.agent
      .post(`/api/c/${companyA}/invitations`)
      .set('X-Correlation-Id', correlationId)
      .set('X-XSRF-TOKEN', signer.xsrf)
      .send({ email: `no.grant.${runId}@example.test`, assignments: [{ roleKey: 'CA', scopeType: 'company', scopeId: null }] });
    expect(refused.status).toBe(403);
    expect(detailReason((await auditEvents(correlationId, companyA))[0]?.details)).toBe('grant_not_allowed');

    const admin = await login('admin.a@example.test');
    const marketingId = await membershipFor('marketing.a@example.test', companyA);
    const roleCorrelation = cid('role-change');
    try {
      const changed = await admin.agent
        .patch(`/api/c/${companyA}/members/${marketingId}`)
        .set('X-Correlation-Id', roleCorrelation)
        .set('X-XSRF-TOKEN', admin.xsrf)
        .send({ assignments: [{ roleKey: 'CS', scopeType: 'company', scopeId: null }] });
      expect(changed.status).toBe(200);
      expect(keysOfMember(record(record(payload(changed)).member))).toEqual(['CS']);
      const events = await auditEvents(roleCorrelation, companyA);
      expect(events[0]).toEqual(
        expect.objectContaining({ action: 'membership.roles_updated', outcome: 'success', correlationId: roleCorrelation }),
      );
    } finally {
      await admin.agent
        .patch(`/api/c/${companyA}/members/${marketingId}`)
        .set('X-XSRF-TOKEN', admin.xsrf)
        .send({ assignments: [{ roleKey: 'MKT', scopeType: 'company', scopeId: null }] });
    }
  });

  it('lets only a platform owner suspend the last member.manage holder', async () => {
    const adminId = await membershipFor('admin.a@example.test', companyA);
    const admin = await login('admin.a@example.test');
    const owner = await login('owner@example.test');
    const context = await owner.agent.get(`/api/c/${companyA}/context`);
    expect(context.status).toBe(200);
    try {
      const suspended = await owner.agent
        .patch(`/api/c/${companyA}/members/${adminId}`)
        .set('X-Correlation-Id', cid('owner-suspend'))
        .set('X-XSRF-TOKEN', owner.xsrf)
        .send({ status: 'suspended' });
      expect(suspended.status).toBe(200);
      const revoked = await admin.agent.get(`/api/c/${companyA}/members`);
      expect(revoked.status).toBe(401);
      const fresh = await login('admin.a@example.test');
      const deniedId = cid('admin-suspended');
      const denied = await fresh.agent.get(`/api/c/${companyA}/members`).set('X-Correlation-Id', deniedId);
      expect(denied.status).toBe(404);
      expect(detailReason((await auditEvents(deniedId, companyA))[0]?.details)).toBe('not_a_member');
    } finally {
      await owner.agent
        .patch(`/api/c/${companyA}/members/${adminId}`)
        .set('X-XSRF-TOKEN', owner.xsrf)
        .send({ status: 'active' });
    }
  });

  it('creates, limits, expires and revokes service tokens', async () => {
    const admin = await login('admin.a@example.test');
    const correlationId = cid('token-create');
    const created = await admin.agent
      .post(`/api/c/${companyA}/service-identities`)
      .set('X-Correlation-Id', correlationId)
      .set('X-XSRF-TOKEN', admin.xsrf)
      .send({ name: 'Ingest', purpose: 'store events', permissions: ['store.events.ingest'] });
    expect(created.status).toBe(200);
    const token = String(record(payload(created)).token);
    const identityId = String(record(record(payload(created)).identity).id);
    expect(token.startsWith(`bps_${identityId}.`)).toBe(true);
    const secret = token.slice(`bps_${identityId}.`.length);
    const row = await started().get(PrismaService).client.serviceIdentity.findUniqueOrThrow({ where: { id: identityId } });
    expect(row.secretHash).toBe(hashToken(secret));
    expect(row.secretHash).not.toContain(secret);
    expect(JSON.stringify(record(payload(created)).identity)).not.toContain(secret);
    const events = await auditEvents(correlationId, companyA);
    expect(events[0]).toEqual(
      expect.objectContaining({ action: 'service_identity.created', outcome: 'success', correlationId }),
    );

    const ping = await request(httpServer(started()))
      .get(`/api/automation/v1/c/${companyA}/ping`)
      .set('Authorization', `Bearer ${token}`);
    expect(ping.status).toBe(200);
    expect(payload(ping)).toEqual({ ok: true });
    const used = await started().get(PrismaService).client.serviceIdentity.findUniqueOrThrow({ where: { id: identityId } });
    const again = await request(httpServer(started()))
      .get(`/api/automation/v1/c/${companyA}/ping`)
      .set('Authorization', `Bearer ${token}`);
    expect(again.status).toBe(200);
    const usedAgain = await started().get(PrismaService).client.serviceIdentity.findUniqueOrThrow({ where: { id: identityId } });
    expect(usedAgain.lastUsedAt?.toISOString()).toBe(used.lastUsedAt?.toISOString());

    const narrow = await admin.agent
      .post(`/api/c/${companyA}/service-identities`)
      .set('X-XSRF-TOKEN', admin.xsrf)
      .send({ name: 'Sync only', purpose: 'sync', permissions: ['store.sync.trigger'] });
    expect(narrow.status).toBe(200);
    const narrowToken = String(record(payload(narrow)).token);
    const outside = await request(httpServer(started()))
      .get(`/api/automation/v1/c/${companyA}/ping`)
      .set('Authorization', `Bearer ${narrowToken}`)
      .set('X-Correlation-Id', cid('token-forbidden'));
    expect(outside.status).toBe(403);
    expect(detailReason((await auditEvents(cid('token-forbidden'), companyA))[0]?.details)).toBe('permission_missing');

    const otherCompany = await request(httpServer(started()))
      .get(`/api/automation/v1/c/${companyB}/ping`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Correlation-Id', cid('token-cross'));
    expect(otherCompany.status).toBe(404);
    expect(detailReason((await auditEvents(cid('token-cross'), companyB))[0]?.details)).toBe('service_company_mismatch');

    const staff = await request(httpServer(started()))
      .get(`/api/c/${companyA}/context`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Correlation-Id', cid('token-staff'));
    expect(staff.status).toBe(401);
    expect(detailReason((await auditEvents(cid('token-staff')))[0]?.details)).toBe('bearer_on_staff_route');

    const limited = await installUser(`token.limit.${runId}@example.test`, companyA, ['service_identity.manage', 'company.view']);
    const signer = await login(limited.email);
    const refused = await signer.agent
      .post(`/api/c/${companyA}/service-identities`)
      .set('X-Correlation-Id', cid('token-held'))
      .set('X-XSRF-TOKEN', signer.xsrf)
      .send({ name: 'Too much', purpose: 'orders', permissions: ['order.view'] });
    expect(refused.status).toBe(403);
    expect(detailReason((await auditEvents(cid('token-held'), companyA))[0]?.details)).toBe('permission_not_held');
    const allowed = await signer.agent
      .post(`/api/c/${companyA}/service-identities`)
      .set('X-XSRF-TOKEN', signer.xsrf)
      .send({ name: 'Ingest limited', purpose: 'events', permissions: ['store.events.ingest'] });
    expect(allowed.status).toBe(200);

    await started().get(PrismaService).client.serviceIdentity.update({
      where: { id: identityId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await request(httpServer(started()))
      .get(`/api/automation/v1/c/${companyA}/ping`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Correlation-Id', cid('token-expired'));
    expect(expired.status).toBe(401);
    expect(detailReason((await auditEvents(cid('token-expired'), companyA))[0]?.details)).toBe('service_token_expired');

    const revoked = await admin.agent
      .delete(`/api/c/${companyA}/service-identities/${String(record(record(payload(narrow)).identity).id)}`)
      .set('X-Correlation-Id', cid('token-revoke'))
      .set('X-XSRF-TOKEN', admin.xsrf);
    expect(revoked.status).toBe(204);
    const afterRevoke = await request(httpServer(started()))
      .get(`/api/automation/v1/c/${companyA}/ping`)
      .set('Authorization', `Bearer ${narrowToken}`)
      .set('X-Correlation-Id', cid('token-revoked-use'));
    expect(afterRevoke.status).toBe(401);
    expect(detailReason((await auditEvents(cid('token-revoked-use'), companyA))[0]?.details)).toBe('service_token_revoked');
    expect((await auditEvents(cid('token-revoke'), companyA))[0]?.action).toBe('service_identity.revoked');
  });

  it('rejects a staff cookie on the automation ping route', async () => {
    const admin = await login('admin.a@example.test');
    const url = `/api/automation/v1/c/${companyA}/ping`;
    const without = await admin.agent.get(url).set('X-Correlation-Id', cid('cookie-ping'));
    const withHeader = await admin.agent.get(url).set('X-XSRF-TOKEN', admin.xsrf).set('X-Correlation-Id', cid('cookie-ping-xsrf'));
    expect(without.status).toBe(401);
    expect(withHeader.status).toBe(401);
    expect(detailReason((await auditEvents(cid('cookie-ping')))[0]?.details)).toBe('automation_requires_bearer');
    expect(detailReason((await auditEvents(cid('cookie-ping-xsrf')))[0]?.details)).toBe('automation_requires_bearer');
    const me = await admin.agent.get('/api/me');
    expect(me.status).toBe(200);
  });

  it('limits platform endpoints to the owner', async () => {
    const admin = await login('admin.a@example.test');
    const denied = await admin.agent.get('/api/platform/companies').set('X-Correlation-Id', cid('platform-no'));
    expect(denied.status).toBe(404);
    expect(detailReason((await auditEvents(cid('platform-no')))[0]?.details)).toBe('not_platform_owner');

    const owner = await login('owner@example.test');
    const listed = await owner.agent.get('/api/platform/companies');
    expect(listed.status).toBe(200);
    expect(names(record(payload(listed)).companies)).toEqual(expect.arrayContaining([COMPANY_A, COMPANY_B]));

    const correlationId = cid('company-create');
    const created = await owner.agent
      .post('/api/platform/companies')
      .set('X-Correlation-Id', correlationId)
      .set('X-XSRF-TOKEN', owner.xsrf)
      .send({
        legalName: `Created ${runId} Ltd (fictional)`,
        tradingName: `Created ${runId}`,
        isFictional: true,
      });
    expect(created.status).toBe(200);
    const createdId = String(record(record(payload(created)).company).id);
    const prisma = started().get(PrismaService);
    const roles = await prisma.client.role.findMany({ where: { companyId: createdId } });
    expect(roles.map((role) => role.key).sort()).toEqual(['AUD', 'BASE', 'CA', 'CS', 'FIN', 'FS', 'MKT', 'OM']);
    const taxes = await prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.company_id', ${createdId}, true)`;
      return tx.taxCode.findMany();
    });
    expect(taxes.map((tax) => tax.code).sort()).toEqual(['EXEMPT', 'RED5', 'RED9', 'STD19', 'ZERO']);
    expect(taxes.every((tax) => tax.isExample)).toBe(true);
    const switches = await prisma.client.automationSwitch.findMany({ where: { companyId: createdId } });
    expect(switches.map((item) => item.key).sort()).toEqual([
      'email.send',
      'invoice.issue_real',
      'marketing.send',
      'printing',
      'shipment.book',
      'social.publish',
      'store.write',
    ]);
    expect(switches.every((item) => !item.enabled)).toBe(true);
    expect((await auditEvents(correlationId, createdId))[0]?.action).toBe('company.created');

    const switchCorrelation = cid('outbound-all');
    try {
      const updated = await owner.agent
        .put('/api/platform/switches/outbound.all')
        .set('X-Correlation-Id', switchCorrelation)
        .set('X-XSRF-TOKEN', owner.xsrf)
        .send({ enabled: false, reason: 'integration test stop' });
      expect(updated.status).toBe(200);
      const globalSwitch = await prisma.client.automationSwitch.findFirstOrThrow({
        where: { companyId: null, key: 'outbound.all' },
      });
      expect(globalSwitch.enabled).toBe(false);
      const switchEvents = await auditEvents(switchCorrelation);
      expect(switchEvents[0]).toEqual(
        expect.objectContaining({
          action: 'automation_switch.updated',
          outcome: 'success',
          correlationId: switchCorrelation,
        }),
      );
      expect(record(switchEvents[0]?.details).reason).toBe('integration test stop');
    } finally {
      await owner.agent
        .put('/api/platform/switches/outbound.all')
        .set('X-XSRF-TOKEN', owner.xsrf)
        .send({ enabled: true, reason: 'integration test restore' });
    }
  });

  it('keeps one active admin when two admins suspend each other', async () => {
    const owner = await login('owner@example.test');
    const created = await owner.agent
      .post('/api/platform/companies')
      .set('X-XSRF-TOKEN', owner.xsrf)
      .send({ legalName: `Race ${runId} Ltd (fictional)`, tradingName: `Race ${runId}`, isFictional: true });
    expect(created.status).toBe(200);
    const raceCompany = String(record(record(payload(created)).company).id);
    const left = await installUser(`race.left.${runId}@example.test`, raceCompany, 'CA');
    const right = await installUser(`race.right.${runId}@example.test`, raceCompany, 'CA');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await reactivate(left.membershipId);
      await reactivate(right.membershipId);
      const leftSession = await login(left.email);
      const rightSession = await login(right.email);
      const [leftResponse, rightResponse] = await Promise.all([
        leftSession.agent
          .patch(`/api/c/${raceCompany}/members/${right.membershipId}`)
          .set('X-XSRF-TOKEN', leftSession.xsrf)
          .send({ status: 'suspended' }),
        rightSession.agent
          .patch(`/api/c/${raceCompany}/members/${left.membershipId}`)
          .set('X-XSRF-TOKEN', rightSession.xsrf)
          .send({ status: 'suspended' }),
      ]);
      const responses = [leftResponse, rightResponse];
      const failed = responses.filter((item) => item.status !== 200);
      expect(responses.filter((item) => item.status === 200)).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect([403, 404]).toContain(failed[0]?.status);
      const active = await started().get(PrismaService).client.membership.count({
        where: { companyId: raceCompany, status: 'active' },
      });
      expect(active).toBeGreaterThanOrEqual(1);
    }
  }, 120_000);

  async function installUser(
    email: string,
    companyId: string,
    permissionsOrRole: string[] | 'CA',
  ): Promise<{ email: string; membershipId: string }> {
    const prisma = started().get(PrismaService);
    const user = await prisma.client.userAccount.create({
      data: { email, displayName: email, locale: 'en', status: 'active', isPlatformOwner: false },
    });
    await prisma.client.userIdentity.create({
      data: {
        userId: user.id,
        provider: 'dev',
        issuer: 'https://dev-login.invalid',
        subject: email,
        emailAtLink: email,
      },
    });
    const membership = await prisma.client.membership.create({
      data: { userId: user.id, companyId, status: 'active' },
    });
    if (permissionsOrRole === 'CA') {
      const role = await prisma.client.role.findUniqueOrThrow({
        where: { companyId_key: { companyId, key: 'CA' } },
      });
      await prisma.client.membershipRole.create({
        data: {
          membershipId: membership.id,
          roleId: role.id,
          scopeType: 'company',
          scopeId: null,
          grantedById: ownerId,
        },
      });
    } else {
      const role = await prisma.client.role.create({
        data: {
          companyId,
          key: `custom-${randomUUID().slice(0, 8)}`,
          name: 'Custom test role',
          permissions: { create: permissionsOrRole.map((permission) => ({ permission })) },
        },
      });
      await prisma.client.membershipRole.create({
        data: {
          membershipId: membership.id,
          roleId: role.id,
          scopeType: 'company',
          scopeId: null,
          grantedById: ownerId,
        },
      });
    }
    return { email, membershipId: membership.id };
  }

  it('revokes every session when memberships in two companies are suspended together', async () => {
    const prisma = started().get(PrismaService).client;
    const multi = await prisma.userAccount.findFirstOrThrow({ where: { email: 'multi@example.test' } });
    const membershipA = await membershipFor('multi@example.test', companyA);
    const membershipB = await membershipFor('multi@example.test', companyB);
    const adminA = await login('admin.a@example.test');
    const adminB = await login('admin.b@example.test');
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await reactivate(membershipA);
        await reactivate(membershipB);
        const session = await login('multi@example.test');
        const [left, right] = await Promise.all([
          adminA.agent
            .patch(`/api/c/${companyA}/members/${membershipA}`)
            .set('X-Correlation-Id', cid(`both-a-${String(attempt)}`))
            .set('X-XSRF-TOKEN', adminA.xsrf)
            .send({ status: 'suspended' }),
          adminB.agent
            .patch(`/api/c/${companyB}/members/${membershipB}`)
            .set('X-Correlation-Id', cid(`both-b-${String(attempt)}`))
            .set('X-XSRF-TOKEN', adminB.xsrf)
            .send({ status: 'suspended' }),
        ]);
        expect(left.status).toBe(200);
        expect(right.status).toBe(200);
        const open = await prisma.userSession.count({ where: { userId: multi.id, revokedAt: null } });
        expect(open).toBe(0);
        const me = await session.agent.get('/api/me');
        expect(me.status).toBe(401);
      }
    } finally {
      await reactivate(membershipA);
      await reactivate(membershipB);
    }
  }, 60_000);

  it('does not deadlock when suspension and a replacement login run together', async () => {
    const person = await installUser(`deadlock.${runId}@example.test`, companyA, 'CA');
    const prisma = started().get(PrismaService).client;
    const user = await prisma.userAccount.findFirstOrThrow({ where: { email: person.email } });
    const admin = await login('admin.a@example.test');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await reactivate(person.membershipId);
      const session = await login(person.email);
      const before = await prisma.userSession.findMany({
        where: { userId: user.id, revokedAt: null },
        select: { id: true },
      });
      const [suspended, signedIn] = await Promise.all([
        admin.agent
          .patch(`/api/c/${companyA}/members/${person.membershipId}`)
          .set('X-Correlation-Id', cid(`deadlock-suspend-${String(attempt)}`))
          .set('X-XSRF-TOKEN', admin.xsrf)
          .send({ status: 'suspended' }),
        session.agent.post('/api/auth/dev/login').send({ email: person.email }),
      ]);
      expect(suspended.status, JSON.stringify(suspended.body)).toBe(200);
      expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
      const membership = await prisma.membership.findUniqueOrThrow({ where: { id: person.membershipId } });
      expect(membership.status).toBe('suspended');
      const account = await prisma.userAccount.findUniqueOrThrow({ where: { id: user.id } });
      expect(account.status).toBe('active');
      for (const previous of before) {
        const row = await prisma.userSession.findUniqueOrThrow({ where: { id: previous.id } });
        expect(row.revokedAt).not.toBeNull();
      }
      const open = await prisma.userSession.count({ where: { userId: user.id, revokedAt: null } });
      expect(open).toBeLessThanOrEqual(1);
    }
  }, 60_000);

  it('requires a service token expiry and audits a lost revoke race', async () => {
    const admin = await login('admin.a@example.test');
    const omitted = await admin.agent
      .post(`/api/c/${companyA}/service-identities`)
      .set('X-XSRF-TOKEN', admin.xsrf)
      .send({ name: 'Default expiry', purpose: 'events', permissions: ['store.events.ingest'] });
    expect(omitted.status).toBe(200);
    const expiresAt = new Date(String(record(record(payload(omitted)).identity).expiresAt));
    const delta = expiresAt.getTime() - Date.now();
    expect(delta).toBeGreaterThan(89 * 24 * 60 * 60 * 1000);
    expect(delta).toBeLessThanOrEqual(90 * 24 * 60 * 60 * 1000 + 5_000);

    const past = await admin.agent
      .post(`/api/c/${companyA}/service-identities`)
      .set('X-XSRF-TOKEN', admin.xsrf)
      .send({
        name: 'Past',
        purpose: 'events',
        permissions: ['store.events.ingest'],
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
    expect(past.status).toBe(400);
    expect(errorMessage(payload(past))).toBe('expiresAt must be in the future');

    const forever = await admin.agent
      .post(`/api/c/${companyA}/service-identities`)
      .set('X-XSRF-TOKEN', admin.xsrf)
      .send({
        name: 'Forever',
        purpose: 'events',
        permissions: ['store.events.ingest'],
        expiresAt: new Date(Date.now() + 366 * 24 * 60 * 60 * 1000).toISOString(),
      });
    expect(forever.status).toBe(400);
    expect(errorMessage(payload(forever))).toBe('expiresAt must be at most 365 days ahead');

    const missing = await admin.agent
      .post(`/api/c/${companyA}/service-identities`)
      .set('X-XSRF-TOKEN', admin.xsrf)
      .send({
        name: 'Null expiry',
        purpose: 'events',
        permissions: ['store.events.ingest'],
        expiresAt: null,
      });
    expect(missing.status).toBe(400);
    expect(errorMessage(payload(missing))).toBe('expiresAt is invalid');

    const created = await admin.agent
      .post(`/api/c/${companyA}/service-identities`)
      .set('X-XSRF-TOKEN', admin.xsrf)
      .send({
        name: 'Race',
        purpose: 'events',
        permissions: ['store.events.ingest'],
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    expect(created.status).toBe(200);
    const identityId = String(record(record(payload(created)).identity).id);
    const firstId = cid('revoke-race-a');
    const secondId = cid('revoke-race-b');
    const [first, second] = await Promise.all([
      admin.agent
        .delete(`/api/c/${companyA}/service-identities/${identityId}`)
        .set('X-Correlation-Id', firstId)
        .set('X-XSRF-TOKEN', admin.xsrf),
      admin.agent
        .delete(`/api/c/${companyA}/service-identities/${identityId}`)
        .set('X-Correlation-Id', secondId)
        .set('X-XSRF-TOKEN', admin.xsrf),
    ]);
    const statuses = [first.status, second.status].sort((left, right) => left - right);
    expect(statuses).toEqual([204, 404]);
    const loser = first.status === 404 ? firstId : secondId;
    const denied = await auditEvents(loser, companyA);
    expect(denied[0]).toEqual(
      expect.objectContaining({ action: 'authorization.denied', outcome: 'denied', correlationId: loser }),
    );
  });

  it('returns 400 for a malformed audit uuid and 404 for a malformed path id', async () => {
    const admin = await login('admin.a@example.test');
    const objectId = await admin.agent
      .get(`/api/c/${companyA}/audit-events`)
      .query({ objectId: 'not-a-uuid' });
    expect(objectId.status).toBe(400);
    expect(errorCode(payload(objectId))).toBe('bad_request');
    const actorId = await admin.agent.get(`/api/c/${companyA}/audit-events`).query({ actorId: 'not-a-uuid' });
    expect(actorId.status).toBe(400);
    const member = await admin.agent
      .get(`/api/c/${companyA}/members/not-a-uuid`)
      .set('X-Correlation-Id', cid('bad-member'));
    expect(member.status).toBe(404);
    expect(detailReason((await auditEvents(cid('bad-member'), companyA))[0]?.details)).toBe('membership_not_found');
    const token = await admin.agent
      .delete(`/api/c/${companyA}/service-identities/not-a-uuid`)
      .set('X-Correlation-Id', cid('bad-token'))
      .set('X-XSRF-TOKEN', admin.xsrf);
    expect(token.status).toBe(404);
    expect(detailReason((await auditEvents(cid('bad-token'), companyA))[0]?.details)).toBe('service_identity_not_found');
    const company = await admin.agent
      .get('/api/c/not-a-uuid/context')
      .set('X-Correlation-Id', cid('bad-company'));
    expect(company.status).toBe(404);
    expect(company.status).not.toBe(500);
    expect(detailReason((await auditEvents(cid('bad-company')))[0]?.details)).toBe('invalid_company_id');
  });

  async function reactivate(membershipId: string): Promise<void> {
    await started().get(PrismaService).client.membership.update({
      where: { id: membershipId },
      data: { status: 'active', suspendedAt: null, removedAt: null },
    });
  }

  async function membershipFor(email: string, companyId: string): Promise<string> {
    const row = await started().get(PrismaService).client.membership.findFirstOrThrow({
      where: { companyId, user: { email } },
    });
    return row.id;
  }

  async function membershipGrants(membershipId: string): Promise<{ permission: string }[]> {
    const roles = await started().get(PrismaService).client.membershipRole.findMany({
      where: { membershipId },
      include: { role: { include: { permissions: true } } },
    });
    return roles.flatMap((role) => role.role.permissions);
  }
});

describe('privileged MFA withholding', () => {
  let app: INestApplication | undefined;
  let oauth: { stop: () => Promise<void> } | undefined;
  let issuerUrl = '';
  let companyA = '';
  let supportMembership = '';
  const profile = { sub: 'mfa-subject', amr: ['pwd'] as string[] };

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
      token.payload.amr = [...profile.amr];
      token.payload.tid = 'tenant-mfa';
      token.payload.oid = 'oid-mfa';
      token.payload.name = 'Support A';
      token.payload.email = 'support.a@example.test';
      token.payload.email_verified = true;
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
    process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED = 'true';
    process.env.OIDC_ISSUER = issuerUrl;
    process.env.OIDC_CLIENT_ID = 'bp-test-client';
    process.env.OIDC_CLIENT_SECRET = 'bp-test-secret';
    process.env.OIDC_REDIRECT_URI = 'http://127.0.0.1:3000/api/auth/oidc/callback';
    process.env.APP_MASTER_KEYS = JSON.stringify({ k1: Buffer.alloc(32, 11).toString('base64') });
    process.env.APP_MASTER_KEY_ACTIVE = 'k1';
    delete process.env.THROTTLE_ENABLED_IN_TEST;
    app = await bootApp();
    const prisma = mfaApp().get(PrismaService);
    companyA = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_A } })).id;
    supportMembership = (
      await prisma.client.membership.findFirstOrThrow({
        where: { companyId: companyA, user: { email: 'support.a@example.test' } },
      })
    ).id;
    await prisma.client.membershipRole.deleteMany({
      where: { membershipId: supportMembership, role: { key: 'CA' } },
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await oauth?.stop();
  });

  it('lists only active memberships when a platform owner has no MFA', async () => {
    const owner = await loginOn(mfaApp(), 'owner@example.test');
    const me = await owner.agent.get('/api/me');
    expect(me.status).toBe(200);
    expect(record(payload(me)).companies).toEqual([]);
    const support = await loginOn(mfaApp(), 'support.a@example.test');
    const supportMe = await support.agent.get('/api/me');
    expect(supportMe.status).toBe(200);
    const companies = record(payload(supportMe)).companies;
    expect(Array.isArray(companies) && companies.length > 0).toBe(true);
  });

  it('denies a non-MFA session after promotion until the user signs in with amr mfa', async () => {
    const prisma = mfaApp().get(PrismaService);
    const ownerDenied = await (await loginOn(mfaApp(), 'owner@example.test')).agent
      .get('/api/platform/companies')
      .set('X-Correlation-Id', cid('owner-mfa'));
    expect(ownerDenied.status).toBe(403);
    expect(detailReason((await auditEventsOn(mfaApp(), cid('owner-mfa')))[0]?.details)).toBe('mfa_required');

    const support = await loginOn(mfaApp(), 'support.a@example.test');
    const ca = await prisma.client.role.findUniqueOrThrow({ where: { companyId_key: { companyId: companyA, key: 'CA' } } });
    const owner = await prisma.client.userAccount.findFirstOrThrow({ where: { email: 'owner@example.test' } });
    await prisma.client.membershipRole.create({
      data: {
        membershipId: supportMembership,
        roleId: ca.id,
        scopeType: 'company',
        scopeId: null,
        grantedById: owner.id,
      },
    });
    const target = await prisma.client.userAccount.create({
      data: {
        email: `mfa.target.${runId}@example.test`,
        displayName: 'MFA target',
        locale: 'en',
        status: 'active',
      },
    });
    const targetMembership = await prisma.client.membership.create({
      data: { userId: target.id, companyId: companyA, status: 'active' },
    });
    try {
      const context = await support.agent.get(`/api/c/${companyA}/context`).set('X-Correlation-Id', cid('mfa-context'));
      expect(context.status).toBe(200);
      const body = record(payload(context));
      expect(body.mfaStepUpRequired).toBe(true);
      expect(body.withheldPermissions).toEqual(expect.arrayContaining(['member.manage']));
      expect(grants(body).some((grant) => grant.permission === 'member.manage')).toBe(false);
      const denied = await support.agent
        .patch(`/api/c/${companyA}/members/${targetMembership.id}`)
        .set('X-Correlation-Id', cid('mfa-denied'))
        .set('X-XSRF-TOKEN', support.xsrf)
        .send({ status: 'suspended' });
      expect(denied.status).toBe(403);
      expect(detailReason((await auditEventsOn(mfaApp(), cid('mfa-denied'), companyA))[0]?.details)).toBe('permission_missing');
      const unchanged = await prisma.client.membership.findUniqueOrThrow({ where: { id: targetMembership.id } });
      expect(unchanged.status).toBe('active');

      profile.sub = `mfa-${runId}`;
      profile.amr = ['mfa'];
      const supportUserId = (
        await prisma.client.userAccount.findFirstOrThrow({ where: { email: 'support.a@example.test' } })
      ).id;
      await prisma.client.userIdentity.deleteMany({ where: { userId: supportUserId, provider: 'entra' } });
      await prisma.client.userIdentity.create({
        data: { userId: supportUserId, provider: 'entra', issuer: issuerUrl, subject: profile.sub },
      });
      const agent = request.agent(httpServer(mfaApp()));
      const callback = await finishOidc(agent);
      expect(callback.status).toBe(302);
      const xsrf = cookieValue(cookieHeader(callback, 'XSRF-TOKEN'), 'XSRF-TOKEN');
      const stepped = await agent.get(`/api/c/${companyA}/context`);
      expect(stepped.status).toBe(200);
      expect(record(payload(stepped)).mfaStepUpRequired).toBe(false);
      expect(grants(record(payload(stepped))).some((grant) => grant.permission === 'member.manage')).toBe(true);
      const allowed = await agent
        .patch(`/api/c/${companyA}/members/${targetMembership.id}`)
        .set('X-Correlation-Id', cid('mfa-allowed'))
        .set('X-XSRF-TOKEN', xsrf)
        .send({ status: 'suspended' });
      expect(allowed.status).toBe(200);
      const events = await auditEventsOn(mfaApp(), cid('mfa-allowed'), companyA);
      expect(events[0]).toEqual(expect.objectContaining({ action: 'membership.suspended', outcome: 'success' }));
    } finally {
      await prisma.client.membershipRole.deleteMany({ where: { membershipId: supportMembership, roleId: ca.id } });
      await prisma.client.membership.update({
        where: { id: targetMembership.id },
        data: { status: 'active', suspendedAt: null },
      });
    }
  }, 60_000);

  function mfaApp(): INestApplication {
    if (!app) {
      throw new Error('the MFA API was not started');
    }
    return app;
  }
});

function started(): INestApplication {
  return appFrom('authorisation');
}

let primary: INestApplication | undefined;

function appFrom(which: string): INestApplication {
  if (which === 'authorisation' && primary) {
    return primary;
  }
  throw new Error(`${which} API was not started`);
}

async function bootApp(): Promise<INestApplication> {
  const stream = new Writable({
    write(_chunk: Buffer | string, _encoding, callback) {
      callback();
    },
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LOG_STREAM)
    .useValue(stream)
    .compile();
  const application = moduleRef.createNestApplication(caseSensitiveAdapter(), {
    bodyParser: false,
    abortOnError: false,
  });
  application.useLogger(application.get(Logger));
  configureHttp(application);
  await application.init();
  return application;
}

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

async function login(email: string): Promise<{ agent: Agent; xsrf: string }> {
  return loginOn(primaryApp(), email);
}

async function loginOn(application: INestApplication, email: string): Promise<{ agent: Agent; xsrf: string }> {
  const agent = request.agent(httpServer(application));
  const response = await agent.post('/api/auth/dev/login').send({ email });
  expect(response.status).toBe(200);
  return { agent, xsrf: cookieValue(cookieHeader(response, 'XSRF-TOKEN'), 'XSRF-TOKEN') };
}

function primaryApp(): INestApplication {
  if (!primary) {
    throw new Error('the API was not started');
  }
  return primary;
}

function httpServer(application: INestApplication): App {
  return application.getHttpServer() as App;
}

function cid(name: string): string {
  return `b3-${name}-${runId}`.slice(0, 64);
}

async function auditEvents(correlationId: string, companyId?: string) {
  return auditEventsOn(primaryApp(), correlationId, companyId);
}

async function auditEventsOn(application: INestApplication, correlationId: string, companyId?: string) {
  const prisma = application.get(PrismaService);
  return prisma.client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform_scope', 'on', true)`;
    if (companyId) {
      await tx.$executeRaw`SELECT set_config('app.company_id', ${companyId}, true)`;
    }
    return tx.auditEvent.findMany({ where: { correlationId }, orderBy: { occurredAt: 'asc' } });
  });
}

async function finishOidc(agent: Agent): Promise<request.Response> {
  const start = await agent.get('/api/auth/oidc/start').query({ redirect: '/after-login' }).redirects(0);
  expect(start.status).toBe(302);
  const location = start.headers.location;
  if (typeof location !== 'string') {
    throw new Error('start redirect is missing');
  }
  const authorize = await fetch(location, { redirect: 'manual' });
  if (authorize.status !== 302) {
    throw new Error(`authorize returned ${String(authorize.status)}`);
  }
  const next = authorize.headers.get('location');
  if (!next) {
    throw new Error('authorize redirect is missing');
  }
  const callback = new URL(next);
  return agent.get(`${callback.pathname}${callback.search}`).redirects(0);
}

function grants(body: Record<string, unknown>): Grant[] {
  if (!Array.isArray(body.grants)) {
    return [];
  }
  return body.grants.flatMap((item) => {
    const grant = record(item);
    if (typeof grant.permission !== 'string' || typeof grant.scopeType !== 'string') {
      return [];
    }
    const scopeType = grant.scopeType;
    if (!isScopeType(scopeType)) {
      return [];
    }
    return [{ permission: grant.permission, scopeType, scopeId: typeof grant.scopeId === 'string' ? grant.scopeId : null }];
  });
}

function isScopeType(value: string): value is ScopeType {
  return value === 'company' || value === 'store' || value === 'location' || value === 'mailbox' || value === 'integration_account';
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('expected an object');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function emails(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const row = record(item);
    return typeof row.email === 'string' ? [row.email] : [];
  });
}

function memberId(value: unknown, email: string): string {
  if (!Array.isArray(value)) {
    throw new Error('members missing');
  }
  const found = value.flatMap((item) => {
    const row = record(item);
    return row.email === email ? [row] : [];
  })[0];
  const id = found?.membershipId;
  if (typeof id !== 'string') {
    throw new Error(`membership for ${email} is missing`);
  }
  return id;
}

function keys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const key = record(item).key;
    return typeof key === 'string' ? [key] : [];
  });
}

function keysOfMember(value: Record<string, unknown>): string[] {
  if (!Array.isArray(value.assignments)) {
    return [];
  }
  return value.assignments.flatMap((item) => {
    const key = record(item).roleKey;
    return typeof key === 'string' ? [key] : [];
  });
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const name = record(item).legalName;
    return typeof name === 'string' ? [name] : [];
  });
}

function payload(response: request.Response): unknown {
  return response.body as unknown;
}

function errorCode(body: unknown): string | undefined {
  const error = record(body).error;
  const code = record(error).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(body: unknown): string | undefined {
  const error = record(body).error;
  const message = record(error).message;
  return typeof message === 'string' ? message : undefined;
}

function detailReason(details: unknown): string | undefined {
  if (!isRecord(details) || typeof details.reason !== 'string') {
    return undefined;
  }
  return details.reason;
}

function cookieHeader(response: request.Response, name: string): string {
  const header = response.headers['set-cookie'];
  const lines = header === undefined ? [] : typeof header === 'string' ? [header] : [...header];
  const found = lines.find((line) => line.startsWith(`${name}=`));
  if (!found) {
    throw new Error(`cookie ${name} was not set`);
  }
  return found;
}

function cookieValue(header: string, name: string): string {
  const value = header.slice(name.length + 1).split(';')[0];
  if (!value) {
    throw new Error(`cookie ${name} is empty`);
  }
  return value;
}
