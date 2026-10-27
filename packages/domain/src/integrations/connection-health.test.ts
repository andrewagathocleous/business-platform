import { describe, expect, it } from 'vitest';
import { connectionHealth, type ConnectionHealthInput } from './connection-health';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function at(msBeforeNow: number): Date {
  return new Date(NOW.getTime() - msBeforeNow);
}

function health(overrides: Partial<ConnectionHealthInput>) {
  return connectionHealth({
    status: 'active',
    lastSyncAt: at(MINUTE),
    lastErrorAt: null,
    pollIntervalSeconds: 180,
    now: NOW,
    ...overrides,
  });
}

describe('connectionHealth', () => {
  it('reports paused and auth_failed from the status', () => {
    expect(health({ status: 'paused' })).toEqual({ level: 'paused', reason: 'paused' });
    expect(health({ status: 'auth_failed' })).toEqual({ level: 'error', reason: 'auth_failed' });
    expect(health({ status: 'something_else' })).toEqual({ level: 'paused', reason: 'paused' });
  });

  it('warns when an active connection has not synced yet', () => {
    expect(health({ lastSyncAt: null })).toEqual({ level: 'warning', reason: 'no_sync_yet' });
  });

  it('is ok within three intervals', () => {
    expect(health({ lastSyncAt: at(9 * MINUTE) })).toEqual({ level: 'ok', reason: 'ok' });
  });

  it('warns one second after three intervals', () => {
    expect(health({ lastSyncAt: at(9 * MINUTE - SECOND) }).reason).toBe('ok');
    expect(health({ lastSyncAt: at(9 * MINUTE + SECOND) })).toEqual({ level: 'warning', reason: 'sync_late' });
  });

  it('errors after 15 minutes when that is longer than five intervals', () => {
    expect(health({ lastSyncAt: at(15 * MINUTE - SECOND) }).reason).toBe('sync_late');
    expect(health({ lastSyncAt: at(15 * MINUTE) }).reason).toBe('sync_late');
    expect(health({ lastSyncAt: at(15 * MINUTE + SECOND) })).toEqual({ level: 'error', reason: 'sync_stale' });
  });

  it('errors after five intervals when that is longer than 15 minutes', () => {
    const tenMinutes = { pollIntervalSeconds: 600 };
    expect(health({ ...tenMinutes, lastSyncAt: at(30 * MINUTE + SECOND) }).reason).toBe('sync_late');
    expect(health({ ...tenMinutes, lastSyncAt: at(50 * MINUTE) }).reason).toBe('sync_late');
    expect(health({ ...tenMinutes, lastSyncAt: at(50 * MINUTE + SECOND) }).reason).toBe('sync_stale');
  });

  it('warns when the last run failed after the last sync', () => {
    expect(health({ lastSyncAt: at(2 * MINUTE), lastErrorAt: at(MINUTE) })).toEqual({
      level: 'warning',
      reason: 'last_run_failed',
    });
    expect(health({ lastSyncAt: at(MINUTE), lastErrorAt: at(2 * MINUTE) }).reason).toBe('ok');
    expect(health({ lastSyncAt: at(MINUTE), lastErrorAt: at(MINUTE) }).reason).toBe('ok');
  });

  it('lets a stale or late sync win over a failed run', () => {
    expect(health({ lastSyncAt: at(20 * MINUTE), lastErrorAt: at(MINUTE) }).reason).toBe('sync_stale');
    expect(health({ lastSyncAt: at(10 * MINUTE), lastErrorAt: at(MINUTE) }).reason).toBe('sync_late');
  });
});
