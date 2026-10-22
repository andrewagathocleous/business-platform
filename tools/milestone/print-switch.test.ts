import { describe, expect, it } from 'vitest';
import { attemptWithPrinting } from './print-switch';

describe('attemptWithPrinting', () => {
  it('restores the previous off state when the print throws', async () => {
    const writes: string[] = [];
    let persisted = false;
    const attempt = await attemptWithPrinting({
      enabled: false,
      enableReason: 'on',
      restoreReason: 'off',
      enable: (reason) => {
        persisted = true;
        writes.push(`enable ${reason}`);
        return Promise.resolve();
      },
      readEnabled: () => Promise.resolve(persisted),
      restore: (enabled, reason) => {
        persisted = enabled;
        writes.push(`restore ${String(enabled)} ${reason}`);
        return Promise.resolve();
      },
      run: () => Promise.reject(new Error('worker down')),
    });
    expect(writes).toEqual(['enable on', 'restore false off']);
    expect(attempt.changed).toBe(true);
    expect(attempt.error).toBeInstanceOf(Error);
    expect(attempt.cleanupError).toBeUndefined();
    expect(attempt.persisted).toBe(false);
  });

  it('does not write when printing was already on', async () => {
    const writes: string[] = [];
    const attempt = await attemptWithPrinting({
      enabled: true,
      enableReason: 'on',
      restoreReason: 'off',
      enable: () => {
        writes.push('enable');
        return Promise.resolve();
      },
      readEnabled: () => Promise.resolve(true),
      restore: () => {
        writes.push('restore');
        return Promise.resolve();
      },
      run: () => Promise.reject(new Error('worker down')),
    });
    expect(writes).toEqual([]);
    expect(attempt.changed).toBe(false);
    expect(attempt.value).toBeUndefined();
  });

  it('reports a failed restore after a successful print', async () => {
    let persisted = false;
    const attempt = await attemptWithPrinting({
      enabled: false,
      enableReason: 'on',
      restoreReason: 'off',
      enable: () => {
        persisted = true;
        return Promise.resolve();
      },
      readEnabled: () => Promise.resolve(persisted),
      restore: () => Promise.reject(new Error('restore failed')),
      run: () => Promise.resolve('printed'),
    });
    expect(attempt.value).toBe('printed');
    expect(attempt.error).toBeUndefined();
    expect(attempt.cleanupError).toBeInstanceOf(Error);
  });

  it('restores when enable rejects after the switch was committed', async () => {
    let persisted = false;
    const writes: string[] = [];
    const attempt = await attemptWithPrinting({
      enabled: false,
      enableReason: 'on',
      restoreReason: 'off',
      enable: (reason) => {
        persisted = true;
        writes.push(`enable ${reason}`);
        return Promise.reject(new Error('response lost'));
      },
      readEnabled: () => Promise.resolve(persisted),
      restore: (enabled, reason) => {
        persisted = enabled;
        writes.push(`restore ${String(enabled)} ${reason}`);
        return Promise.resolve();
      },
      run: () => {
        writes.push('run');
        return Promise.resolve('printed');
      },
    });
    expect(writes).toEqual(['enable on', 'restore false off']);
    expect(attempt.value).toBeUndefined();
    expect(attempt.error).toBeInstanceOf(Error);
    expect(attempt.cleanupError).toBeUndefined();
    expect(attempt.persisted).toBe(false);
    expect(attempt.changed).toBe(true);
  });
});
