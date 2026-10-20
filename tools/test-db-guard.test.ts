import { describe, expect, it } from 'vitest';
import {
  assertConnectionTargetsTestDatabase,
  assertDatabaseNameIsTest,
  assertTestDatabaseUrls,
} from './test-db-guard.mjs';

const appUrl = 'postgresql://bp_app:pw@127.0.0.1:5432/business_platform_test';
const ownerUrl = 'postgresql://bp_owner:pw@127.0.0.1:5432/business_platform_test';

describe('assertTestDatabaseUrls', () => {
  it('accepts test database URLs without a database query parameter', () => {
    expect(assertTestDatabaseUrls({ DATABASE_URL: appUrl, DATABASE_URL_OWNER: ownerUrl })).toBe(
      null,
    );
    expect(
      assertTestDatabaseUrls({
        DATABASE_URL: `${appUrl}?application_name=bp_test`,
        DATABASE_URL_OWNER: ownerUrl,
      }),
    ).toBe(null);
  });

  it('rejects a null byte in the query that can smuggle a second database field', () => {
    const refusal = assertTestDatabaseUrls({
      DATABASE_URL:
        'postgresql://bp_app:pw@127.0.0.1:5432/business_platform_test?application_name=x%00database%00business_platform',
      DATABASE_URL_OWNER: ownerUrl,
    });
    expect(refusal).toMatch(/control characters/);
    expect(refusal).toMatch(/DATABASE_URL/);
  });

  it('rejects database and dbname query parameters', () => {
    expect(
      assertTestDatabaseUrls({
        DATABASE_URL: `${appUrl}?database=business_platform`,
        DATABASE_URL_OWNER: ownerUrl,
      }),
    ).toMatch(/"database" query parameter/);
    expect(
      assertTestDatabaseUrls({
        DATABASE_URL: appUrl,
        DATABASE_URL_OWNER: `${ownerUrl}?dbname=business_platform`,
      }),
    ).toMatch(/"dbname" query parameter/);
    expect(
      assertTestDatabaseUrls({
        DATABASE_URL: `${appUrl}?Database=business_platform`,
        DATABASE_URL_OWNER: ownerUrl,
      }),
    ).toMatch(/query parameter/);
  });
});

describe('current database assertion', () => {
  it('rejects a connection whose current_database does not end with _test', async () => {
    expect(() => assertDatabaseNameIsTest('business_platform', 'DATABASE_URL')).toThrow(
      /business_platform/,
    );
    await expect(
      assertConnectionTargetsTestDatabase(
        {
          query: () => Promise.resolve({ rows: [{ current_database: 'business_platform' }] }),
        },
        'DATABASE_URL',
      ),
    ).rejects.toThrow(/does not end with "_test"/);
  });

  it('accepts a connection to a _test database', async () => {
    expect(() => assertDatabaseNameIsTest('business_platform_test', 'DATABASE_URL')).not.toThrow();
    await expect(
      assertConnectionTargetsTestDatabase(
        {
          query: (sql: string) => {
            expect(sql).toMatch(/current_database/);
            return Promise.resolve({ rows: [{ current_database: 'business_platform_test' }] });
          },
        },
        'DATABASE_URL',
      ),
    ).resolves.toBeUndefined();
  });
});
