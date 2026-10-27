import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBundle, isSecretName } from './check-bundle.mjs';

const secret = 'bundle-secret-value-99';

describe('checkBundle', () => {
  it('names a secret variable found in the bundle and does not print the value', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bp-bundle-'));
    const file = join(directory, 'main.js');
    await writeFile(file, `const leaked = ${JSON.stringify(secret)};\n`);
    const result = await checkBundle(directory, {
      CSRF_SECRET: secret,
      SHORT_TOKEN: 'short',
      APP_MASTER_KEY_ACTIVE: 'not-in-the-bundle',
    });
    expect(result.missing).toBe(false);
    expect(result.checked).toBe(2);
    expect(result.hits).toEqual([`${file} contains CSRF_SECRET`]);
    expect(result.hits.join('\n')).not.toContain(secret);
  });

  it('still fails on the fixed needles and ignores a value shorter than 8 characters', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bp-bundle-'));
    const file = join(directory, 'main.js');
    await writeFile(file, 'prefix bps_ token\n');
    const result = await checkBundle(directory, { DATABASE_URL: 'short' });
    expect(result.checked).toBe(0);
    expect(result.hits).toEqual([`${file} contains bps_`]);
  });

  it('passes when secret values are absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bp-bundle-'));
    await writeFile(join(directory, 'main.js'), 'export const ready = true;\n');
    const result = await checkBundle(directory, {
      DATABASE_URL: 'postgresql://bp_app:example-pass@127.0.0.1:5432/business_platform_test',
      OIDC_CLIENT_SECRET: 'oidc-client-secret-value',
    });
    expect(result.hits).toEqual([]);
    expect(result.checked).toBe(2);
    expect(isSecretName('APP_MASTER_KEYS')).toBe(true);
    expect(isSecretName('PORT')).toBe(false);
  });
});
