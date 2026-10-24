import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { writeAudit } from './auth-audit';
import { emailAtLink, parseOidcClaims, type ParsedOidcClaims } from './claims';
import { readCookie, OIDC_FLOW_COOKIE_NAME } from './cookies';
import { InvitationService } from './invitation.service';
import { OwnerEnrolmentService } from './owner-enrolment.service';
import { mfaSatisfiedFromAmr } from './mfa-policy';
import type { RequestMeta } from './request-meta';
import { openSecret, seal } from './secret-box';
import { OIDC_FLOW_TTL_MS } from './session-rules';
import { SessionRefused, SessionService } from './session.service';
import { hashToken, randomToken, tokenHashesMatch } from './tokens';

export type OidcStartResult = {
  authorizationUrl: string;
  flowCookie: string;
};

export type OidcCallbackResult =
  | { ok: true; redirectTo: string; token: string; sessionId: string }
  | { ok: false; status: 400 | 403; message: string };

type OidcConfiguration = import('openid-client').Configuration;

@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);
  private discovery: Promise<OidcConfiguration> | undefined;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(InvitationService) private readonly invitations: InvitationService,
    @Inject(OwnerEnrolmentService) private readonly enrolments: OwnerEnrolmentService,
  ) {}

  /** At most one of `invitation` and `enrolment` is set. Only their hashes are stored. */
  async start(
    redirectAfter: string,
    tokens: { invitation: string | null; enrolment: string | null },
  ): Promise<OidcStartResult> {
    if (tokens.invitation !== null && tokens.enrolment !== null) {
      throw new Error('an auth flow carries an invitation or an enrolment, not both');
    }
    const oidc = await import('openid-client');
    const configuration = await this.configuration();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const flowCookie = randomToken();
    await this.prisma.client.authFlow.create({
      data: {
        stateHash: hashToken(state),
        browserBindingHash: hashToken(flowCookie),
        nonce,
        codeVerifier: seal(verifier, this.config.masterKeys, this.config.activeMasterKeyId),
        redirectAfter,
        invitationTokenHash: tokens.invitation ? hashToken(tokens.invitation) : null,
        enrolmentTokenHash: tokens.enrolment ? hashToken(tokens.enrolment) : null,
        expiresAt: new Date(Date.now() + OIDC_FLOW_TTL_MS),
      },
    });
    const url = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: this.config.oidcRedirectUri,
      scope: 'openid email profile',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
      response_type: 'code',
    });
    return { authorizationUrl: url.href, flowCookie };
  }

  async callback(req: Request, meta: RequestMeta, previousCookie: string | undefined): Promise<OidcCallbackResult> {
    const url = this.callbackUrl(req);
    const state = url.searchParams.get('state');
    if (!state || url.searchParams.get('error') || !url.searchParams.get('code')) {
      await this.fail(meta, 'state');
      return protocolFailure();
    }
    const flow = await this.prisma.client.authFlow.findFirst({ where: { stateHash: hashToken(state) } });
    if (!flow) {
      await this.fail(meta, 'state');
      return protocolFailure();
    }
    const flowCookie = readCookie(req.header('cookie'), OIDC_FLOW_COOKIE_NAME);
    const presented = hashToken(flowCookie ?? '');
    if (!flowCookie || !tokenHashesMatch(presented, flow.browserBindingHash)) {
      await this.fail(meta, 'binding');
      return protocolFailure();
    }
    const consumed = await this.prisma.client.$queryRaw<{ id: string }[]>`
      UPDATE auth_flow
      SET consumed_at = now()
      WHERE id = CAST(${flow.id} AS uuid)
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id
    `;
    if (consumed.length !== 1) {
      await this.fail(meta, 'replay');
      return protocolFailure();
    }
    let verifier: string;
    try {
      verifier = openSecret(flow.codeVerifier, this.config.masterKeys);
    } catch {
      await this.fail(meta, 'verifier');
      return protocolFailure();
    }
    let claims: ParsedOidcClaims;
    try {
      claims = await this.exchange(url, { state, nonce: flow.nonce, verifier });
    } catch (error) {
      this.logger.warn(`OIDC token exchange failed: ${errorName(error)}`);
      await this.fail(meta, 'token');
      return protocolFailure();
    }
    const resolved = await this.resolveUser(flow.invitationTokenHash, flow.enrolmentTokenHash, claims, meta);
    if (!resolved.ok) {
      return resolved;
    }
    const user = await this.prisma.client.userAccount.findUnique({ where: { id: resolved.userId } });
    if (!user || user.status !== 'active') {
      await this.deny(meta, 'user_disabled', null, null);
      return { ok: false, status: 403, message: 'account not provisioned' };
    }
    let issued: Awaited<ReturnType<SessionService['issue']>>;
    try {
      issued = await this.sessions.issue({
        user,
        authMethod: 'oidc',
        mfaSatisfied: mfaSatisfiedFromAmr(claims.amr),
        previousCookie,
        meta,
        requireIdentity: { issuer: claims.issuer, subject: claims.subject },
      });
    } catch (error) {
      if (error instanceof SessionRefused) {
        await this.deny(meta, 'identity_revoked', null, user.id);
        return { ok: false, status: 403, message: 'account not provisioned' };
      }
      throw error;
    }
    return {
      ok: true,
      redirectTo: flow.redirectAfter && flow.redirectAfter.length > 0 ? flow.redirectAfter : '/',
      token: issued.token,
      sessionId: issued.session.sessionId,
    };
  }

  private async resolveUser(
    invitationTokenHash: string | null,
    enrolmentTokenHash: string | null,
    claims: ParsedOidcClaims,
    meta: RequestMeta,
  ): Promise<{ ok: true; userId: string } | { ok: false; status: 400 | 403; message: string }> {
    if (invitationTokenHash && enrolmentTokenHash) {
      await this.fail(meta, 'flow_invalid');
      return { ok: false, status: 400, message: 'Sign-in could not be completed' };
    }
    if (enrolmentTokenHash) {
      return this.enrolments.accept({ tokenHash: enrolmentTokenHash, claims, meta });
    }
    if (invitationTokenHash) {
      return this.invitations.accept({ tokenHash: invitationTokenHash, claims, meta });
    }
    const identity = await this.prisma.client.userIdentity.findUnique({
      where: {
        provider_issuer_subject: { provider: 'entra', issuer: claims.issuer, subject: claims.subject },
      },
      include: { user: true },
    });
    if (!identity) {
      await this.deny(meta, 'not_provisioned', null, null);
      return { ok: false, status: 403, message: 'account not provisioned' };
    }
    if (identity.user.status !== 'active') {
      await this.deny(meta, 'user_disabled', null, identity.userId);
      return { ok: false, status: 403, message: 'account not provisioned' };
    }
    const touched = await this.prisma.client.userIdentity.updateMany({
      where: { id: identity.id, userId: identity.userId },
      data: {
        tenantId: claims.tenantId ?? identity.tenantId,
        entraOid: claims.entraOid ?? identity.entraOid,
        emailAtLink: emailAtLink(claims) ?? identity.emailAtLink,
        lastLoginAt: new Date(),
      },
    });
    if (touched.count !== 1) {
      // The owner CLI removed this link (relink) after it was read.
      await this.deny(meta, 'identity_revoked', null, identity.userId);
      return { ok: false, status: 403, message: 'account not provisioned' };
    }
    return { ok: true, userId: identity.userId };
  }

  private async exchange(
    url: URL,
    input: { state: string; nonce: string; verifier: string },
  ): Promise<ParsedOidcClaims> {
    const oidc = await import('openid-client');
    const configuration = await this.configuration();
    const tokens = await oidc.authorizationCodeGrant(configuration, url, {
      pkceCodeVerifier: input.verifier,
      expectedState: input.state,
      expectedNonce: input.nonce,
      idTokenExpected: true,
    });
    const raw = tokens.claims();
    const parsed = raw
      ? parseOidcClaims(raw, { clientId: this.config.oidcClientId, nonce: input.nonce, nowMs: Date.now() })
      : undefined;
    if (!parsed) {
      throw new Error('id_token claims were rejected');
    }
    return parsed;
  }

  private callbackUrl(req: Request): URL {
    const url = new URL(this.config.oidcRedirectUri);
    const original = req.originalUrl;
    const queryAt = original.indexOf('?');
    url.search = queryAt === -1 ? '' : original.slice(queryAt);
    return url;
  }

  private async configuration(): Promise<OidcConfiguration> {
    if (!this.discovery) {
      const pending = this.discover();
      this.discovery = pending;
      try {
        await pending;
      } catch (error) {
        this.discovery = undefined;
        throw error;
      }
    }
    return this.discovery;
  }

  private async discover(): Promise<OidcConfiguration> {
    const oidc = await import('openid-client');
    const insecure = this.config.appEnv === 'development' || this.config.appEnv === 'test';
    return oidc.discovery(
      new URL(this.config.oidcIssuer),
      this.config.oidcClientId,
      this.config.oidcClientSecret,
      undefined,
      // The helper is marked deprecated so HTTP discovery stands out. Production
      // omits it. Development and tests use it for the local mock issuer.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      insecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
    );
  }

  private async fail(meta: RequestMeta, reason: string): Promise<void> {
    await writeAudit(this.prisma, this.audit, {
      actorType: 'system',
      action: 'auth.login',
      objectType: 'auth_flow',
      outcome: 'failure',
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: { method: 'oidc', reason },
    });
  }

  private async deny(
    meta: RequestMeta,
    reason: string,
    companyId: string | null,
    userId: string | null,
  ): Promise<void> {
    await this.audit.recordDenial({
      companyId,
      actorType: userId ? 'user' : 'system',
      actorId: userId,
      action: 'auth.login',
      objectType: 'user_identity',
      objectId: userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: { method: 'oidc', reason },
    });
  }
}

function protocolFailure(): OidcCallbackResult {
  return { ok: false, status: 400, message: 'Sign-in could not be completed' };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}
