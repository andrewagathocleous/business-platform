import { describe, expect, it } from 'vitest';
import { prepareTestDatabase } from './prepare-test-db.mjs';

describe('prepareTestDatabase', () => {
  it('applies the ACL when the test database already exists', async () => {
    const calls: string[] = [];
    await prepareTestDatabase({
      databaseExists: () => {
        calls.push('exists');
        return Promise.resolve(true);
      },
      createDatabase: () => {
        calls.push('create');
        return Promise.resolve();
      },
      applyAcl: () => {
        calls.push('acl');
        return Promise.resolve();
      },
      migrate: () => {
        calls.push('migrate');
        return Promise.resolve();
      },
    });
    expect(calls).toEqual(['exists', 'acl', 'migrate']);
  });

  it('creates a missing database and still applies the ACL', async () => {
    const calls: string[] = [];
    await prepareTestDatabase({
      databaseExists: () => Promise.resolve(false),
      createDatabase: () => {
        calls.push('create');
        return Promise.resolve();
      },
      applyAcl: () => {
        calls.push('acl');
        return Promise.resolve();
      },
      migrate: () => {
        calls.push('migrate');
        return Promise.resolve();
      },
    });
    expect(calls).toEqual(['create', 'acl', 'migrate']);
  });
});
