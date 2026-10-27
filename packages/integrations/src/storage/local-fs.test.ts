import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFsStorage } from './local-fs';
import { storageKey } from './keys';
import { StoragePathError } from './path';

const roots: string[] = [];

function watchClose(handle: FileHandle): { wasClosed: () => boolean } {
  let called = false;
  const original = handle.close.bind(handle);
  handle.close = () => {
    called = true;
    return original();
  };
  return { wasClosed: () => called };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LocalFsStorage', () => {
  it('round-trips a server-generated key under the root', async () => {
    const root = await makeRoot();
    const storage = new LocalFsStorage(root);
    const key = storageKey({
      companyId: '01932a1e-7b4c-7c2a-8e10-111111111111',
      kind: 'packing_slip',
      id: '01932a1e-7b4c-7c2a-8e10-222222222222',
      at: new Date('2026-03-01T00:00:00.000Z'),
    });
    expect(key).toBe(
      'companies/01932a1e-7b4c-7c2a-8e10-111111111111/packing_slip/2026/03/01932a1e-7b4c-7c2a-8e10-222222222222.pdf',
    );
    const body = Buffer.from('%PDF-1.4 demo');
    expect(await storage.exists(key)).toBe(false);
    await storage.put(key, body);
    expect(await storage.exists(key)).toBe(true);
    expect(await readAll(await storage.get(key))).toEqual(body);
  });

  it('throws on traversal, absolute keys and encoded separators', async () => {
    const root = await makeRoot();
    const storage = new LocalFsStorage(root);
    const attacks = [
      '..',
      '../secret.pdf',
      'companies/../../etc/passwd',
      '/etc/passwd',
      'foo/../../outside.pdf',
      'foo%2F..%2F..%2Fetc%2Fpasswd',
      '%2e%2e/%2e%2e/secret.pdf',
      '%2E%2E%2F%2E%2E%2Fsecret.pdf',
      '..%5C..%5Csecret.pdf',
      'companies%2F..%2Fsecret.pdf',
      'C:/Windows/system32/config',
    ];
    for (const key of attacks) {
      await expect(storage.put(key, Buffer.from('no'))).rejects.toBeInstanceOf(StoragePathError);
      await expect(storage.get(key)).rejects.toBeInstanceOf(StoragePathError);
      await expect(storage.exists(key)).rejects.toBeInstanceOf(StoragePathError);
    }
    expect(await storage.exists('companies/missing.pdf')).toBe(false);
  });

  it('throws when a symlink inside the root points outside it', async () => {
    const root = await makeRoot();
    const outside = await mkdtemp(join(tmpdir(), 'bp-storage-out-'));
    roots.push(outside);
    await writeFile(join(outside, 'secret.pdf'), 'hidden');
    await symlink(outside, join(root, 'link'));
    const storage = new LocalFsStorage(root);
    await expect(storage.put('link/escape.pdf', Buffer.from('pwn'))).rejects.toBeInstanceOf(
      StoragePathError,
    );
    await expect(storage.get('link/secret.pdf')).rejects.toBeInstanceOf(StoragePathError);
    await expect(storage.exists('link/secret.pdf')).rejects.toBeInstanceOf(StoragePathError);
    await expect(storage.get('link')).rejects.toBeInstanceOf(StoragePathError);
  });

  it('refuses a final-component symlink on get', async () => {
    const root = await makeRoot();
    const storage = new LocalFsStorage(root);
    const at = new Date('2026-03-01T00:00:00.000Z');
    const key = storageKey({
      companyId: '01932a1e-7b4c-7c2a-8e10-111111111111',
      kind: 'packing_slip',
      id: '01932a1e-7b4c-7c2a-8e10-333333333333',
      at,
    });
    const other = storageKey({
      companyId: '01932a1e-7b4c-7c2a-8e10-111111111111',
      kind: 'packing_slip',
      id: '01932a1e-7b4c-7c2a-8e10-333333333334',
      at,
    });
    await storage.put(key, Buffer.from('inside'));
    await storage.put(other, Buffer.from('other-bytes'));
    await rm(join(root, key));
    await symlink(join(root, other), join(root, key));
    await expect(storage.get(key)).rejects.toBeInstanceOf(StoragePathError);
    await expect(storage.exists(key)).rejects.toBeInstanceOf(StoragePathError);
  });

  it('refuses to put a key that already exists', async () => {
    const root = await makeRoot();
    const storage = new LocalFsStorage(root);
    const key = storageKey({
      companyId: '01932a1e-7b4c-7c2a-8e10-111111111111',
      kind: 'packing_slip',
      id: '01932a1e-7b4c-7c2a-8e10-444444444444',
      at: new Date('2026-03-01T00:00:00.000Z'),
    });
    await storage.put(key, Buffer.from('first'));
    await expect(storage.put(key, Buffer.from('second'))).rejects.toBeInstanceOf(StoragePathError);
    expect(await readAll(await storage.get(key))).toEqual(Buffer.from('first'));
  });

  it('detects a parent directory replaced by a symlink before open', async () => {
    const root = await makeRoot();
    const outside = await mkdtemp(join(tmpdir(), 'bp-storage-swap-'));
    roots.push(outside);
    const storage = new LocalFsStorage(root, {
      beforeOpen: async (parent) => {
        await rm(parent, { recursive: true });
        await symlink(outside, parent);
      },
    });
    await expect(
      storage.put('companies/01932a1e-7b4c-7c2a-8e10-555555555555/escape.pdf', Buffer.from('pwn')),
    ).rejects.toBeInstanceOf(StoragePathError);
    expect(await readdir(outside)).not.toContain('escape.pdf');
  });

  it('closes the handle when read verification throws', async () => {
    const root = await makeRoot();
    const storage = new LocalFsStorage(root);
    const key = storageKey({
      companyId: '01932a1e-7b4c-7c2a-8e10-111111111111',
      kind: 'packing_slip',
      id: '01932a1e-7b4c-7c2a-8e10-777777777777',
      at: new Date('2026-05-01T00:00:00.000Z'),
    });
    await storage.put(key, Buffer.from('kept'));
    let close: { wasClosed: () => boolean } | undefined;
    const failing = new LocalFsStorage(root, {
      beforeVerify: (handle) => {
        close = watchClose(handle);
        return Promise.reject(
          Object.assign(new Error('injected verification failure'), { code: 'EIO' }),
        );
      },
    });
    await expect(failing.get(key)).rejects.toThrow(/injected verification failure/);
    expect(close?.wasClosed()).toBe(true);
    expect(await readAll(await storage.get(key))).toEqual(Buffer.from('kept'));
  });

  it('closes the handle when the read stream errors', async () => {
    const root = await makeRoot();
    const storage = new LocalFsStorage(root);
    const key = storageKey({
      companyId: '01932a1e-7b4c-7c2a-8e10-111111111111',
      kind: 'packing_slip',
      id: '01932a1e-7b4c-7c2a-8e10-888888888888',
      at: new Date('2026-05-02T00:00:00.000Z'),
    });
    await storage.put(key, Buffer.from('streamed'));
    let close: { wasClosed: () => boolean } | undefined;
    const watched = new LocalFsStorage(root, {
      beforeVerify: (handle) => {
        close = watchClose(handle);
        return Promise.resolve();
      },
    });
    const stream = await watched.get(key);
    stream.destroy(new Error('boom'));
    await new Promise<void>((resolve) => {
      stream.on('close', () => {
        resolve();
      });
    });
    expect(close?.wasClosed()).toBe(true);
  });

  it('lets concurrent puts create the same company directory', async () => {
    const root = await makeRoot();
    const storage = new LocalFsStorage(root);
    const companyId = '01932a1e-7b4c-7c2a-8e10-666666666666';
    const at = new Date('2026-04-01T00:00:00.000Z');
    const keys = Array.from({ length: 20 }, (_, index) =>
      storageKey({
        companyId,
        kind: 'packing_slip',
        id: `01932a1e-7b4c-7c2a-8e10-${index.toString(16).padStart(12, '0')}`,
        at,
      }),
    );
    const bodies = keys.map((_, index) => Buffer.from(`body-${String(index)}`));
    await Promise.all(keys.map((key, index) => storage.put(key, bodies[index] ?? Buffer.alloc(0))));
    for (const [index, key] of keys.entries()) {
      expect(await readAll(await storage.get(key))).toEqual(bodies[index]);
    }
  });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bp-storage-'));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
