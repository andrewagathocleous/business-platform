import { NotFoundException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertDatabaseNameIsTest,
  assertEnvConnectionsTargetTestDatabase,
  assertTestDatabaseUrls,
} from '../../../../tools/test-db-guard.mjs';
import { AppModule } from '../app.module';
import { AuditService } from '../audit/audit.service';
import { correlationStorage } from '../correlation/correlation';
import { PrismaService } from '../database/prisma.service';
import { configureHttp } from '../http/configure-http';
import { caseSensitiveAdapter } from '../http/express-adapter';
import { LOG_STREAM } from '../logging/logging.module';
import { CredentialCryptoError } from './credential-crypto';
import { CredentialVault, type CredentialLog, type MasterKeyRing } from './credential-vault';

const COMPANY_A = 'Demo Company A Ltd (fictional)';
const COMPANY_B = 'Demo Company B Ltd (fictional)';
const runId = randomUUID().slice(0, 8);

describe('credential vault', () => {
  let app: INestApplication;
  let companyA = '';
  let companyB = '';
  let userId = '';

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
    process.env.APP_MASTER_KEYS = JSON.stringify({ k1: Buffer.alloc(32, 7).toString('base64') });
    process.env.APP_MASTER_KEY_ACTIVE = 'k1';
    app = await bootApp();
    const prisma = app.get(PrismaService);
    const databases = await prisma.client.$queryRaw<
      { current_database: string; current_user: string }[]
    >`
      SELECT current_database() AS current_database, current_user AS current_user
    `;
    assertDatabaseNameIsTest(databases[0]?.current_database, 'DATABASE_URL');
    expect(databases[0]?.current_user).toBe('bp_app');
    companyA = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_A } }))
      .id;
    companyB = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_B } }))
      .id;
    userId = (
      await prisma.client.userAccount.findFirstOrThrow({ where: { email: 'admin.a@example.test' } })
    ).id;
    expect(app.get(CredentialVault)).toBeInstanceOf(CredentialVault);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('round-trips a secret, hides it from logs, and refuses another company', async () => {
    const plaintext = `vault-secret-μυστικό-${runId}`;
    const correlationId = cid('vault-store');
    const spy = vi.spyOn(Logger.prototype, 'log');
    const vault = app.get(CredentialVault);
    const stored = await correlationStorage.run({ correlationId }, () =>
      vault.encrypt({
        companyId: companyA,
        provider: 'shopify',
        label: `demo ${runId}`,
        plaintext,
        createdById: userId,
      }),
    );
    expect(stored.hint).toBe(runId.slice(-4));
    expect(stored.keyId).toBe('k1');
    const opened = await correlationStorage.run({ correlationId: cid('vault-open') }, () =>
      vault.decrypt(companyA, stored.id),
    );
    expect(opened).toBe(plaintext);
    const logged = spy.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(logged).not.toContain(plaintext);
    expect(logged).not.toContain('μυστικό');
    spy.mockRestore();

    const events = await auditEvents(correlationId, companyA);
    expect(events[0]).toEqual(
      expect.objectContaining({
        action: 'credential.stored',
        objectType: 'integration_credential',
        objectId: stored.id,
        outcome: 'success',
        correlationId,
      }),
    );
    expect(JSON.stringify(events[0]?.details)).not.toContain(plaintext);

    const otherId = cid('vault-other');
    await expect(
      correlationStorage.run({ correlationId: otherId }, () => vault.decrypt(companyB, stored.id)),
    ).rejects.toBeInstanceOf(NotFoundException);
    const denied = await auditEvents(otherId, companyB);
    expect(denied).toEqual([
      expect.objectContaining({
        action: 'authorization.denied',
        outcome: 'denied',
        actorType: 'system',
        objectType: 'integration_credential',
        objectId: stored.id,
        correlationId: otherId,
      }),
    ]);
    expect(recordReason(denied[0]?.details)).toBe('credential_not_found');

    const tampered = await correlationStorage.run(
      { correlationId: cid('vault-tamper-store') },
      () =>
        vault.encrypt({
          companyId: companyA,
          provider: 'shopify',
          label: `tamper ${runId}`,
          plaintext,
          createdById: userId,
        }),
    );
    await app.get(PrismaService).client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.company_id', ${companyA}, true)`;
      const row = await tx.integrationCredential.findFirstOrThrow({ where: { id: tampered.id } });
      const flipped = Buffer.from(row.ciphertext);
      flipped[0] = (flipped[0] ?? 0) ^ 0xff;
      await tx.integrationCredential.update({
        where: { id: tampered.id },
        data: { ciphertext: Uint8Array.from(flipped) },
      });
    });
    await expect(
      correlationStorage.run({ correlationId: cid('vault-tamper-open') }, () =>
        vault.decrypt(companyA, tampered.id),
      ),
    ).rejects.toBeInstanceOf(CredentialCryptoError);
  });

  it('re-encrypts under the next master key', async () => {
    const plaintext = `rotate-secret-μυστικό-${runId}`;
    const entries: string[] = [];
    const log: CredentialLog = {
      info(payload, message) {
        entries.push(`${message} ${JSON.stringify(payload)}`);
      },
    };
    const ring: MasterKeyRing = {
      keys: { k1: randomBytes(32), k2: randomBytes(32) },
      activeKeyId: 'k1',
    };
    const vault = new CredentialVault(app.get(PrismaService), app.get(AuditService), ring, log);
    const stored = await correlationStorage.run({ correlationId: cid('vault-rotate-store') }, () =>
      vault.encrypt({
        companyId: companyA,
        provider: 'shopify',
        label: `rotate ${runId}`,
        plaintext,
        createdById: userId,
      }),
    );
    const before = await readCiphertext(app.get(PrismaService), companyA, stored.id);
    ring.activeKeyId = 'k2';
    const correlationId = cid('vault-rotate');
    const rotated = await correlationStorage.run({ correlationId }, () =>
      vault.rotate(companyA, stored.id),
    );
    expect(rotated).toEqual({ id: stored.id, keyId: 'k2' });
    const after = await readCiphertext(app.get(PrismaService), companyA, stored.id);
    expect(Buffer.compare(before, after)).not.toBe(0);
    const opened = await correlationStorage.run({ correlationId: cid('vault-rotate-open') }, () =>
      vault.decrypt(companyA, stored.id),
    );
    expect(opened).toBe(plaintext);
    expect(entries.join('\n')).not.toContain(plaintext);
    expect(entries.join('\n')).not.toContain('μυστικό');
    const events = await auditEvents(correlationId, companyA);
    expect(events[0]).toEqual(
      expect.objectContaining({
        action: 'credential.rotated',
        objectId: stored.id,
        outcome: 'success',
        correlationId,
      }),
    );
    expect(JSON.stringify(events[0]?.details)).not.toContain(plaintext);
  });
});

async function readCiphertext(prisma: PrismaService, company: string, id: string): Promise<Buffer> {
  const row = await prisma.client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.company_id', ${company}, true)`;
    return tx.integrationCredential.findFirstOrThrow({ where: { id } });
  });
  return Buffer.from(row.ciphertext);
}

function recordReason(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    return undefined;
  }
  const reason = (details as Record<string, unknown>).reason;
  return typeof reason === 'string' ? reason : undefined;
}

async function auditEvents(correlationId: string, companyId: string) {
  const prisma = appAudit();
  return prisma.client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform_scope', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.company_id', ${companyId}, true)`;
    return tx.auditEvent.findMany({ where: { correlationId }, orderBy: { occurredAt: 'asc' } });
  });
}

let auditPrisma: PrismaService | undefined;

function appAudit(): PrismaService {
  if (!auditPrisma) {
    throw new Error('the API was not started');
  }
  return auditPrisma;
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
  auditPrisma = application.get(PrismaService);
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

function cid(name: string): string {
  return `b3-${name}-${runId}`.slice(0, 64);
}
