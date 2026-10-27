import { constants, createReadStream, type PathLike } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { StorageAdapter } from './adapter';
import { safeSegments, StoragePathError } from './path';

/**
 * Runs after the parent directory has been created and checked, and before
 * `open`. Tests use it to swap that directory for a symlink.
 */
export type LocalFsStorageHooks = {
  beforeOpen?: (parent: string) => Promise<void>;
  /** Runs after a read `open` and before the descriptor is checked. Tests inject a verification error here. */
  beforeVerify?: (handle: FileHandle) => Promise<void>;
};

/**
 * Files live under one root. `put` creates the parent, checks its real path,
 * then opens the file with `O_EXCL | O_NOFOLLOW` and checks the descriptor
 * against `lstat` before writing. `get` and `exists` open with `O_NOFOLLOW`
 * and stream from that descriptor. A verification error, and a stream error,
 * close the descriptor before the error propagates.
 *
 * An attacker who can already create entries inside the root is out of scope.
 * The root must be owned by the app user and mode 0700. Node has no `openat`,
 * so a parent swapped for a symlink in the gap before `open` is caught by the
 * descriptor check, not prevented.
 */
export class LocalFsStorage implements StorageAdapter {
  constructor(
    private readonly root: string,
    private readonly hooks: LocalFsStorageHooks = {},
  ) {}

  async put(key: string, body: Buffer): Promise<void> {
    const segments = safeSegments(key);
    const name = segments[segments.length - 1];
    if (name === undefined) {
      throw new StoragePathError();
    }
    const rootReal = await this.ensureRoot();
    const parent = await this.prepareParent(rootReal, segments.slice(0, -1));
    await this.hooks.beforeOpen?.(parent);
    const path = join(parent, name);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag();
    let handle: FileHandle;
    try {
      handle = await open(path, flags, 0o600);
    } catch (error) {
      if (isRefusedOpen(error) || isCode(error, 'EEXIST')) {
        throw new StoragePathError();
      }
      throw error;
    }
    let discard = true;
    try {
      if (!(await this.sameConfinedFile(handle, path, rootReal))) {
        throw new StoragePathError();
      }
      await handle.writeFile(body);
      discard = false;
    } catch (error) {
      if (discard) {
        await this.discardCreated(handle, path);
      }
      if (error instanceof StoragePathError) {
        throw error;
      }
      throw error;
    } finally {
      if (!discard) {
        await handle.close();
      }
    }
  }

  async get(key: string): Promise<Readable> {
    const opened = await this.openConfined(key);
    if (opened === null) {
      throw new StoragePathError('storage object was not found');
    }
    return streamFromHandle(opened);
  }

  async exists(key: string): Promise<boolean> {
    const opened = await this.openConfined(key);
    if (opened === null) {
      return false;
    }
    await opened.close();
    return true;
  }

  private async openConfined(key: string): Promise<FileHandle | null> {
    const segments = safeSegments(key);
    const rootReal = await this.existingRoot();
    if (rootReal === null) {
      return null;
    }
    const path = join(rootReal, ...segments);
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | noFollowFlag());
    } catch (error) {
      if (isCode(error, 'ENOENT')) {
        return null;
      }
      if (isRefusedOpen(error)) {
        throw new StoragePathError();
      }
      throw error;
    }
    try {
      await this.hooks.beforeVerify?.(handle);
      if (!(await this.sameConfinedFile(handle, path, rootReal))) {
        throw new StoragePathError();
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    return handle;
  }

  private async prepareParent(rootReal: string, segments: string[]): Promise<string> {
    let current = rootReal;
    for (const segment of segments) {
      const next = join(current, segment);
      await this.mkdirConfined(next);
      current = await this.confinedDirectory(rootReal, next);
    }
    return current;
  }

  /**
   * `EEXIST` is success only when the caller then proves the entry is a real
   * directory still inside the root. Segment creates are not recursive, so a
   * symlink is not followed to make a directory outside the root.
   */
  private async mkdirConfined(path: string, recursive = false): Promise<void> {
    try {
      await mkdir(path, { recursive, mode: 0o700 });
    } catch (error) {
      if (!isCode(error, 'EEXIST')) {
        if (isRefusedOpen(error)) {
          throw new StoragePathError();
        }
        throw error;
      }
    }
  }

  private async confinedDirectory(rootReal: string, path: string): Promise<string> {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isRefusedOpen(error) || isCode(error, 'ENOENT')) {
        throw new StoragePathError();
      }
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new StoragePathError();
    }
    let real: string;
    try {
      real = await realpath(path);
    } catch (error) {
      if (isRefusedOpen(error) || isCode(error, 'ENOENT')) {
        throw new StoragePathError();
      }
      throw error;
    }
    if (!isConfined(rootReal, real, true)) {
      throw new StoragePathError();
    }
    return real;
  }

  private async sameConfinedFile(
    handle: FileHandle,
    path: string,
    rootReal: string,
  ): Promise<boolean> {
    try {
      const opened = await handle.stat();
      const linked = await lstat(path);
      if (!linked.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino) {
        return false;
      }
      const parentReal = await realpath(dirname(path));
      return isConfined(rootReal, parentReal, true);
    } catch (error) {
      if (isRefusedOpen(error) || isCode(error, 'ENOENT')) {
        return false;
      }
      throw error;
    }
  }

  private async discardCreated(handle: FileHandle, path: string): Promise<void> {
    let opened: { dev: number; ino: number } | null = null;
    try {
      const stat = await handle.stat();
      opened = { dev: stat.dev, ino: stat.ino };
    } catch {
      opened = null;
    }
    await handle.close().catch(() => undefined);
    if (opened === null) {
      return;
    }
    try {
      const linked = await lstat(path);
      if (linked.isFile() && linked.dev === opened.dev && linked.ino === opened.ino) {
        await unlink(path);
      }
    } catch {
      // The path no longer names the file this descriptor created.
    }
  }

  private async ensureRoot(): Promise<string> {
    const existing = await this.existingRoot();
    if (existing !== null) {
      return existing;
    }
    await this.mkdirConfined(this.root, true);
    const real = await realpath(this.root);
    await this.confinedDirectory(real, this.root);
    return real;
  }

  private async existingRoot(): Promise<string | null> {
    try {
      const real = await realpath(this.root);
      const info = await lstat(this.root);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new StoragePathError();
      }
      return real;
    } catch (error) {
      if (error instanceof StoragePathError) {
        throw error;
      }
      if (isCode(error, 'ENOENT')) {
        return null;
      }
      if (isRefusedOpen(error)) {
        throw new StoragePathError();
      }
      throw error;
    }
  }
}

function streamFromHandle(handle: FileHandle): Readable {
  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    void handle.close().catch(() => undefined);
  };
  const stream = createReadStream(null as unknown as PathLike, { fd: handle, autoClose: false });
  stream.on('end', close);
  stream.on('error', close);
  stream.on('close', close);
  return stream;
}

function isConfined(root: string, target: string, allowRoot: boolean): boolean {
  const rel = relative(root, target);
  if (rel === '') {
    return allowRoot;
  }
  if (isAbsolute(rel)) {
    return false;
  }
  return !rel.split(sep).includes('..');
}

function noFollowFlag(): number {
  const flag = constants.O_NOFOLLOW;
  return typeof flag === 'number' ? flag : 0;
}

function isRefusedOpen(error: unknown): boolean {
  return isCode(error, 'ELOOP') || isCode(error, 'ENOTDIR');
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
