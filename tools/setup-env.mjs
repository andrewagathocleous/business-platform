import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, '.env');
const example = resolve(root, '.env.example');

if (existsSync(target)) {
  console.log('.env already exists; leaving it unchanged');
  process.exit(0);
}

const source = readFileSync(example, 'utf8');
const values = new Map();
for (const line of source.split('\n')) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!match) {
    continue;
  }
  const key = match[1];
  const raw = match[2];
  values.set(key, raw === 'generate' ? randomBytes(32).toString('hex') : raw);
}

const rendered = source
  .split('\n')
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

writeFileSync(target, rendered.endsWith('\n') ? rendered : `${rendered}\n`, { mode: 0o600 });
console.log('Wrote .env with random local secrets');
