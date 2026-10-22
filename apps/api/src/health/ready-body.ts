export type ReadyBody = { status: 'ok'; runId?: string };

/**
 * `runId` is a harness check. It is present only for local test and development
 * processes that were started with `E2E_RUN_ID`, and it is not part of the public schema.
 */
export function readyPayload(appEnv: string, e2eRunId: string | undefined): ReadyBody {
  if (
    (appEnv === 'test' || appEnv === 'development') &&
    typeof e2eRunId === 'string' &&
    e2eRunId.length > 0
  ) {
    return { status: 'ok', runId: e2eRunId };
  }
  return { status: 'ok' };
}
