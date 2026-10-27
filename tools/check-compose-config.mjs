import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSecretName } from './check-bundle.mjs';

const root = resolve(import.meta.dirname, '..');

/** Secret names the runner is allowed to receive. It executes Code-node JavaScript. */
const RUNNER_SECRETS = new Set(['N8N_RUNNERS_AUTH_TOKEN']);

const LOCAL_CADDY = ['127.0.0.1:8443->443/tcp'];
const LOCAL_N8N = ['127.0.0.1:15678->5678/tcp'];
const PROD_CADDY = ['public:80->80/tcp', 'public:443->443/tcp', 'public:443->443/udp'];
const PROD_N8N = ['127.0.0.1:5678->5678/tcp'];
const LAPTOP_CADDY = ['127.0.0.1:8443->443/tcp'];
const LAPTOP_N8N = ['127.0.0.1:15678->5678/tcp'];

/**
 * @param {unknown} config
 * @param {'prod' | 'local' | 'laptop'} kind
 * @returns {string[]}
 */
export function validateCompose(kind, config) {
  if (!isRecord(config) || !isRecord(config.services)) {
    return ['compose config has no services'];
  }
  const services = config.services;
  const failures = [];
  failures.push(...portFailures(kind, services));
  failures.push(...networkFailures(services));
  failures.push(...secretFailures(services));
  if (kind === 'prod' || kind === 'laptop') {
    failures.push(...ownerUrlFailures(services));
    failures.push(...ownerCliLogFailures(services));
    failures.push(...prodFlagFailures(config));
  }
  if (kind === 'laptop') {
    failures.push(...laptopFlagFailures(config));
  } else if (kind === 'local') {
    failures.push(...localFlagFailures(config));
  }
  return failures;
}

/**
 * @param {'prod' | 'local' | 'laptop'} kind
 * @param {Record<string, unknown>} services
 */
function portFailures(kind, services) {
  const expected =
    kind === 'prod'
      ? { caddy: PROD_CADDY, n8n: PROD_N8N }
      : kind === 'laptop'
        ? { caddy: LAPTOP_CADDY, n8n: LAPTOP_N8N }
        : { caddy: LOCAL_CADDY, n8n: LOCAL_N8N };
  const failures = [];
  for (const [name, service] of Object.entries(services)) {
    const actual = portsOf(service);
    const want = expected[name] ?? [];
    if (!sameSet(actual, want)) {
      failures.push(`${name} ports ${actual.join(',') || 'none'}; expected ${want.join(',') || 'none'}`);
    }
  }
  return failures;
}

/**
 * @param {Record<string, unknown>} services
 */
function networkFailures(services) {
  const failures = [];
  for (const name of ['postgres', 'n8n']) {
    const service = services[name];
    if (!isRecord(service)) {
      failures.push(`${name} is missing`);
      continue;
    }
    const edge = networkNames(service).filter(isEdge);
    if (edge.length > 0) {
      failures.push(`${name} is on ${edge.join(',')}`);
    }
  }
  return failures;
}

/**
 * @param {Record<string, unknown>} services
 */
function secretFailures(services) {
  const failures = [];
  failures.push(...unexpectedSecrets('n8n-runner', services['n8n-runner'], RUNNER_SECRETS));
  failures.push(...unexpectedSecrets('caddy', services.caddy, new Set()));
  return failures;
}

/** In production only the one-shot migrate and the hand-run owner CLI may hold the bp_owner URL. */
const OWNER_URL_SERVICES = new Set(['migrate', 'owner-cli']);

/**
 * @param {Record<string, unknown>} services
 */
function ownerUrlFailures(services) {
  const failures = [];
  for (const [name, service] of Object.entries(services)) {
    if (!OWNER_URL_SERVICES.has(name) && Object.hasOwn(envMap(service), 'DATABASE_URL_OWNER')) {
      failures.push(`${name} receives DATABASE_URL_OWNER`);
    }
  }
  return failures;
}

/**
 * The owner CLI prints a one-time sign-in link, and `files` and `n8n-files` stream
 * stored files for backups, so Docker must log none of them.
 * @param {Record<string, unknown>} services
 */
function ownerCliLogFailures(services) {
  const failures = [];
  for (const name of ['owner-cli', 'files', 'n8n-files']) {
    const service = services[name];
    if (!isRecord(service)) {
      failures.push(`${name} is missing`);
      continue;
    }
    const logging = service.logging;
    if (!isRecord(logging) || logging.driver !== 'none') {
      failures.push(`${name} logging driver is not none`);
    }
  }
  return failures;
}

/**
 * @param {string} name
 * @param {unknown} service
 * @param {Set<string>} allow
 */
