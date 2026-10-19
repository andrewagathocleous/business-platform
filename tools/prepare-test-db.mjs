import { config as loadEnv } from 'dotenv';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyAppDatabaseAcl } from './db-acl.mjs';
import { databaseName, refuseUnlessTestDatabase } from './test-db-guard.mjs';

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
const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
const created = existing.rowCount === 0;
if (created) {
  await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(database)} OWNER bp_owner`);
}
await admin.end();

if (created) {
  await applyAppDatabaseAcl({ host, port, user, password, database });
}

const result = spawnSync('pnpm', ['--filter', '@bp/db', 'exec', 'prisma', 'migrate', 'deploy'], {
  cwd: resolve(import.meta.dirname, '..'),
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
