import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKER_HEARTBEAT_PATH, touchWorkerHeartbeat } from './worker-heartbeat';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('touchWorkerHeartbeat', () => {
  it('creates an empty file and sets its mtime', () => {
    const file = tempFile();
    const at = new Date('2026-03-01T00:00:00.000Z');
    touchWorkerHeartbeat(file, at);
    const stat = statSync(file);
    expect(stat.size).toBe(0);
    expect(stat.mtimeMs).toBe(at.getTime());
    expect(WORKER_HEARTBEAT_PATH).toBe('/tmp/bp-worker-heartbeat');
  });

  it('moves the mtime forward and keeps existing bytes', () => {
    const file = tempFile();
    writeFileSync(file, 'keep');
    const first = new Date('2026-03-01T00:00:00.000Z');
    const second = new Date('2026-03-01T00:00:30.000Z');
    touchWorkerHeartbeat(file, first);
    touchWorkerHeartbeat(file, second);
    expect(statSync(file).mtimeMs).toBe(second.getTime());
    expect(readFileSync(file, 'utf8')).toBe('keep');
  });
});

function tempFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bp-heartbeat-'));
  directories.push(directory);
  return join(directory, 'beat');
}
