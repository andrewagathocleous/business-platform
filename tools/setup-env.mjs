import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

/**
 * @param {string} key
 * @param {string} raw
 * @param {() => string} randomHex
 * @param {() => string} randomMaster
 */
export function generatedValue(key, raw, randomHex, randomMaster) {
  if (raw !== 'generate') {
    return raw;
  }
  if (key === 'APP_MASTER_KEYS') {
    return JSON.stringify({ k1: randomMaster() });
  }
  return randomHex();
}

/**
 * @param {string[]} lines
 * @param {Map<string, string>} values
 */
export function render(lines, values) {
  return lines
    .map((line) => {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (!match) {
        return line;
      }
      const key = match[1];
      const value = values.get(key) ?? '';
      return `${key}=${interpolate(value, key, values)}`;
    })
    .join('\n');
}

/**
 * @param {string} exampleText
 * @param {string | null} existingText
 * @param {() => string} randomHex
 * @param {() => string} randomMaster
 * @returns {{ message: string, text?: string }}
 */
export function planDotEnv(exampleText, existingText, randomHex, randomMaster) {
  const generated = exampleValues(exampleText, randomHex, randomMaster);
  if (existingText === null) {
    const rendered = render(exampleText.split('\n'), generated);
    return {
      message: 'Wrote .env with random local secrets',
      text: rendered.endsWith('\n') ? rendered : `${rendered}\n`,
    };
  }
  const existingKeys = new Set();
  const existingValues = new Map();
  for (const line of existingText.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    existingKeys.add(match[1]);
    existingValues.set(match[1], match[2]);
  }
  const additions = [];
  for (const [key, value] of generated) {
    if (existingKeys.has(key)) {
      continue;
    }
    const interpolated = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_marker, name) => {
      const resolved = existingValues.get(name) ?? generated.get(name);
      if (!resolved || resolved.includes('${')) {
        throw new Error(`setup:env could not resolve ${name} while writing ${key}`);
      }
      return resolved;
    });
    additions.push(`${key}=${interpolated}`);
  }
  if (additions.length === 0) {
    return { message: '.env already exists; leaving it unchanged' };
  }
  const prefix = existingText.endsWith('\n') ? existingText : `${existingText}\n`;
  return {
    message: `Added ${String(additions.length)} missing key(s) to .env`,
    text: `${prefix}\n# Added by setup:env\n${additions.join('\n')}\n`,
  };
}

/**
 * Plans `.env.local-stack`. An existing file is left untouched and `random` is not called.
 * New values are random. This does not read `.env`.
 *
 * @param {boolean} exists
 * @param {{ hex: () => string, master: () => string }} random
 * @returns {{ action: 'skip' | 'write', message: string, text?: string }}
 */
export function planLocalStack(exists, random) {
  if (exists) {
    return {
      action: 'skip',
      message: '.env.local-stack already exists; leaving it unchanged',
    };
  }
  return {
    action: 'write',
    message: 'Wrote .env.local-stack with random local secrets',
    text: `${renderLocalStack(random)}\n`,
  };
}

/**
 * @param {string} file
 * @param {string} text
 */
export function writePrivate(file, text) {
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * @param {string} exampleText
 * @param {() => string} randomHex
 * @param {() => string} randomMaster
 */
function exampleValues(exampleText, randomHex, randomMaster) {
  const values = new Map();
  for (const line of exampleText.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    values.set(match[1], generatedValue(match[1], match[2], randomHex, randomMaster));
  }
  return values;
}

/**
 * @param {string} value
 * @param {string} key
 * @param {Map<string, string>} values
 */
function interpolate(value, key, values) {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_marker, name) => {
    const resolved = values.get(name);
    if (!resolved || resolved.includes('${')) {
      throw new Error(`setup:env could not resolve ${name} while writing ${key}`);
    }
    return resolved;
  });
}

/**
 * @param {{ hex: () => string, master: () => string }} random
 */
