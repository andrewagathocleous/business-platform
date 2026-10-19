// Integration tests and the test-database scripts must never touch the dev database.

const TEST_URLS = ['DATABASE_URL', 'DATABASE_URL_OWNER'];

export function databaseName(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
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
