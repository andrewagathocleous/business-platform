import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { StorageAdapter } from '@bp/integrations';
import { describe, expect, it } from 'vitest';
import { FileIntegrityError, MAX_VERIFIED_FILE_BYTES, readVerifiedFile } from './verified-file';

const BYTES = Buffer.from('%PDF-1.7 fictional test document');

function storageOf(...chunks: Buffer[]): StorageAdapter {
  return {
    put: () => Promise.resolve(),
    get: () => Promise.resolve(Readable.from(chunks)),
    exists: () => Promise.resolve(true),
  };
}

function row(bytes: Buffer) {
  return {
    storageKey: 'companies/c/test/file.pdf',
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

describe('readVerifiedFile', () => {
  it('returns the bytes when size and SHA-256 match', async () => {
    await expect(readVerifiedFile(storageOf(BYTES), row(BYTES))).resolves.toEqual(BYTES);
  });

  it('refuses changed bytes of the same length', async () => {
    const tampered = Buffer.from(BYTES);
    tampered[0] = 0x25 ^ 0x01;
    await expect(readVerifiedFile(storageOf(tampered), row(BYTES))).rejects.toEqual(
      new FileIntegrityError('hash_mismatch'),
    );
  });

  it('refuses a different length before hashing', async () => {
    await expect(readVerifiedFile(storageOf(BYTES, Buffer.from('x')), row(BYTES))).rejects.toEqual(
      new FileIntegrityError('size_mismatch'),
    );
  });

  it('stops reading past 20 MB', async () => {
    const big = Buffer.alloc(MAX_VERIFIED_FILE_BYTES / 2 + 1);
    await expect(readVerifiedFile(storageOf(big, big), row(big))).rejects.toEqual(
      new FileIntegrityError('too_large'),
    );
  });

  it('refuses a malformed stored hash instead of passing it', async () => {
    await expect(
      readVerifiedFile(storageOf(BYTES), { ...row(BYTES), sha256: 'not-hex' }),
    ).rejects.toEqual(new FileIntegrityError('hash_mismatch'));
  });
});
