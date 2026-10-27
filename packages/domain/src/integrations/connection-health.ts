export type ConnectionHealthLevel = 'ok' | 'warning' | 'error' | 'paused';

export type ConnectionHealthReason =
  | 'ok'
  | 'paused'
  | 'auth_failed'
  | 'no_sync_yet'
  | 'sync_stale'
  | 'sync_late'
  | 'last_run_failed';

export type ConnectionHealth = {
  level: ConnectionHealthLevel;
  reason: ConnectionHealthReason;
};

export type ConnectionHealthInput = {
  status: string;
  lastSyncAt: Date | null;
  lastErrorAt: Date | null;
  pollIntervalSeconds: number;
  now: Date;
};

const STALE_FLOOR_MS = 15 * 60 * 1000;

/**
 * How a store connection is doing, from what the poller records.
 * - `paused` and `auth_failed` come from the status.
 * - Active with no sync yet is a warning.
 * - A sync older than max(15 minutes, 5 intervals) is an error. This also catches n8n not running.
 * - A sync older than 3 intervals is a warning.
 * - An error recorded after the last sync is a warning.
 * Any other status is treated as paused.
 */
export function connectionHealth(input: ConnectionHealthInput): ConnectionHealth {
  if (input.status === 'auth_failed') {
    return { level: 'error', reason: 'auth_failed' };
  }
  if (input.status !== 'active') {
    return { level: 'paused', reason: 'paused' };
  }
  if (input.lastSyncAt === null) {
    return { level: 'warning', reason: 'no_sync_yet' };
  }
  const intervalMs = input.pollIntervalSeconds * 1000;
  const age = input.now.getTime() - input.lastSyncAt.getTime();
  if (age > Math.max(STALE_FLOOR_MS, 5 * intervalMs)) {
    return { level: 'error', reason: 'sync_stale' };
  }
  if (age > 3 * intervalMs) {
    return { level: 'warning', reason: 'sync_late' };
  }
  if (input.lastErrorAt !== null && input.lastErrorAt.getTime() > input.lastSyncAt.getTime()) {
    return { level: 'warning', reason: 'last_run_failed' };
  }
  return { level: 'ok', reason: 'ok' };
}
