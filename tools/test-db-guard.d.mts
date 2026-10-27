export function databaseName(url: string): string;

export function testUrlQueryProblem(url: string): string | null;

export function assertDatabaseNameIsTest(name: string | undefined, label: string): void;

export function assertConnectionTargetsTestDatabase(
  client: {
    query: (sql: string) => Promise<{ rows: Array<{ current_database?: string }> }>;
  },
  label: string,
): Promise<void>;

export function assertEnvConnectionsTargetTestDatabase(env?: NodeJS.ProcessEnv): Promise<void>;

export function assertTestDatabaseUrls(env?: NodeJS.ProcessEnv): string | null;

export function refuseUnlessTestDatabase(): void;
