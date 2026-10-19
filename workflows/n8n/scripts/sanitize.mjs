import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT_METADATA = new Set([
  'pinData',
  'staticData',
  'versionId',
  'meta',
  'shared',
  'activeVersion',
  'activeVersionId',
  'triggerCount',
  'createdAt',
  'updatedAt',
]);

const SECRET_KEY =
  /(password|secret|api[_-]?key|access[_-]?token|encryption[_-]?key|client_secret)/i;
const SECRET_VALUE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(?:ql)?:\/\/[^:\s/"]+:[^@\s/"]+@|sk_live_[0-9A-Za-z]+|bps_[0-9a-f-]{8,}/i;
const BEARER_OR_BASIC = /\b(?:bearer|basic)\s+[A-Za-z0-9\-._~+/]{8,}/i;
const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9+/=_~.-]{24,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_SECRET_PROPERTY =
  /"(?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|x-shopify-access-token|cookie|password|secret|client_secret|token)"\s*:\s*"(?!=\{\{)(?!\{\{)[^"]*"/i;

const SENSITIVE_PARAMETER_NAMES = new Set([
  'authorization',
  'proxyauthorization',
  'authentication',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'secret',
  'clientsecret',
  'apikey',
  'xapikey',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'xshopifyaccesstoken',
  'xauthtoken',
  'xaccesstoken',
  'xcsrftoken',
  'privatekey',
]);

export function sanitizeWorkflow(value) {
  return walk(value, []);
}

function walk(value, path) {
  if (Array.isArray(value)) {
    return value.map((item, index) => walk(item, path.concat(String(index))));
  }
  if (value && typeof value === 'object') {
    assertSensitiveParameter(value, path);
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (path.length === 0 && ROOT_METADATA.has(key)) {
        continue;
      }
      if (key === 'pinData' || key === 'staticData') {
        continue;
      }
      if (key === 'credentials' && child && typeof child === 'object') {
        output[key] = stripCredentialIds(child, path.concat(key));
        continue;
      }
      if (
        SECRET_KEY.test(key) &&
        typeof child === 'string' &&
        child.length > 0 &&
        !isAllowedSecretExpression(child)
      ) {
        throw new Error(`Possible secret at ${path.concat(key).join('.')}`);
      }
      output[key] = walk(child, path.concat(key));
    }
    return output;
  }
  if (typeof value === 'string') {
    assertLiteralSecret(value, path);
  }
  return value;
}

function assertSensitiveParameter(value, path) {
  if (!path.includes('parameters')) {
    return;
  }
  if (typeof value.name !== 'string' || !Object.prototype.hasOwnProperty.call(value, 'value')) {
    return;
  }
  if (!isSensitiveParameterName(value.name)) {
    return;
  }
  if (typeof value.value === 'string' && isAllowedSecretExpression(value.value)) {
    return;
  }
  throw new Error(`Possible secret at ${path.concat('value').join('.')}`);
}

function isSensitiveParameterName(name) {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_PARAMETER_NAMES.has(normalized)) {
    return true;
  }
  return (
    normalized.length > 0 &&
    normalized.length <= 80 &&
    /(authorization|apikey|accesstoken|clientsecret|password|secret|token)$/.test(normalized)
  );
}

function isAllowedSecretExpression(value) {
  const trimmed = value.trim();
  if (!/^=?\{\{[\s\S]*\}\}$/.test(trimmed)) {
    return false;
  }
  return /\$credentials\b/.test(trimmed) || /\$env\b/.test(trimmed);
}

function assertLiteralSecret(value, path) {
  const at = path.join('.') || '<root>';
  if (SECRET_VALUE.test(value)) {
    throw new Error(`Possible secret at ${at}`);
  }
  if (!path.includes('parameters') || isAllowedSecretExpression(value)) {
    return;
  }
  if (
    BEARER_OR_BASIC.test(value) ||
    JSON_SECRET_PROPERTY.test(value) ||
    hasHighEntropyLiteral(value)
  ) {
    throw new Error(`Possible secret at ${at}`);
  }
}

function hasHighEntropyLiteral(value) {
  const matches = value.match(HIGH_ENTROPY_TOKEN) ?? [];
  return matches.some((token) => {
    if (UUID.test(token)) {
      return false;
    }
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((pattern) => pattern.test(token)).length;
    return classes >= 2 && shannonEntropy(token) >= 3.8;
  });
}

function shannonEntropy(value) {
  const counts = new Map();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function stripCredentialIds(credentials, path) {
  const output = {};
  for (const [typeName, credential] of Object.entries(credentials)) {
    if (!credential || typeof credential !== 'object' || Array.isArray(credential)) {
      throw new Error(`Unexpected credential shape at ${path.concat(typeName).join('.')}`);
    }
    const next = { ...credential };
    delete next.id;
    if (typeof next.name !== 'string' || next.name.length === 0) {
      throw new Error(`Credential name missing at ${path.concat(typeName).join('.')}`);
    }
    output[typeName] = walk(next, path.concat(typeName));
  }
  return output;
}

async function filesIn(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesIn(path)));
    } else if (extname(entry.name) === '.json') {
      files.push(path);
    }
  }
  return files;
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node workflows/n8n/scripts/sanitize.mjs <export-dir>');
    process.exit(1);
  }
  const files = await filesIn(dir);
  if (files.length === 0) {
    console.error(`No workflow JSON files in ${dir}`);
    process.exit(1);
  }
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const sanitised = sanitizeWorkflow(parsed);
    await writeFile(file, `${JSON.stringify(sanitised, null, 2)}\n`);
  }
  console.log(`Sanitised ${files.length} workflow file(s)`);
}

if (process.argv[1] && process.argv[1].endsWith('sanitize.mjs')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