function unexpectedSecrets(name, service, allow) {
  if (!isRecord(service)) {
    return [`${name} is missing`];
  }
  const failures = [];
  for (const key of Object.keys(envMap(service))) {
    if (isSecretName(key) && !allow.has(key)) {
      failures.push(`${name} receives secret ${key}`);
    }
  }
  return failures;
}

/**
 * @param {Record<string, unknown>} config
 */
function prodFlagFailures(config) {
  const services = /** @type {Record<string, unknown>} */ (config.services);
  const failures = [];
  for (const name of Object.keys(services)) {
    if (name === 'seed' || name === 'import-fixtures') {
      failures.push(`prod has ${name}`);
    }
  }
  const text = JSON.stringify(config);
  if (text.includes('bp-tools') || text.includes('db:seed') || text.includes('demo:import')) {
    failures.push('prod has a seed, fixture import, or tools image');
  }
  if (/"target"\s*:\s*"tools"/.test(text)) {
    failures.push('prod builds the tools image');
  }
  const entries = serviceEnvs(services);
  const devLogin = valuesOf(entries, 'AUTH_DEV_LOGIN_ENABLED');
  if (devLogin.length === 0 || devLogin.some((value) => value !== 'false')) {
    failures.push('prod AUTH_DEV_LOGIN_ENABLED is not false');
  }
  for (const { name, env } of entries) {
    if (String(env.N8N_SECURE_COOKIE ?? '').toLowerCase() === 'false') {
      failures.push(`${name} sets N8N_SECURE_COOKIE=false`);
    }
    if (String(env.BP_OWNER_CREATEDB ?? '').toLowerCase() === 'on') {
      failures.push(`${name} sets BP_OWNER_CREATEDB=on`);
    }
  }
  const createdb = valuesOf(entries, 'BP_OWNER_CREATEDB');
  if (createdb.length === 0 || createdb.some((value) => value !== 'off')) {
    failures.push('prod BP_OWNER_CREATEDB is not off');
  }
  const secure = valuesOf(entries, 'SESSION_COOKIE_SECURE');
  if (secure.length === 0 || secure.some((value) => value !== 'true')) {
    failures.push('prod SESSION_COOKIE_SECURE is not true');
  }
  return failures;
}

/**
 * The live laptop: its own project name, production mode on the API and the worker, and
 * images by tag only.
 * @param {Record<string, unknown>} config
 */
function laptopFlagFailures(config) {
  const services = /** @type {Record<string, unknown>} */ (config.services);
  const failures = [];
  if (config.name !== 'business-platform-live') {
    failures.push('laptop project name is not business-platform-live');
  }
  for (const name of ['api', 'worker']) {
    if (envMap(services[name]).APP_ENV !== 'production') {
      failures.push(`laptop ${name} APP_ENV is not production`);
    }
  }
  for (const [name, service] of Object.entries(services)) {
    if (isRecord(service) && service.build !== undefined) {
      failures.push(`laptop ${name} has a build section`);
    }
  }
  return failures;
}

/**
 * @param {Record<string, unknown>} config
 */
function localFlagFailures(config) {
  const services = /** @type {Record<string, unknown>} */ (config.services);
  const failures = [];
  if (config.name !== 'business-platform-local') {
    failures.push('local project name is not business-platform-local');
  }
  const entries = serviceEnvs(services);
  const devLogin = valuesOf(entries, 'AUTH_DEV_LOGIN_ENABLED');
  if (devLogin.length === 0 || devLogin.some((value) => value !== 'true')) {
    failures.push('local AUTH_DEV_LOGIN_ENABLED is not true');
  }
  const secure = valuesOf(entries, 'SESSION_COOKIE_SECURE');
  if (secure.length === 0 || secure.some((value) => value !== 'true')) {
    failures.push('local SESSION_COOKIE_SECURE is not true');
  }
  const appEnv = valuesOf(entries, 'APP_ENV');
  if (appEnv.length === 0 || appEnv.some((value) => value !== 'development')) {
    failures.push('local APP_ENV is not development');
  }
  const cookie = valuesOf(entries, 'N8N_SECURE_COOKIE');
  if (cookie.length === 0 || cookie.some((value) => value.toLowerCase() !== 'false')) {
    failures.push('local N8N_SECURE_COOKIE is not false');
  }
  for (const { name, env } of entries) {
    if (String(env.BP_OWNER_CREATEDB ?? '').toLowerCase() === 'on') {
      failures.push(`${name} sets BP_OWNER_CREATEDB=on`);
    }
  }
  if (!isRecord(services.seed) || !isRecord(services['import-fixtures'])) {
    failures.push('local demo profile is missing seed or import-fixtures');
  }
  const importFixtures = services['import-fixtures'];
  const text = JSON.stringify(importFixtures ?? {});
  if (!text.includes('with-prestashop-order')) {
    failures.push('local import-fixtures does not import the prestashop order');
  }
  if (
    isRecord(importFixtures) &&
    isRecord(importFixtures.depends_on) &&
    Object.hasOwn(importFixtures.depends_on, 'seed')
  ) {
    failures.push('local import-fixtures must not depend on seed');
  }
  return failures;
}

