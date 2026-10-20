import { config as loadEnv } from 'dotenv';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { refuseUnlessTestDatabase } from './test-db-guard.mjs';

const root = resolve(import.meta.dirname, '..');
loadEnv({ path: resolve(root, '.env') });

if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}
if (process.env.DATABASE_URL_OWNER_TEST) {
  process.env.DATABASE_URL_OWNER = process.env.DATABASE_URL_OWNER_TEST;
}

refuseUnlessTestDatabase();

const prepare = spawnSync('node', ['tools/prepare-test-db.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
if (prepare.status !== 0) {
  process.exit(prepare.status ?? 1);
}

const test = spawnSync('pnpm', ['exec', 'nx', 'run', 'db:test-integration', '--output-style=static'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
if (test.status !== 0) {
  process.exit(test.status ?? 1);
}

const api = spawnSync('pnpm', ['exec', 'nx', 'run', 'api:test-integration', '--output-style=static'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
process.exit(api.status ?? 1);
