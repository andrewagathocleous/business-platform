import { describe, expect, it, vi } from 'vitest';
import {
  readPendingPrint,
  removePendingPrintIfKey,
  writePendingPrint,
  type PendingPrint,
} from './pending-print';

const saved: PendingPrint = { body: { requestKey: 'k1', documentType: 'invoice' }, lost: false };

describe('pending print storage', () => {
  it('does not overwrite a note that cannot be read or parsed', () => {
    const storage = memoryStorage('{');
    expect(readPendingPrint(() => storage, 'k').kind).toBe('unreadable');
    expect(writePendingPrint(() => storage, 'k', saved)).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value).toBe('{');
    removePendingPrintIfKey(() => storage, 'k', 'k1');
    expect(storage.removeItem).not.toHaveBeenCalled();

    storage.getItem.mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(readPendingPrint(() => storage, 'k').kind).toBe('unreadable');
    expect(writePendingPrint(() => storage, 'k', saved)).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value).toBe('{');
  });

  it('catches a storage object that cannot be opened', () => {
    const open = (): Storage => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    expect(readPendingPrint(open, 'k').kind).toBe('unreadable');
    expect(writePendingPrint(open, 'k', saved)).toBe(false);
    expect(() => {
      removePendingPrintIfKey(open, 'k', 'k1');
    }).not.toThrow();
  });

  it('reads a saved request as lost and still writes when nothing is saved', () => {
    const storage = memoryStorage(null);
    expect(readPendingPrint(() => storage, 'k')).toEqual({ kind: 'none' });
    expect(writePendingPrint(() => storage, 'k', saved)).toBe(true);
    expect(storage.value).toBe(JSON.stringify(saved));
    const read = readPendingPrint(() => storage, 'k');
    expect(read).toEqual({
      kind: 'pending',
      pending: { body: saved.body, lost: true },
    });

    storage.value = '';
    expect(readPendingPrint(() => storage, 'k')).toEqual({ kind: 'none' });
    storage.value = JSON.stringify({ other: 1 });
    expect(readPendingPrint(() => storage, 'k')).toEqual({ kind: 'none' });
  });
});

function memoryStorage(initial: string | null) {
  const state = { value: initial };
  return {
    get value() {
      return state.value;
    },
    set value(next: string | null) {
      state.value = next;
    },
    getItem: vi.fn(() => state.value),
    setItem: vi.fn((_key: string, next: string) => {
      state.value = next;
    }),
    removeItem: vi.fn(() => {
      state.value = null;
    }),
  };
}