/**
 * @param {unknown} service
 * @returns {string[]}
 */
function portsOf(service) {
  if (!isRecord(service) || !Array.isArray(service.ports)) {
    return [];
  }
  return service.ports.map(normalizePort).sort();
}

/**
 * @param {unknown} raw
 */
function normalizePort(raw) {
  if (!isRecord(raw)) {
    return 'unreadable';
  }
  const host = raw.host_ip;
  const hostIp =
    host === undefined || host === null || host === '' || host === '0.0.0.0' || host === '::'
      ? 'public'
      : String(host);
  const published = raw.published === undefined || raw.published === null ? '' : String(raw.published);
  const target = raw.target === undefined || raw.target === null ? '' : String(raw.target);
  const protocol = raw.protocol ? String(raw.protocol) : 'tcp';
  return `${hostIp}:${published}->${target}/${protocol}`;
}

/**
 * @param {unknown} service
 */
function networkNames(service) {
  if (!isRecord(service)) {
    return [];
  }
  const networks = service.networks;
  if (Array.isArray(networks)) {
    return networks.map((name) => String(name));
  }
  if (isRecord(networks)) {
    return Object.keys(networks);
  }
  return [];
}

/**
 * @param {string} name
 */
function isEdge(name) {
  return name === 'edge' || name.endsWith('_edge');
}

/**
 * @param {unknown} service
 * @returns {Record<string, string>}
 */
function envMap(service) {
  if (!isRecord(service)) {
    return {};
  }
  const env = service.environment;
  if (Array.isArray(env)) {
    /** @type {Record<string, string>} */
    const map = {};
    for (const item of env) {
      if (typeof item !== 'string') {
        continue;
      }
      const eq = item.indexOf('=');
      if (eq <= 0) {
        continue;
      }
      map[item.slice(0, eq)] = item.slice(eq + 1);
    }
    return map;
  }
  if (!isRecord(env)) {
    return {};
  }
  /** @type {Record<string, string>} */
  const map = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) {
      continue;
    }
    map[key] = String(value);
  }
  return map;
}

/**
 * Each service is checked on its own. A forbidden value on one service stays
 * visible when another service sets a different value for the same name.
 * @param {Record<string, unknown>} services
 * @returns {{ name: string, env: Record<string, string> }[]}
 */
function serviceEnvs(services) {
  return Object.entries(services).map(([name, service]) => ({ name, env: envMap(service) }));
}

/**
 * @param {{ env: Record<string, string> }[]} entries
 * @param {string} key
 * @returns {string[]}
 */
function valuesOf(entries, key) {
  return entries.map((entry) => entry.env[key]).filter((value) => value !== undefined);
}

/**
 * @param {string[]} actual
 * @param {string[]} expected
 */
function sameSet(actual, expected) {
  if (actual.length !== expected.length) {
    return false;
  }
  const want = [...expected].sort();
  return actual.every((item, index) => item === want[index]);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writePlaceholders() {
  const placeholderDir = resolve(root, 'var/compose-config-check');
  mkdirSync(placeholderDir, { recursive: true, mode: 0o700 });
  const files = {
    'postgres.env':
      'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=placeholder\nPOSTGRES_DB=postgres\nBP_OWNER_PASSWORD=placeholder\nBP_APP_PASSWORD=placeholder\nN8N_DB_PASSWORD=placeholder\n',
    'migrate.env': 'DATABASE_URL_OWNER=postgresql://bp_owner:placeholder@postgres:5432/business_platform\n',
    'api.env':
      'APP_ENV=production\nDATABASE_URL=postgresql://bp_app:placeholder@postgres:5432/business_platform\nCSRF_SECRET=placeholder-secret\nAPP_MASTER_KEYS={"k1":"cGxhY2Vob2xkZXItcGxhY2Vob2xkZXI"}\nAPP_MASTER_KEY_ACTIVE=k1\nOIDC_ISSUER=https://login.microsoftonline.com/placeholder/v2.0\nOIDC_CLIENT_ID=placeholder\nOIDC_CLIENT_SECRET=placeholder-secret\nOIDC_REDIRECT_URI=https://app.example.test/api/auth/oidc/callback\nSTORAGE_ROOT=/var/lib/business-platform/storage\nMOCK_PRINT_ROOT=/var/lib/business-platform/mock-print\nAUTH_DEV_LOGIN_ENABLED=false\nSESSION_COOKIE_SECURE=true\n',
    'n8n.env':
      'DB_POSTGRESDB_PASSWORD=placeholder\nN8N_ENCRYPTION_KEY=placeholder-secret\nN8N_RUNNERS_AUTH_TOKEN=placeholder-secret\n',
    'n8n-runner.env': 'N8N_RUNNERS_AUTH_TOKEN=placeholder-secret\n',
    'caddy.env': 'APP_DOMAIN=app.example.test\nACME_EMAIL=ops@example.test\n',
    'interpolate.env': `BP_IMAGE_TAG=validate\nBP_ENV_DIR=${placeholderDir}\n`,
  };
  for (const [name, text] of Object.entries(files)) {
    const file = resolve(placeholderDir, name);
    if (!existsSync(file)) {
      writeFileSync(file, text, { mode: 0o600 });
    }
  }
  return placeholderDir;
}

/**
 * @param {string[]} args
 */
function compose(args) {
  return spawnSync('docker', ['compose', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
  });
}

/**
 * @param {string} text
 */
function redact(text) {
  return text
    .replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]')
    .replace(/((?:SECRET|PASSWORD|KEY|TOKEN|DATABASE_URL)[A-Z0-9_]*=)\S+/gi, '$1[redacted]');
}

