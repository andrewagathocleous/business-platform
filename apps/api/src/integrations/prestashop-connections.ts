import { Inject, Injectable } from '@nestjs/common';
import { DELIVERY_METHODS, type DeliveryMethod } from '@bp/domain';
import { TenantDb } from '@bp/db';
import { getCorrelationId } from '../correlation/correlation';
import { PrismaService } from '../database/prisma.service';
import { CredentialVault } from '../vault/credential-vault';
import { parsePrestashopSettings, type PrestashopSettings } from './prestashop-settings';

const DELIVERY = new Set<string>(DELIVERY_METHODS);

/**
 * Loads one PrestaShop connection's settings and decrypts its webservice key.
 * The read and the decrypt each use their own transaction.
 * A missing, revoked, mistyped or undecryptable key is `credential_unavailable`.
 * Nothing in this path calls the shop.
 */
@Injectable()
export class PrestashopConnections {
  private readonly tenants: TenantDb;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
  ) {
    this.tenants = new TenantDb(prisma.client);
  }

  /**
   * `onRead` receives the credential id and settings as read, before they are parsed or
   * the key is decrypted, so a caller can guard what it writes even when opening fails.
   */
  async open(
    companyId: string,
    connectionId: string,
    onRead?: (read: PrestashopConnectionRead) => void,
  ): Promise<OpenedPrestashopConnection> {
    const { read, row } = await this.tenants.run(this.context(companyId), async (tx) => {
      // Read as the database stores it, so a guard built from it compares exactly.
      // FOR SHARE holds the row until this short transaction ends, so the fuller read below
      // sees the same credential and settings: a settings save waits for it.
      const reads = await tx.$queryRaw<{ credential_id: string | null; settings: string }[]>`
        SELECT credential_id::text AS credential_id, settings::text AS settings
        FROM store_connection
        WHERE company_id = ${companyId}::uuid AND id = ${connectionId}::uuid
        FOR SHARE
      `;
      const found = await tx.storeConnection.findFirst({
        where: { id: connectionId, companyId },
        select: {
          id: true,
          storeId: true,
          settings: true,
          syncCheckpoint: true,
          credentialId: true,
          store: { select: { platform: true, deliveryMethodMap: true } },
          credential: {
            select: { id: true, provider: true, label: true, revokedAt: true },
          },
        },
      });
      const first = reads[0];
      return {
        read: first ? { credentialId: first.credential_id, settingsText: first.settings } : null,
        row: found,
      };
    });
    if (!row || !read) {
      throw new Error('connection_not_found');
    }
    onRead?.(read);
    if (row.store.platform !== 'prestashop') {
      throw new Error('connection_not_importable');
    }
    const settings = parsePrestashopSettings(row.settings);
    const credential = row.credential;
    if (
      credential === null ||
      credential.revokedAt !== null ||
      credential.provider !== 'prestashop' ||
      credential.label !== 'webservice_key'
    ) {
      throw new PrestashopCredentialUnavailable();
    }
    let apiKey: string;
    try {
      apiKey = await this.vault.decrypt(companyId, credential.id);
    } catch {
      throw new PrestashopCredentialUnavailable();
    }
    return {
      connectionId: row.id,
      storeId: row.storeId,
      settings,
      apiKey,
      carrierMap: carrierMapOf(row.store.deliveryMethodMap),
      checkpoint: row.syncCheckpoint,
    };
  }

  private context(companyId: string) {
    const correlationId = getCorrelationId();
    if (!correlationId) {
      throw new Error('prestashop credential lookup requires a correlation id');
    }
    return { companyId, actor: 'system', correlationId };
  }
}

export type PrestashopConnectionRead = {
  credentialId: string | null;
  /** `settings::text` from the database, lossless for comparison as `jsonb`. */
  settingsText: string;
};

export type OpenedPrestashopConnection = {
  connectionId: string;
  storeId: string;
  settings: PrestashopSettings;
  apiKey: string;
  carrierMap: Record<string, DeliveryMethod>;
  checkpoint: unknown;
};

export class PrestashopCredentialUnavailable extends Error {
  override readonly name = 'PrestashopCredentialUnavailable';
  readonly code = 'credential_unavailable';

  constructor() {
    super('credential_unavailable');
  }
}

/** Carrier `id_reference` to a platform delivery method. Other values are dropped. */
export function carrierMapOf(value: unknown): Record<string, DeliveryMethod> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, DeliveryMethod> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && DELIVERY.has(item)) {
      result[key] = item as DeliveryMethod;
    }
  }
  return result;
}
