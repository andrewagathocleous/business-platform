import { Inject, Injectable } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { printNodeWhoami, type SafeFetch } from '@bp/integrations';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../authz/request-context';
import { CommerceError, settleCommerceError } from '../commerce/errors';
import { requireActor } from '../commerce/http';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';
import { SAFE_FETCH } from '../outbound/outbound.module';
import { CredentialVault } from '../vault/credential-vault';
import type { SettingsHooks } from './prestashop-connection.service';
import { providerErrorClass } from './provider-error';

const WHOAMI_TIMEOUT_MS = 15_000;

export type PrintNodeAccountView = {
  keySet: boolean;
  keySetAt: string | null;
};

/**
 * The company's PrintNode API key.
 * A new key is encrypted first. The following transaction revokes only older live keys.
 * If that transaction fails, the new key is revoked so it is not left live and unreferenced.
 */
@Injectable()
export class PrintNodeAccountService {
  hooks: SettingsHooks | null = null;
  private readonly tenants: TenantDb;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditLog: AuditService,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(SAFE_FETCH) private readonly fetch: SafeFetch,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.tenants = new TenantDb(prisma.client);
  }

  async get(ctx: RequestContext): Promise<PrintNodeAccountView> {
    const actor = requireActor(ctx);
    return this.tenants.run(this.context(ctx, actor), async (tx) => this.view(tx, ctx.companyId));
  }

  async save(ctx: RequestContext, key: string, meta: RequestMeta): Promise<PrintNodeAccountView> {
    const actor = requireActor(ctx);
    const sealed = await this.vault.encrypt({
      companyId: ctx.companyId,
      provider: 'printnode',
      label: 'api_key',
      plaintext: key,
      createdById: actor,
    });
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id
          FROM integration_credential
          WHERE company_id = ${ctx.companyId}::uuid
            AND provider = 'printnode'
            AND label = 'api_key'
            AND revoked_at IS NULL
          FOR UPDATE
        `;
        const mine = locked.some((row) => row.id === sealed.id);
        if (mine) {
          await tx.$executeRaw`
            UPDATE integration_credential AS older
            SET revoked_at = clock_timestamp()
            FROM integration_credential AS current
            WHERE current.id = ${sealed.id}::uuid
              AND current.company_id = ${ctx.companyId}::uuid
              AND older.company_id = current.company_id
              AND older.provider = 'printnode'
              AND older.label = 'api_key'
              AND older.revoked_at IS NULL
              AND older.id <> current.id
              AND (
                older.created_at < current.created_at
                OR (older.created_at = current.created_at AND older.id < current.id)
              )
          `;
        }
        const others = locked.filter((row) => row.id !== sealed.id);
        await this.auditLog.record(tx, {
          companyId: ctx.companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: others.length === 0 && mine ? 'integration.credential_set' : 'integration.credential_replaced',
          objectType: 'integration_credential',
          objectId: sealed.id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: { provider: 'printnode' },
        });
        await this.hooks?.beforeCommit?.();
        return this.view(tx, ctx.companyId);
      });
    } catch (error) {
      await this.revokeNew(ctx, actor, sealed.id);
      if (error instanceof CommerceError) {
        return settleCommerceError(this.auditLog, this.prisma, ctx, meta, error);
      }
      throw error;
    }
  }

  async test(
    ctx: RequestContext,
    meta: RequestMeta,
  ): Promise<{ ok: true; email: string } | { ok: false; errorClass: string }> {
    const actor = requireActor(ctx);
    const action = 'integration.connection_tested';
    try {
      const credentialId = await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const row = await tx.integrationCredential.findFirst({
          where: { companyId: ctx.companyId, provider: 'printnode', label: 'api_key', revokedAt: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        });
        if (!row) {
          throw new CommerceError(422, 'key_missing', 'integration_credential', null, 'key_missing', action);
        }
        return row.id;
      });
      let apiKey: string;
      try {
        apiKey = await this.vault.decrypt(ctx.companyId, credentialId);
      } catch {
        throw new CommerceError(422, 'key_missing', 'integration_credential', credentialId, 'key_missing', action);
      }
      let email: string;
      try {
        const who = await printNodeWhoami({
          fetch: this.fetch,
          apiKey,
          timeoutMs: WHOAMI_TIMEOUT_MS,
          ...(this.config.printNodeBaseUrl ? { baseUrl: this.config.printNodeBaseUrl } : {}),
        });
        email = who.email;
      } catch (error) {
        const errorClass = providerErrorClass(error);
        await this.auditTest(ctx, actor, meta, credentialId, errorClass);
        return { ok: false, errorClass };
      }
      await this.auditTest(ctx, actor, meta, credentialId, 'ok');
      return { ok: true, email };
    } catch (error) {
      if (error instanceof CommerceError) {
        return settleCommerceError(this.auditLog, this.prisma, ctx, meta, error);
      }
      throw error;
    }
  }

  private async view(tx: TenantTransaction, companyId: string): Promise<PrintNodeAccountView> {
    const row = await tx.integrationCredential.findFirst({
      where: { companyId, provider: 'printnode', label: 'api_key', revokedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    });
    if (!row) {
      return { keySet: false, keySetAt: null };
    }
    return { keySet: true, keySetAt: row.createdAt.toISOString() };
  }

  private async auditTest(
    ctx: RequestContext,
    actor: string,
    meta: RequestMeta,
    credentialId: string,
    result: string,
  ): Promise<void> {
    await this.tenants.run(this.context(ctx, actor), async (tx) => {
      await this.auditLog.record(tx, {
        companyId: ctx.companyId,
        actorType: 'user',
        actorId: actor,
        actorLabel: ctx.actorLabel,
        action: 'integration.connection_tested',
        objectType: 'integration_credential',
        objectId: credentialId,
        outcome: 'success',
        ip: meta.ip,
        userAgent: meta.userAgent,
        details: { result },
      });
    });
  }

  private async revokeNew(ctx: RequestContext, actor: string, credentialId: string): Promise<void> {
    await this.tenants.run(this.context(ctx, actor), async (tx) => {
      await tx.integrationCredential.updateMany({
        where: { id: credentialId, companyId: ctx.companyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  private context(ctx: RequestContext, actor: string) {
    return { companyId: ctx.companyId, actor, correlationId: ctx.correlationId };
  }
}
