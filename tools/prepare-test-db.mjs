import { config as loadEnv } from 'dotenv';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyAppDatabaseAcl } from './db-acl.mjs';
import {
  assertEnvConnectionsTargetTestDatabase,
  databaseName,
  refuseUnlessTestDatabase,
} from './test-db-guard.mjs';

// Always apply the ACL. An existing test database created by an older script
// still has PUBLIC CONNECT, and applyAppDatabaseAcl is idempotent.
export async function prepareTestDatabase({ databaseExists, createDatabase, applyAcl, migrate }) {
  if (!(await databaseExists())) {
    await createDatabase();
  }
  await applyAcl();
  await migrate();
}

async function main() {
  loadEnv({ path: resolve(import.meta.dirname, '../.env') });
  refuseUnlessTestDatabase();

  const ownerUrl = process.env.DATABASE_URL_OWNER;
  if (!ownerUrl) {
    console.error('DATABASE_URL_OWNER is required');
    process.exit(1);
  }

  const databaseUrl = new URL(ownerUrl);
  const database = databaseName(ownerUrl);
  const host = databaseUrl.hostname;
  const port = Number(databaseUrl.port || 5432);
  const user = process.env.POSTGRES_USER || 'postgres';
  const password = process.env.POSTGRES_PASSWORD;
  const admin = new pg.Client({
    host,
    port,
    user,
    password,
    database: 'postgres',
  });

  await admin.connect();
  try {
    await prepareTestDatabase({
      databaseExists: async () => {
        const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
          database,
        ]);
        return existing.rowCount !== 0;
      },
      createDatabase: async () => {
        await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(database)} OWNER bp_owner`);
      },
      applyAcl: async () => {
        await applyAppDatabaseAcl({ host, port, user, password, database });
      },
      migrate: async () => {
        await assertEnvConnectionsTargetTestDatabase();
        const result = spawnSync(
          'pnpm',
          ['--filter', '@bp/db', 'exec', 'prisma', 'migrate', 'deploy'],
          {
            cwd: resolve(import.meta.dirname, '..'),
            stdio: 'inherit',
            env: process.env,
          },
        );
        if ((result.status ?? 1) !== 0) {
          process.exit(result.status ?? 1);
        }
      },
    });
  } finally {
    await admin.end();
  }
}

if (process.argv[1]?.endsWith('prepare-test-db.mjs')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
