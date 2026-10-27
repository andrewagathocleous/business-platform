// Integration tests and the test-database scripts must never touch the dev database.
import pg from 'pg';

const TEST_URLS = ['DATABASE_URL', 'DATABASE_URL_OWNER'];
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const DATABASE_QUERY_KEYS = new Set(['database', 'dbname']);

export function databaseName(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
}

export function testUrlQueryProblem(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'is not a valid URL';
  }
  const rawQuery = parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search;
  let decoded = rawQuery;
  try {
    decoded = decodeURIComponent(rawQuery);
  } catch {
    return 'has a query that cannot be decoded';
  }
  if (CONTROL_CHARACTERS.test(decoded)) {
    return 'has a query containing control characters';
  }
  for (const [key, value] of parsed.searchParams) {
    if (CONTROL_CHARACTERS.test(key) || CONTROL_CHARACTERS.test(value)) {
      return 'has a query containing control characters';
    }
    if (DATABASE_QUERY_KEYS.has(key.toLowerCase())) {
      return `has a "${key}" query parameter, which can override the database name`;
    }
  }
  return null;
}

export function assertDatabaseNameIsTest(name, label) {
  if (typeof name !== 'string' || !name.endsWith('_test')) {
    throw new Error(
      `${label} connected to database "${name ?? ''}", which does not end with "_test". Refusing to continue.`,
    );
  }
}

export async function assertConnectionTargetsTestDatabase(client, label) {
  const result = await client.query('SELECT current_database() AS current_database');
  const name = result.rows[0]?.current_database;
  assertDatabaseNameIsTest(name, label);
}

export async function assertEnvConnectionsTargetTestDatabase(env = process.env) {
  const refusal = assertTestDatabaseUrls(env);
  if (refusal) {
    throw new Error(refusal);
  }
  for (const name of TEST_URLS) {
    const client = new pg.Client({ connectionString: env[name] });
    await client.connect();
    try {
      await assertConnectionTargetsTestDatabase(client, name);
    } finally {
      await client.end();
    }
  }
}

export function assertTestDatabaseUrls(env = process.env) {
  const failures = [];
  for (const name of TEST_URLS) {
    const value = env[name];
    if (!value) {
      failures.push(`${name} is not set`);
      continue;
    }
    const database = databaseName(value);
    if (!database.endsWith('_test')) {
      failures.push(
        `${name} selects database "${database || '(unparseable)'}", which does not end with "_test"`,
      );
    }
    const queryProblem = testUrlQueryProblem(value);
    if (queryProblem) {
      failures.push(`${name} ${queryProblem}`);
    }
  }
  if (failures.length === 0) {
    return null;
  }
  return [
    'Refusing to run: integration tests and test-database scripts only touch databases whose names end with "_test".',
    ...failures.map((line) => `- ${line}`),
    'The dev database (business_platform) must not be used here.',
  ].join('\n');
}

export function refuseUnlessTestDatabase() {
  const refusal = assertTestDatabaseUrls();
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
}
