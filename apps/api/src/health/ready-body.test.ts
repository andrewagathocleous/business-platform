import { describe, expect, it } from 'vitest';
import { readyPayload } from './ready-body';

describe('readyPayload', () => {
  it('adds runId only for test and development when E2E_RUN_ID is set', () => {
    expect(readyPayload('test', '11111111-1111-4111-8111-111111111111')).toEqual({
      status: 'ok',
      runId: '11111111-1111-4111-8111-111111111111',
    });
    expect(readyPayload('development', 'run-dev')).toEqual({ status: 'ok', runId: 'run-dev' });
    expect(readyPayload('test', undefined)).toEqual({ status: 'ok' });
    expect(readyPayload('test', '')).toEqual({ status: 'ok' });
    expect(readyPayload('uat', 'run-uat')).toEqual({ status: 'ok' });
    expect(readyPayload('production', 'run-prod')).toEqual({ status: 'ok' });
  });
});
