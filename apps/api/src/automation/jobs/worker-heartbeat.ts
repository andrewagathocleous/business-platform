import { closeSync, constants, futimesSync, openSync } from 'node:fs';

/**
 * The worker compose healthcheck treats this file as alive when its mtime
 * is at most 60 seconds old. The job loop touches it when a tick starts,
 * after reclaim finishes, after each successful claim, and when that tick
 * finishes. A claim that never settles does not refresh it. The finish touch
 * is skipped once shutdown has begun.
 */
export const WORKER_HEARTBEAT_PATH = '/tmp/bp-worker-heartbeat';

/** Creates the file if needed and sets its mtime. Existing bytes are left as they are. */
export function touchWorkerHeartbeat(file: string, at: Date = new Date()): void {
  const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    futimesSync(fd, at, at);
  } finally {
    closeSync(fd);
  }
}
