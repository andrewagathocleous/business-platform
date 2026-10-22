import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dockerignoreExcludes } from './dockerignore.mjs';

const ignore = readFileSync(resolve(import.meta.dirname, '../.dockerignore'), 'utf8');

describe('dockerignore', () => {
  it('excludes nested env, var, dist and node_modules, and keeps .env.example', () => {
    expect(dockerignoreExcludes(ignore, 'packages/db/.env.production')).toBe(true);
    expect(dockerignoreExcludes(ignore, 'apps/api/.env')).toBe(true);
    expect(dockerignoreExcludes(ignore, '.env.local')).toBe(true);
    expect(dockerignoreExcludes(ignore, 'var/x')).toBe(true);
    expect(dockerignoreExcludes(ignore, 'apps/api/var/service-token.json')).toBe(true);
    expect(dockerignoreExcludes(ignore, 'dist/x')).toBe(true);
    expect(dockerignoreExcludes(ignore, 'packages/domain/dist/x')).toBe(true);
    expect(dockerignoreExcludes(ignore, 'node_modules/x')).toBe(true);
    expect(dockerignoreExcludes(ignore, 'apps/web/node_modules/x')).toBe(true);
    expect(dockerignoreExcludes(ignore, 'var/local-stack/caddy-root.crt')).toBe(true);
    expect(dockerignoreExcludes(ignore, '.env.example')).toBe(false);
    expect(dockerignoreExcludes(ignore, 'packages/db/.env.example')).toBe(false);
    expect(dockerignoreExcludes(ignore, 'apps/api/src/main.ts')).toBe(false);
  });

  it('follows the documented temp and markdown examples', () => {
    const temp = '# comment\n*/temp*\n*/*/temp*\ntemp?\n';
    expect(dockerignoreExcludes(temp, 'somedir/temporary.txt')).toBe(true);
    expect(dockerignoreExcludes(temp, 'somedir/temp')).toBe(true);
    expect(dockerignoreExcludes(temp, 'somedir/subdir/temporary.txt')).toBe(true);
    expect(dockerignoreExcludes(temp, 'tempa')).toBe(true);
    expect(dockerignoreExcludes(temp, 'tempb')).toBe(true);
    expect(dockerignoreExcludes(temp, 'temporary.txt')).toBe(false);
    expect(dockerignoreExcludes(temp, 'temp')).toBe(false);

    const readme = '*.md\n!README.md\n';
    expect(dockerignoreExcludes(readme, 'README.md')).toBe(false);
    expect(dockerignoreExcludes(readme, 'notes.md')).toBe(true);
    expect(dockerignoreExcludes(readme, 'docs/notes.md')).toBe(false);

    const secret = '*.md\n!README*.md\nREADME-secret.md\n';
    expect(dockerignoreExcludes(secret, 'README.md')).toBe(false);
    expect(dockerignoreExcludes(secret, 'README-secret.md')).toBe(true);
    expect(dockerignoreExcludes(secret, 'notes.md')).toBe(true);

    const secretLast = '*.md\nREADME-secret.md\n!README*.md\n';
    expect(dockerignoreExcludes(secretLast, 'README-secret.md')).toBe(false);
    expect(dockerignoreExcludes(secretLast, 'README.md')).toBe(false);
    expect(dockerignoreExcludes(secretLast, 'notes.md')).toBe(true);
  });

  it('re-includes a file under an excluded directory when a later exception matches', () => {
    const patterns = 'var\n!var/keep.txt\n';
    expect(dockerignoreExcludes(patterns, 'var/keep.txt')).toBe(false);
    expect(dockerignoreExcludes(patterns, 'var/other.txt')).toBe(true);
  });

  it('fails the service-token exclusion when a later exception re-includes it', () => {
    const reopened = `${ignore}\n!apps/api/var/service-token.json\n`;
    expect(dockerignoreExcludes(reopened, 'apps/api/var/service-token.json')).toBe(false);
    expect(dockerignoreExcludes(reopened, 'apps/api/var/other.json')).toBe(true);
  });
});