/**
 * @param {string} label
 * @param {string[]} args
 * @param {string[]} failures
 */
function quiet(label, args, failures) {
  const result = compose([...args, 'config', '--quiet']);
  if (result.status === 0) {
    console.log(`PASS ${label}`);
    return;
  }
  failures.push(label);
  console.log(`FAIL ${label}`);
  console.log(redact(`${result.stderr}\n${result.stdout}`).slice(0, 800));
}

/**
 * @param {string[]} args
 * @returns {{ ok: true, config: unknown } | { ok: false, error: string }}
 */
function rendered(args) {
  const result = compose([...args, 'config', '--format', 'json']);
  if (result.status !== 0) {
    return { ok: false, error: redact(`${result.stderr}\n${result.stdout}`).slice(0, 800) };
  }
  try {
    return { ok: true, config: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: 'config JSON was not parseable' };
  }
}

function main() {
  const failures = [];
  const placeholderDir = writePlaceholders();
  // The ops profile renders the hand-run owner-cli service too, so its checks apply.
  const prodArgs = [
    '--env-file',
    resolve(placeholderDir, 'interpolate.env'),
    '-f',
    'infra/compose/compose.prod.yml',
    '--profile',
    'ops',
  ];
  quiet('prod config', prodArgs, failures);
  const prod = rendered(prodArgs);
  if (prod.ok) {
    const found = validateCompose('prod', prod.config);
    if (found.length === 0) {
      console.log('PASS prod rendered');
    } else {
      failures.push('prod rendered');
      for (const failure of found) {
        console.log(`FAIL prod rendered: ${failure}`);
      }
    }
  } else {
    failures.push('prod rendered');
    console.log('FAIL prod rendered');
    console.log(prod.error);
  }

  const laptopArgs = [
    '--env-file',
    resolve(placeholderDir, 'interpolate.env'),
    '-f',
    'infra/compose/compose.prod.yml',
    '-f',
    'infra/compose/compose.laptop.yml',
    '--profile',
    'ops',
  ];
  quiet('laptop config', laptopArgs, failures);
  const laptop = rendered(laptopArgs);
  if (laptop.ok) {
    const found = validateCompose('laptop', laptop.config);
    if (found.length === 0) {
      console.log('PASS laptop rendered');
    } else {
      failures.push('laptop rendered');
      for (const failure of found) {
        console.log(`FAIL laptop rendered: ${failure}`);
      }
    }
  } else {
    failures.push('laptop rendered');
    console.log('FAIL laptop rendered');
    console.log(laptop.error);
  }

  const localStack = resolve(root, '.env.local-stack');
  if (!existsSync(localStack)) {
    failures.push('local env file');
    console.log('FAIL local env file');
  } else {
    const localArgs = [
      '-p',
      'business-platform-local',
      '-f',
      'infra/compose/compose.prod.yml',
      '-f',
      'infra/compose/compose.local.yml',
      '--env-file',
      localStack,
    ];
    quiet('local config', localArgs, failures);
    quiet('local demo config', [...localArgs, '--profile', 'demo'], failures);
    const local = rendered([...localArgs, '--profile', 'demo']);
    if (local.ok) {
      const found = validateCompose('local', local.config);
      if (found.length === 0) {
        console.log('PASS local rendered');
      } else {
        failures.push('local rendered');
        for (const failure of found) {
          console.log(`FAIL local rendered: ${failure}`);
        }
      }
    } else {
      failures.push('local rendered');
      console.log('FAIL local rendered');
      console.log(local.error);
    }
  }

  if (failures.length > 0) {
    process.exit(1);
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  main();
}
