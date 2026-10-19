import { config as loadEnv } from 'dotenv';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyAppDatabaseAcl } from './db-acl.mjs';
import { databaseName, refuseUnlessTestDatabase } from './test-db-guard.mjs';

loadEnv({ path: resolve(import.meta.dirname, '../.env') });

const ownerUrl = process.env.DATABASE_URL_OWNER_TEST;
const appUrl = process.env.DATABASE_URL_TEST;
if (!ownerUrl || !appUrl || !process.env.POSTGRES_PASSWORD) {
  console.error('DATABASE_URL_TEST, DATABASE_URL_OWNER_TEST and POSTGRES_PASSWORD are required');
  process.exit(1);
}
process.env.DATABASE_URL = appUrl;
process.env.DATABASE_URL_OWNER = ownerUrl;
refuseUnlessTestDatabase();

const database = databaseName(ownerUrl);
if (database !== 'business_platform_test') {
  console.error('db:reset:test only drops business_platform_test');
  process.exit(1);
}

const databaseUrl = new URL(ownerUrl);
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
await admin.query(
  'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
  [database],
);
await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(database)}`);
await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(database)} OWNER bp_owner`);
await admin.end();

await applyAppDatabaseAcl({ host, port, user, password, database });

const result = spawnSync('pnpm', ['--filter', '@bp/db', 'exec', 'prisma', 'migrate', 'deploy'], {
  cwd: resolve(import.meta.dirname, '..'),
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
