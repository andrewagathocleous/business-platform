import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config as loadEnv } from 'dotenv';

const NEEDLES = [
  'bps_',
  'APP_MASTER',
  'postgres://',
  'postgresql://',
  'CSRF_SECRET',
  'OIDC_CLIENT_SECRET',
];

const SECRET_SUFFIXES = ['_SECRET', '_PASSWORD', '_KEY', '_TOKEN'];
const SECRET_PREFIXES = ['APP_MASTER_KEY', 'DATABASE_URL'];
const SECRET_EXACT = new Set(['OIDC_CLIENT_SECRET', 'CSRF_SECRET']);

export function isSecretName(name) {
  if (SECRET_EXACT.has(name)) {
    return true;
  }
  if (SECRET_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return true;
  }
  return SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function secretEntries(env) {
  const entries = [];
  for (const [name, value] of Object.entries(env)) {
    if (!isSecretName(name) || typeof value !== 'string' || value.length < 8) {
      continue;
    }
    entries.push({ name, value });
  }
  return entries;
}

export async function checkBundle(directory, env = process.env) {
  try {
    await stat(directory);
  } catch {
    return { missing: true, hits: [], checked: 0 };
  }
  const files = await bundleFiles(directory);
  const hits = [];
  const secrets = secretEntries(env);
  for (const file of files) {
    const text = await readFile(file.path, 'utf8');
    for (const needle of NEEDLES) {
      if (text.includes(needle)) {
        hits.push(`${file.path} contains ${needle}`);
      }
    }
    for (const secret of secrets) {
      if (text.includes(secret.value)) {
        hits.push(`${file.path} contains ${secret.name}`);
      }
    }
  }
  return { missing: false, hits, checked: secrets.length };
}

async function bundleFiles(directory) {
  const found = [];
  await walk(directory, found);
  return found;
}

async function walk(directory, found) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(full, found);
      continue;
    }
    if (!/\.(?:js|mjs|css|html)$/.test(entry.name) || entry.name.endsWith('.map')) {
      continue;
    }
    found.push({ path: full });
  }
}

async function main() {
  const envPath = resolve(import.meta.dirname, '..', '.env');
  if (existsSync(envPath)) {
    loadEnv({ path: envPath });
  }
  const bundle = resolve(import.meta.dirname, '..', 'dist', 'apps', 'web');
  const result = await checkBundle(bundle);
  if (result.missing) {
    console.error(`web bundle not found at ${bundle}`);
    process.exit(1);
  }
  if (result.hits.length > 0) {
    console.error(result.hits.join('\n'));
    process.exit(1);
  }
  console.log(`web bundle check passed`);
  console.log(`secret variables checked: ${String(result.checked)}`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  await main();
}
