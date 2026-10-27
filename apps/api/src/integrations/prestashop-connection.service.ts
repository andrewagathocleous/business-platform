import { BadRequestException, Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { Prisma, TenantDb, type TenantTransaction } from '@bp/db';
import { createPrestashopClient, type SafeFetch } from '@bp/integrations';
import { AuditService } from '../audit/audit.service';
import { isUuid } from '../authz/company-path';
import type { RequestContext } from '../authz/request-context';
import { CommerceError, settleCommerceError } from '../commerce/errors';
import { requireActor } from '../commerce/http';
import { uuidv7 } from '../correlation/correlation';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';
import { enqueueReceivedInbox } from '../automation/inbox-insert';
import { SAFE_FETCH } from '../outbound/outbound.module';
import { CredentialVault } from '../vault/credential-vault';
import { groupCarriers, type CarrierReferenceRow } from './carrier-groups';
import { carrierMapOf } from './prestashop-connections';
import type { ConnectionMaps, ConnectionPut } from './prestashop-connection.schema';
import {
  parsePrestashopSettings,
  PrestashopSettingsInvalid,
  type PrestashopSettings,
} from './prestashop-settings';
import { providerErrorClass } from './provider-error';

const PROBE_TIMEOUT_MS = 15_000;

export type SettingsHooks = {
  /** Test seam. Runs inside the write transaction, before it commits. Production leaves this null. */
  beforeCommit?: () => Promise<void>;
};

export type PrestashopConnectionView = {
  id: string;
  status: string;
  settings: {
    baseUrl: string;
    timezone: string;
    firstImportFrom: string;
    pollIntervalSeconds: number;
  };
  stateMap: PrestashopSettings['stateMap'];
  carrierMap: ReturnType<typeof carrierMapOf>;
  keySet: boolean;
  keySetAt: string | null;
  lastTestAt: string | null;
  lastTestResult: string | null;
  lastSyncAt: string | null;
  lastErrorClass: string | null;
  lastErrorAt: string | null;
  firstImportLocked: boolean;
};

type CredentialPick = {
  id: string;
  provider: string;
  label: string;
  revokedAt: Date | null;
  createdAt: Date;
};

type ConnectionRow = {
  id: string;
  status: string;
  credentialId: string | null;
  settings: unknown;
  syncCheckpoint: unknown;
  lastTestAt: Date | null;
  lastTestResult: string | null;
  lastSyncAt: Date | null;
  lastErrorClass: string | null;
  lastErrorAt: Date | null;
  credential: CredentialPick | null;
  store: { deliveryMethodMap: unknown };
};

const connectionSelect = {
  id: true,
  status: true,
  credentialId: true,
  settings: true,
  syncCheckpoint: true,
  lastTestAt: true,
  lastTestResult: true,
  lastSyncAt: true,
  lastErrorClass: true,
  lastErrorAt: true,
  credential: {
    select: { id: true, provider: true, label: true, revokedAt: true, createdAt: true },
  },
  store: { select: { deliveryMethodMap: true } },
} satisfies Prisma.StoreConnectionSelect;

/**
 * The store's single live PrestaShop connection.
 * A new key is encrypted before the connection transaction and revoked if that transaction fails.
 * Responses and audits never include the key, its hint or its length.
 */
@Injectable()
export class PrestashopConnectionService {
  hooks: SettingsHooks | null = null;
  private readonly tenants: TenantDb;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditLog: AuditService,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(SAFE_FETCH) private readonly fetch: SafeFetch,
  ) {
    this.tenants = new TenantDb(prisma.client);
  }

  async get(
    ctx: RequestContext,
    storeId: string,
    meta: RequestMeta,
  ): Promise<PrestashopConnectionView | null> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const store = await this.readStore(tx, ctx.companyId, storeId, 'integration.connection_read');
        this.assertPlatform(store, 'integration.connection_read');
        const row = await this.findLive(tx, ctx.companyId, store.id);
        return row ? this.toView(row) : null;
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async save(
    ctx: RequestContext,
    storeId: string,
    input: ConnectionPut,
    meta: RequestMeta,
  ): Promise<PrestashopConnectionView> {
    const actor = requireActor(ctx);
    const action = 'integration.connection_updated';
    let sealedId: string | null = null;
    try {
      await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const store = await this.readStore(tx, ctx.companyId, storeId, action);
        this.assertPlatform(store, action);
        this.assertWritable(store, action);
        const existing = await this.findLive(tx, ctx.companyId, store.id);
        const next = this.settingsFor(input, existing);
        this.assertImportUnlocked(existing, next, action);
        if (!existing && input.key === undefined) {
          throw new CommerceError(422, 'key_missing', 'store', store.id, 'key_missing', 'integration.connection_created');
        }
      });
      if (input.key !== undefined) {
        sealedId = (
          await this.vault.encrypt({
            companyId: ctx.companyId,
            provider: 'prestashop',
            label: 'webservice_key',
            plaintext: input.key,
            createdById: actor,
          })
        ).id;
      }
      const view = await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const store = await this.lockStore(tx, ctx.companyId, storeId, action);
        this.assertPlatform(store, action);
        this.assertWritable(store, action);
        const existing = await this.findLive(tx, ctx.companyId, store.id, true);
        const next = this.settingsFor(input, existing);
        this.assertImportUnlocked(existing, next, action);
        if (!existing) {
          if (!sealedId) {
            throw new CommerceError(
              422,
              'key_missing',
              'store',
              store.id,
              'key_missing',
              'integration.connection_created',
            );
          }
          const created = await tx.storeConnection.create({
            data: {
              companyId: ctx.companyId,
              storeId: store.id,
              mode: 'live',
              status: 'paused',
              readOnly: true,
              writeBackEnabled: false,
              credentialId: sealedId,
              settings: json(next),
            },
            select: connectionSelect,
          });
          await this.audit(tx, ctx, meta, 'integration.credential_set', 'store_connection', created.id, {
            provider: 'prestashop',
          });
          await this.audit(tx, ctx, meta, 'integration.connection_created', 'store_connection', created.id, {
            fields: ['baseUrl', 'timezone', 'firstImportFrom', 'pollIntervalSeconds', 'key'],
          });
          await this.hooks?.beforeCommit?.();
          return this.toView(created);
        }
        const fields = changedFields(this.parsed(existing), next, sealedId !== null);
        if (fields.length === 0) {
          return this.toView(existing);
        }
        const pause = fields.includes('key') || fields.includes('baseUrl');
        const saved = await tx.storeConnection.update({
          where: { id: existing.id },
          data: {
            settings: json(next),
            ...(sealedId ? { credentialId: sealedId } : {}),
            ...(pause ? { status: 'paused', lastTestAt: null, lastTestResult: null } : {}),
          },
          select: connectionSelect,
        });
        if (sealedId) {
          if (existing.credentialId) {
            await tx.integrationCredential.updateMany({
              where: { id: existing.credentialId, companyId: ctx.companyId, revokedAt: null },
              data: { revokedAt: new Date() },
            });
          }
          await this.audit(
            tx,
            ctx,
            meta,
            existing.credentialId ? 'integration.credential_replaced' : 'integration.credential_set',
            'store_connection',
            saved.id,
            { provider: 'prestashop' },
          );
        }
        await this.audit(tx, ctx, meta, 'integration.connection_updated', 'store_connection', saved.id, { fields });
        if (pause) {
          await this.audit(tx, ctx, meta, 'integration.connection_paused', 'store_connection', saved.id, {
            reason: 'settings_changed',
          });
        }
        await this.hooks?.beforeCommit?.();
        return this.toView(saved);
      });
      // Cleared only after the commit: a failed commit still revokes the new key below.
      sealedId = null;
      return view;
    } catch (error) {
      if (sealedId) {
        await this.revokeNew(ctx, actor, sealedId);
      }
      return this.fail(ctx, meta, error);
    }
  }

  async test(
    ctx: RequestContext,
    storeId: string,
    meta: RequestMeta,
  ): Promise<{ ok: true } | { ok: false; errorClass: string; resource?: string }> {
    const actor = requireActor(ctx);
    const action = 'integration.connection_tested';
    try {
      const loaded = await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const store = await this.readStore(tx, ctx.companyId, storeId, action);
        this.assertPlatform(store, action);
        this.assertWritable(store, action);
        const row = await this.requireLive(tx, ctx.companyId, store.id, action);
        return {
          connectionId: row.id,
          credentialId: this.requireKey(row, action),
          baseUrl: this.parsed(row).baseUrl,
        };
      });
      const apiKey = await this.decrypt(ctx.companyId, loaded.credentialId, loaded.connectionId, action);
      const client = createPrestashopClient({
        fetch: this.fetch,
        baseUrl: loaded.baseUrl,
        apiKey,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const probed = await client.probe();
      const errorClass = probed.ok ? 'ok' : providerErrorClass(probed.error);
      const resource = probed.ok ? undefined : probed.resource;
      await this.tenants.run(this.context(ctx, actor), async (tx) => {
        await tx.$queryRaw`
          UPDATE store_connection
          SET last_test_at = clock_timestamp(),
              last_test_result = ${errorClass}
          WHERE id = ${loaded.connectionId}::uuid
            AND company_id = ${ctx.companyId}::uuid
            AND credential_id = ${loaded.credentialId}::uuid
            AND settings->>'baseUrl' = ${loaded.baseUrl}
        `;
        await this.audit(tx, ctx, meta, action, 'store_connection', loaded.connectionId, {
          result: errorClass,
          ...(resource ? { resource } : {}),
        });
      });
      if (probed.ok) {
        return { ok: true };
      }
      return { ok: false, errorClass, ...(resource ? { resource } : {}) };
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async orderStates(
    ctx: RequestContext,
    storeId: string,
    meta: RequestMeta,
  ): Promise<{ ok: true; states: { id: string; name: string }[] } | { ok: false; errorClass: string }> {
    const opened = await this.openSaved(ctx, storeId, meta);
    if (!opened.ok) {
      return opened;
    }
    try {
      const client = createPrestashopClient({
        fetch: this.fetch,
        baseUrl: opened.baseUrl,
        apiKey: opened.apiKey,
      });
      const states = await client.getOrderStates();
      return { ok: true, states: states.map((state) => ({ id: state.id, name: state.name })) };
    } catch (error) {
      return { ok: false, errorClass: providerErrorClass(error) };
    }
  }

  async carriers(
    ctx: RequestContext,
    storeId: string,
    meta: RequestMeta,
  ): Promise<{ ok: true; carriers: CarrierReferenceRow[] } | { ok: false; errorClass: string }> {
    const opened = await this.openSaved(ctx, storeId, meta);
    if (!opened.ok) {
      return opened;
    }
    try {
      const client = createPrestashopClient({
        fetch: this.fetch,
        baseUrl: opened.baseUrl,
        apiKey: opened.apiKey,
      });
      return { ok: true, carriers: groupCarriers(await client.listCarriers()) };
    } catch (error) {
      return { ok: false, errorClass: providerErrorClass(error) };
    }
  }

  async saveMaps(
    ctx: RequestContext,
    storeId: string,
    input: ConnectionMaps,
    meta: RequestMeta,
  ): Promise<PrestashopConnectionView> {
    const actor = requireActor(ctx);
    const action = 'integration.maps_updated';
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const store = await this.lockStore(tx, ctx.companyId, storeId, action);
        this.assertPlatform(store, action);
        this.assertWritable(store, action);
        const existing = await this.requireLive(tx, ctx.companyId, store.id, action, true);
        const next: PrestashopSettings = { ...this.parsed(existing), stateMap: input.stateMap };
        await tx.storeConnection.update({
          where: { id: existing.id },
          data: { settings: json(next) },
        });
        await tx.store.update({
          where: { id: store.id },
          data: { deliveryMethodMap: input.carrierMap },
        });
        await this.audit(tx, ctx, meta, action, 'store_connection', existing.id, {
          states: Object.keys(input.stateMap).length,
          carriers: Object.keys(input.carrierMap).length,
        });
        await this.hooks?.beforeCommit?.();
        const saved = await this.findLive(tx, ctx.companyId, store.id);
        if (!saved) {
          throw new CommerceError(404, 'connection_not_found', 'store', store.id, 'Not found');
        }
        return this.toView(saved);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async activate(
    ctx: RequestContext,
    storeId: string,
    meta: RequestMeta,
  ): Promise<PrestashopConnectionView> {
    const actor = requireActor(ctx);
    const action = 'integration.connection_activated';
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const store = await this.lockStore(tx, ctx.companyId, storeId, action);
        this.assertPlatform(store, action);
        this.assertWritable(store, action);
        const existing = await this.requireLive(tx, ctx.companyId, store.id, action, true);
        if (existing.status === 'active') {
          return this.toView(existing);
        }
        if (existing.lastTestResult !== 'ok') {
          throw new CommerceError(422, 'test_required', 'store_connection', existing.id, 'test_required', action);
        }
        await tx.storeConnection.update({
          where: { id: existing.id },
          data: { status: 'active' },
        });
        const auditId = uuidv7();
        const requeued =
          existing.status === 'paused' || existing.status === 'auth_failed'
            ? await enqueueReceivedInbox(tx, {
                companyId: ctx.companyId,
                connectionId: existing.id,
                correlationId: ctx.correlationId,
                idempotencySuffix: auditId,
              })
            : 0;
        await this.audit(tx, ctx, meta, action, 'store_connection', existing.id, { requeued }, auditId);
        await this.hooks?.beforeCommit?.();
        const saved = await this.findLive(tx, ctx.companyId, store.id);
        if (!saved) {
          throw new CommerceError(404, 'connection_not_found', 'store', store.id, 'Not found');
        }
        return this.toView(saved);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async pause(
    ctx: RequestContext,
    storeId: string,
    meta: RequestMeta,
  ): Promise<PrestashopConnectionView> {
    const actor = requireActor(ctx);
    const action = 'integration.connection_paused';
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const store = await this.lockStore(tx, ctx.companyId, storeId, action);
        this.assertPlatform(store, action);
        this.assertWritable(store, action);
        const existing = await this.requireLive(tx, ctx.companyId, store.id, action, true);
        if (existing.status === 'paused') {
          return this.toView(existing);
        }
        const saved = await tx.storeConnection.update({
          where: { id: existing.id },
          data: { status: 'paused' },
          select: connectionSelect,
        });
        await this.audit(tx, ctx, meta, action, 'store_connection', saved.id, { reason: 'manual' });
        await this.hooks?.beforeCommit?.();
        return this.toView(saved);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  private async openSaved(
    ctx: RequestContext,
    storeId: string,
    meta: RequestMeta,
  ): Promise<{ ok: true; apiKey: string; baseUrl: string } | { ok: false; errorClass: string }> {
    const actor = requireActor(ctx);
    const action = 'integration.connection_read';
    try {
      const loaded = await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const store = await this.readStore(tx, ctx.companyId, storeId, action);
        this.assertPlatform(store, action);
        const row = await this.requireLive(tx, ctx.companyId, store.id, action);
        return {
          connectionId: row.id,
          credentialId: this.requireKey(row, action),
          baseUrl: this.parsed(row).baseUrl,
        };
      });
      const apiKey = await this.decrypt(ctx.companyId, loaded.credentialId, loaded.connectionId, action);
      return { ok: true, apiKey, baseUrl: loaded.baseUrl };
    } catch (error) {
      if (error instanceof CommerceError) {
        return this.fail(ctx, meta, error);
      }
      throw error;
    }
  }

  private settingsFor(input: ConnectionPut, existing: ConnectionRow | null): PrestashopSettings {
    const previous = existing ? this.parsed(existing) : null;
    try {
      return parsePrestashopSettings({
        baseUrl: input.baseUrl,
        timezone: input.timezone,
        firstImportFrom: input.firstImportFrom,
        pollIntervalSeconds: input.pollIntervalSeconds ?? previous?.pollIntervalSeconds ?? 180,
        stateMap: previous?.stateMap ?? {},
      });
    } catch (error) {
      if (error instanceof PrestashopSettingsInvalid) {
        throw new BadRequestException('settings_invalid');
      }
      throw error;
    }
  }

  private parsed(row: ConnectionRow): PrestashopSettings {
    try {
      return parsePrestashopSettings(row.settings);
    } catch (error) {
      if (error instanceof PrestashopSettingsInvalid) {
        throw new CommerceError(422, 'settings_invalid', 'store_connection', row.id, 'settings_invalid');
      }
      throw error;
    }
  }

  private assertImportUnlocked(existing: ConnectionRow | null, next: PrestashopSettings, action: string): void {
    if (!existing || existing.syncCheckpoint === null) {
      return;
    }
    if (this.parsed(existing).firstImportFrom !== next.firstImportFrom) {
      throw new CommerceError(422, 'first_import_locked', 'store_connection', existing.id, 'first_import_locked', action);
    }
  }

  private assertPlatform(store: { id: string; platform: string }, action: string): void {
    if (store.platform !== 'prestashop') {
      throw new CommerceError(422, 'wrong_platform', 'store', store.id, 'wrong_platform', action);
    }
  }

  private assertWritable(store: { id: string; status: string }, action: string): void {
    if (store.status === 'archived') {
      throw new CommerceError(422, 'store_archived', 'store', store.id, 'store_archived', action);
    }
  }

  private requireKey(row: ConnectionRow, action: string): string {
    const credential = row.credential;
    if (
      !credential ||
      credential.revokedAt !== null ||
      credential.provider !== 'prestashop' ||
      credential.label !== 'webservice_key'
    ) {
      throw new CommerceError(422, 'key_missing', 'store_connection', row.id, 'key_missing', action);
    }
    return credential.id;
  }

  private async decrypt(
    companyId: string,
    credentialId: string,
    connectionId: string,
    action: string,
  ): Promise<string> {
    try {
      return await this.vault.decrypt(companyId, credentialId);
    } catch {
      throw new CommerceError(422, 'key_missing', 'store_connection', connectionId, 'key_missing', action);
    }
  }

  private async readStore(
    tx: TenantTransaction,
    companyId: string,
    storeId: string,
    action: string,
  ): Promise<{ id: string; platform: string; status: string }> {
    const id = this.objectId(storeId);
    const store = await tx.store.findFirst({
      where: { id, companyId },
      select: { id: true, platform: true, status: true },
    });
    if (!store) {
      throw new CommerceError(404, 'store_not_found', 'store', id, 'Not found', action);
    }
    return store;
  }

  private async lockStore(
    tx: TenantTransaction,
    companyId: string,
    storeId: string,
    action: string,
  ): Promise<{ id: string; platform: string; status: string }> {
    const id = this.objectId(storeId);
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM store
      WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new CommerceError(404, 'store_not_found', 'store', id, 'Not found', action);
    }
    return tx.store.findFirstOrThrow({
      where: { id, companyId },
      select: { id: true, platform: true, status: true },
    });
  }

  /**
   * The store's live connection. With `lock`, the row is locked `FOR UPDATE` first, and the
   * read that follows sees any checkpoint or status a poll committed while this waited.
   */
  private async findLive(
    tx: TenantTransaction,
    companyId: string,
    storeId: string,
    lock = false,
  ): Promise<ConnectionRow | null> {
    if (lock) {
      await tx.$queryRaw`
        SELECT id FROM store_connection
        WHERE company_id = ${companyId}::uuid
          AND store_id = ${storeId}::uuid
          AND mode = 'live'::"connection_mode"
        FOR UPDATE
      `;
    }
    const rows = await tx.storeConnection.findMany({
      where: { companyId, storeId, mode: 'live' },
      select: connectionSelect,
    });
    if (rows.length > 1) {
      throw new InternalServerErrorException('more than one live connection');
    }
    return rows[0] ?? null;
  }

  private async requireLive(
    tx: TenantTransaction,
    companyId: string,
    storeId: string,
    action: string,
    lock = false,
  ): Promise<ConnectionRow> {
    const row = await this.findLive(tx, companyId, storeId, lock);
    if (!row) {
      throw new CommerceError(404, 'connection_not_found', 'store', storeId, 'Not found', action);
    }
    return row;
  }

  private objectId(storeId: string): string {
    if (!isUuid(storeId)) {
      throw new CommerceError(404, 'store_not_found', 'store', null, 'Not found');
    }
    return storeId.toLowerCase();
  }

  private toView(row: ConnectionRow): PrestashopConnectionView {
    const settings = this.parsed(row);
    const credential = row.credential;
    const keySet =
      credential !== null &&
      credential.revokedAt === null &&
      credential.provider === 'prestashop' &&
      credential.label === 'webservice_key';
    return {
      id: row.id,
      status: row.status,
      settings: {
        baseUrl: settings.baseUrl,
        timezone: settings.timezone,
        firstImportFrom: settings.firstImportFrom,
        pollIntervalSeconds: settings.pollIntervalSeconds,
      },
      stateMap: settings.stateMap,
      carrierMap: carrierMapOf(row.store.deliveryMethodMap),
      keySet,
      keySetAt: keySet ? credential.createdAt.toISOString() : null,
      lastTestAt: iso(row.lastTestAt),
      lastTestResult: row.lastTestResult,
      lastSyncAt: iso(row.lastSyncAt),
      lastErrorClass: row.lastErrorClass,
      lastErrorAt: iso(row.lastErrorAt),
      firstImportLocked: row.syncCheckpoint !== null,
    };
  }

  private async audit(
    tx: TenantTransaction,
    ctx: RequestContext,
    meta: RequestMeta,
    action: string,
    objectType: string,
    objectId: string,
    details: Record<string, unknown>,
    id?: string,
  ): Promise<string> {
    return this.auditLog.record(tx, {
      ...(id ? { id } : {}),
      companyId: ctx.companyId,
      actorType: 'user',
      actorId: requireActor(ctx),
      actorLabel: ctx.actorLabel,
      action,
      objectType,
      objectId,
      outcome: 'success',
      ip: meta.ip,
      userAgent: meta.userAgent,
      details,
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

  private fail(ctx: RequestContext, meta: RequestMeta, error: unknown): Promise<never> {
    if (error instanceof CommerceError) {
      return settleCommerceError(this.auditLog, this.prisma, ctx, meta, error);
    }
    throw error;
  }
}

function changedFields(previous: PrestashopSettings, next: PrestashopSettings, keyChanged: boolean): string[] {
  const fields: string[] = [];
  if (previous.baseUrl !== next.baseUrl) {
    fields.push('baseUrl');
  }
  if (previous.timezone !== next.timezone) {
    fields.push('timezone');
  }
  if (previous.firstImportFrom !== next.firstImportFrom) {
    fields.push('firstImportFrom');
  }
  if (previous.pollIntervalSeconds !== next.pollIntervalSeconds) {
    fields.push('pollIntervalSeconds');
  }
  if (keyChanged) {
    fields.push('key');
  }
  return fields;
}

function json(value: PrestashopSettings): Prisma.InputJsonValue {
  return value;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}
