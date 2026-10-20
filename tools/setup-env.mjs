import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, '.env');
const example = resolve(root, '.env.example');

const source = readFileSync(example, 'utf8');

function generatedValue(key, raw) {
  if (raw !== 'generate') {
    return raw;
  }
  if (key === 'APP_MASTER_KEYS') {
    return JSON.stringify({ k1: randomBytes(32).toString('base64') });
  }
  return randomBytes(32).toString('hex');
}

function render(lines, values) {
  return lines
    .map((line) => {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (!match) {
        return line;
      }
      const key = match[1];
      const value = values.get(key) ?? '';
      const interpolated = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_marker, name) => {
        const resolved = values.get(name);
        if (!resolved || resolved.includes('${')) {
          throw new Error(`setup:env could not resolve ${name} while writing ${key}`);
        }
        return resolved;
      });
      return `${key}=${interpolated}`;
    })
    .join('\n');
}

function exampleValues() {
  const values = new Map();
  for (const line of source.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    values.set(match[1], generatedValue(match[1], match[2]));
  }
  return values;
}

if (!existsSync(target)) {
  const rendered = render(source.split('\n'), exampleValues());
  writeFileSync(target, rendered.endsWith('\n') ? rendered : `${rendered}\n`, { mode: 0o600 });
  console.log('Wrote .env with random local secrets');
  process.exit(0);
}

const existing = readFileSync(target, 'utf8');
const existingKeys = new Set();
const existingValues = new Map();
for (const line of existing.split('\n')) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!match) {
    continue;
  }
  existingKeys.add(match[1]);
  existingValues.set(match[1], match[2]);
}

const additions = [];
const generated = exampleValues();
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
  console.log('.env already exists; leaving it unchanged');
  process.exit(0);
}

const prefix = existing.endsWith('\n') ? existing : `${existing}\n`;
writeFileSync(target, `${prefix}\n# Added by setup:env\n${additions.join('\n')}\n`);
console.log(`Added ${additions.length} missing key(s) to .env`);