function renderLocalStack(random) {
  /** @type {Map<string, string>} */
  const values = new Map([
    ['BP_IMAGE_TAG', 'local'],
    ['BP_ENV_DIR', '/opt/business-platform/env'],
    ['APP_DOMAIN', 'localhost'],
    ['ACME_EMAIL', 'ops@example.test'],
    ['APP_ENV', 'development'],
    ['AUTH_DEV_LOGIN_ENABLED', 'true'],
    ['SESSION_COOKIE_SECURE', 'true'],
    ['AUTH_REQUIRE_MFA_FOR_PRIVILEGED', 'false'],
    ['HOST', '0.0.0.0'],
    ['PORT', '3000'],
    ['POSTGRES_USER', 'postgres'],
    ['POSTGRES_DB', 'postgres'],
    ['POSTGRES_PASSWORD', random.hex()],
    ['BP_OWNER_PASSWORD', random.hex()],
    ['BP_APP_PASSWORD', random.hex()],
    ['N8N_DB_PASSWORD', random.hex()],
    ['BP_OWNER_CREATEDB', 'off'],
    ['DATABASE_URL', 'postgresql://bp_app:${BP_APP_PASSWORD}@postgres:5432/business_platform'],
    ['DATABASE_URL_OWNER', 'postgresql://bp_owner:${BP_OWNER_PASSWORD}@postgres:5432/business_platform'],
    ['DATABASE_URL_TEST', 'postgresql://bp_app:${BP_APP_PASSWORD}@postgres:5432/business_platform_test'],
    [
      'DATABASE_URL_OWNER_TEST',
      'postgresql://bp_owner:${BP_OWNER_PASSWORD}@postgres:5432/business_platform_test',
    ],
    ['DB_POSTGRESDB_PASSWORD', '${N8N_DB_PASSWORD}'],
    ['N8N_ENCRYPTION_KEY', random.hex()],
    ['N8N_RUNNERS_AUTH_TOKEN', random.hex()],
    ['CSRF_SECRET', random.hex()],
    ['APP_MASTER_KEYS', JSON.stringify({ k1: random.master() })],
    ['APP_MASTER_KEY_ACTIVE', 'k1'],
    ['OIDC_ISSUER', ''],
    ['OIDC_CLIENT_ID', ''],
    ['OIDC_CLIENT_SECRET', ''],
    ['OIDC_REDIRECT_URI', ''],
    ['STORAGE_ROOT', '/var/lib/business-platform/storage'],
    ['MOCK_PRINT_ROOT', '/var/lib/business-platform/mock-print'],
    ['THROTTLE_DEFAULT_LIMIT', '300'],
    ['THROTTLE_AUTH_LIMIT', '20'],
    ['THROTTLE_AUTOMATION_LIMIT', '120'],
  ]);
  const lines = [
    '# Local production-like stack. Generated by `pnpm setup:env --local-stack`.',
    '# Gitignored. Not copied from .env. Compose project: business-platform-local.',
    ...[...values.keys()].map((key) => `${key}=`),
  ];
  const dbPassword = lines.indexOf('N8N_DB_PASSWORD=');
  lines.splice(
    dbPassword + 1,
    0,
    '# Same value as N8N_DB_PASSWORD. n8n reads this name; the init script reads N8N_DB_PASSWORD.',
  );
  return render(lines, values);
}

function run(argv) {
  const randomHex = () => randomBytes(32).toString('hex');
  const randomMaster = () => randomBytes(32).toString('base64');
  if (argv.includes('--local-stack')) {
    const target = resolve(root, '.env.local-stack');
    const plan = planLocalStack(existsSync(target), { hex: randomHex, master: randomMaster });
    if (plan.text) {
      writePrivate(target, plan.text);
    }
    console.log(plan.message);
    return;
  }
  const target = resolve(root, '.env');
  const example = readFileSync(resolve(root, '.env.example'), 'utf8');
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : null;
  const plan = planDotEnv(example, existing, randomHex, randomMaster);
  if (plan.text && existing === null) {
    writePrivate(target, plan.text);
  } else if (plan.text) {
    writeFileSync(target, plan.text);
  }
  console.log(plan.message);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  run(process.argv.slice(2));
}
