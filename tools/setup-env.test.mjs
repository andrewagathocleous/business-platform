import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planDotEnv, planLocalStack, writePrivate } from './setup-env.mjs';

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('planDotEnv', () => {
  const example = [
    'APP_ENV=development',
    'CSRF_SECRET=generate',
    'DATABASE_URL=postgresql://bp_app:${CSRF_SECRET}@127.0.0.1/db',
    '',
  ].join('\n');

  it('fills generate and interpolates a new file', () => {
    const plan = planDotEnv(example, null, () => 'abc123', () => 'master');
    expect(plan.message).toBe('Wrote .env with random local secrets');
    expect(plan.text).toContain('CSRF_SECRET=abc123');
    expect(plan.text).toContain('DATABASE_URL=postgresql://bp_app:abc123@127.0.0.1/db');
  });

  it('does not replace an existing value and appends only missing keys', () => {
    const plan = planDotEnv(example, 'CSRF_SECRET=keep-me\n', () => 'new-secret', () => 'master');
    expect(plan.message).toBe('Added 2 missing key(s) to .env');
    expect(plan.text.startsWith('CSRF_SECRET=keep-me\n')).toBe(true);
    expect(plan.text).not.toContain('CSRF_SECRET=new-secret');
    expect(plan.text).toContain('APP_ENV=development');
    expect(plan.text).toContain('DATABASE_URL=postgresql://bp_app:keep-me@127.0.0.1/db');
  });

  it('leaves a complete file unchanged', () => {
    const existing =
      'APP_ENV=development\nCSRF_SECRET=keep-me\nDATABASE_URL=postgresql://bp_app:keep-me@127.0.0.1/db\n';
    const plan = planDotEnv(example, existing, () => 'new-secret', () => 'master');
    expect(plan).toEqual({ message: '.env already exists; leaving it unchanged' });
  });
});

describe('planLocalStack', () => {
  it('does not call random when the file already exists', () => {
    const plan = planLocalStack(true, {
      hex: () => {
        throw new Error('hex was called');
      },
      master: () => {
        throw new Error('master was called');
      },
    });
    expect(plan).toEqual({
      action: 'skip',
      message: '.env.local-stack already exists; leaving it unchanged',
    });
  });

  it('generates a new file and does not copy a supplied dev secret', () => {
    const devSecret = 'dev-secret-should-not-leak';
    let n = 0;
    const plan = planLocalStack(false, {
      hex: () => `hex-${String(n++)}-not-the-dev-file`,
      master: () => 'bWFzdGVyLWtleS1mb3ItdGhlLWxvY2FsLXN0YWNr',
    });
    expect(plan.action).toBe('write');
    const text = plan.text ?? '';
    expect(text).not.toContain(devSecret);
    expect(text).toContain('APP_ENV=development');
    expect(text).toContain('AUTH_DEV_LOGIN_ENABLED=true');
    expect(text).toContain('SESSION_COOKIE_SECURE=true');
    expect(text).toContain('BP_OWNER_CREATEDB=off');
    expect(text).toContain('@postgres:5432/business_platform');
    expect(text).not.toContain('N8N_SECURE_COOKIE');
    expect(text).toContain('APP_DOMAIN=localhost');
    expect(text).toContain('STORAGE_ROOT=/var/lib/business-platform/storage');
    const password = value(text, 'N8N_DB_PASSWORD');
    expect(value(text, 'DB_POSTGRESDB_PASSWORD')).toBe(password);
    expect(value(text, 'CSRF_SECRET')).not.toBe(password);
    expect(value(text, 'APP_MASTER_KEYS')).toContain('bWFzdGVyLWtleS1mb3ItdGhlLWxvY2FsLXN0YWNr');
  });

  it('uses a fresh random value on each generation', () => {
    const first = planLocalStack(false, { hex: () => 'first-hex-value', master: () => 'first-master' });
    const second = planLocalStack(false, { hex: () => 'second-hex-value', master: () => 'second-master' });
    expect(first.text).not.toBe(second.text);
  });
});

describe('writePrivate', () => {
  it('writes mode 0600', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bp-setup-env-'));
    directories.push(directory);
    const file = join(directory, 'secret.env');
    writePrivate(file, 'APP_ENV=development\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

function value(text, key) {
  const line = text.split('\n').find((item) => item.startsWith(`${key}=`));
  if (!line) {
    throw new Error(`missing ${key}`);
  }
  return line.slice(key.length + 1);
}
