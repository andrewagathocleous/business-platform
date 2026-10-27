import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { AuditService } from '../audit/audit.service';
import { isUuid } from '../authz/company-path';
import { getCorrelationId, uuidv7 } from '../correlation/correlation';
import { PrismaService } from '../database/prisma.service';
import {
  CredentialCryptoError,
  credentialAad,
  credentialHint,
  openCredential,
  sealCredential,
  type SealedCredential,
} from './credential-crypto';

export type MasterKeyRing = {
  keys: Readonly<Record<string, Buffer>>;
  activeKeyId: string;
};

export type CredentialLog = {
  info(payload: Record<string, unknown>, message: string): void;
};

export const MASTER_KEY_RING = Symbol('MASTER_KEY_RING');
export const CREDENTIAL_LOG = Symbol('CREDENTIAL_LOG');

export type StoredCredential = {
  id: string;
  hint: string | null;
  keyId: string;
};

type CredentialRow = {
  id: string;
  companyId: string;
  provider: string;
  keyId: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
  revokedAt: Date | null;
};

/**
 * AES-256-GCM credential vault. Plaintext is never written to logs, audit
 * details or the return value of anything except decrypt.
 * Nothing in Phase 1 calls this from a route.
 */
@Injectable()
export class CredentialVault {
  private readonly tenants: TenantDb;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MASTER_KEY_RING) private readonly ring: MasterKeyRing,
    @Inject(CREDENTIAL_LOG) private readonly log: CredentialLog,
  ) {
    this.tenants = new TenantDb(prisma.client);
  }

  async encrypt(input: {
    companyId: string;
    provider: string;
    label: string;
    plaintext: string;
    createdById: string;
  }): Promise<StoredCredential> {
    const companyId = requireUuid(input.companyId, 'companyId');
    const createdById = requireUuid(input.createdById, 'createdById');
    const provider = requireLabel(input.provider, 'provider', 80);
    const label = requireLabel(input.label, 'label', 120);
    const plaintext = requirePlaintext(input.plaintext);
    const id = uuidv7();
    const keyId = this.ring.activeKeyId;
    const sealed = sealCredential(
      this.key(keyId),
      credentialAad(companyId, provider, id),
      plaintext,
    );
    const hint = credentialHint(plaintext);
    await this.tenants.run(this.context(companyId, createdById), async (tx) => {
      await tx.integrationCredential.create({
        data: {
          id,
          companyId,
          provider,
          label,
          keyId,
          nonce: bytes(sealed.nonce),
          ciphertext: bytes(sealed.ciphertext),
          authTag: bytes(sealed.authTag),
          hint,
          createdById,
        },
      });
      await this.audit.record(tx, {
        companyId,
        actorType: 'user',
        actorId: createdById,
        action: 'credential.stored',
        objectType: 'integration_credential',
        objectId: id,
        outcome: 'success',
        details: { provider, keyId },
      });
    });
    this.log.info(
      { action: 'encrypt', companyId, credentialId: id, provider, keyId },
      'credential sealed',
    );
    return { id, hint, keyId };
  }

  async decrypt(companyId: string, credentialId: string): Promise<string> {
    const company = requireUuid(companyId, 'companyId');
    const id = requireUuid(credentialId, 'credentialId');
    let row: CredentialRow;
    try {
      row = await this.tenants.run(this.context(company, 'system'), (tx) => this.load(tx, company, id));
    } catch (error) {
      if (error instanceof NotFoundException) {
        await this.audit.recordDenial({
          companyId: company,
          actorType: 'system',
          actorId: null,
          action: 'authorization.denied',
          objectType: 'integration_credential',
          objectId: id,
          details: { reason: 'credential_not_found' },
        });
      }
      throw error;
    }
    const plaintext = openCredential(
      this.key(row.keyId),
      credentialAad(row.companyId, row.provider, row.id),
      sealedOf(row),
    );
    this.log.info(
      {
        action: 'decrypt',
        companyId: company,
        credentialId: id,
        provider: row.provider,
        keyId: row.keyId,
      },
      'credential opened',
    );
    return plaintext;
  }

  async rotate(companyId: string, credentialId: string): Promise<{ id: string; keyId: string }> {
    const company = requireUuid(companyId, 'companyId');
    const id = requireUuid(credentialId, 'credentialId');
    const nextKeyId = this.ring.activeKeyId;
    const nextKey = this.key(nextKeyId);
    const saved = await this.tenants.run(this.context(company, 'system'), async (tx) => {
      const row = await this.load(tx, company, id);
      const plaintext = openCredential(
        this.key(row.keyId),
        credentialAad(row.companyId, row.provider, row.id),
        sealedOf(row),
      );
      const sealed = sealCredential(
        nextKey,
        credentialAad(row.companyId, row.provider, row.id),
        plaintext,
      );
      await tx.integrationCredential.update({
        where: { id: row.id },
        data: {
          keyId: nextKeyId,
          nonce: bytes(sealed.nonce),
          ciphertext: bytes(sealed.ciphertext),
          authTag: bytes(sealed.authTag),
          rotatedAt: new Date(),
        },
      });
      await this.audit.record(tx, {
        companyId: company,
        actorType: 'system',
        actorId: null,
        action: 'credential.rotated',
        objectType: 'integration_credential',
        objectId: row.id,
        outcome: 'success',
        details: { provider: row.provider, fromKeyId: row.keyId, keyId: nextKeyId },
      });
      return { id: row.id, keyId: nextKeyId };
    });
    this.log.info(
      { action: 'rotate', companyId: company, credentialId: id, keyId: nextKeyId },
      'credential rotated',
    );
    return saved;
  }

  private key(keyId: string): Buffer {
    const key = this.ring.keys[keyId];
    if (!key) {
      throw new CredentialCryptoError('master key is not loaded');
    }
    return key;
  }

  private context(companyId: string, actor: string) {
    const correlationId = getCorrelationId();
    if (!correlationId) {
      throw new Error('credential vault requires a correlation id');
    }
    return { companyId, actor, correlationId };
  }

  private async load(tx: TenantTransaction, companyId: string, id: string): Promise<CredentialRow> {
    const row = await tx.integrationCredential.findFirst({
      where: { id, companyId, revokedAt: null },
    });
    if (!row) {
      throw new NotFoundException('Not found');
    }
    return row;
  }
}

function bytes(value: Buffer): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value);
}

function sealedOf(row: CredentialRow): SealedCredential {
  return {
    nonce: Buffer.from(row.nonce),
    ciphertext: Buffer.from(row.ciphertext),
    authTag: Buffer.from(row.authTag),
  };
}

function requireUuid(value: string, field: string): string {
  if (!isUuid(value)) {
    throw new CredentialCryptoError(`${field} is invalid`);
  }
  return value.toLowerCase();
}

function requireLabel(value: string, field: string, max: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    /[|\r\n]/.test(value)
  ) {
    throw new CredentialCryptoError(`${field} is invalid`);
  }
  return value;
}

function requirePlaintext(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8000) {
    throw new CredentialCryptoError('plaintext is invalid');
  }
  return value;
}
