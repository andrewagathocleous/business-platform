import { createHash, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { StorageAdapter } from '@bp/integrations';

/** No stored document is larger than this. A bigger object is treated as tampered. */
export const MAX_VERIFIED_FILE_BYTES = 20 * 1024 * 1024;

export type VerifiableFile = {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
};

export type IntegrityFailure = 'too_large' | 'size_mismatch' | 'hash_mismatch';

/** The stored bytes do not match the row. Nothing was sent. Audit it as `file.integrity_failed`. */
export class FileIntegrityError extends Error {
  override readonly name = 'FileIntegrityError';

  constructor(readonly reason: IntegrityFailure) {
    super(`stored file failed its integrity check: ${reason}`);
  }
}

/**
 * The one way to read a stored document for a download, a PDF, a print or an export.
 * It reads the whole object, at most 20 MB, and checks its size and SHA-256 against the
 * `stored_file` row before returning anything, so no caller can send unverified bytes.
 * A missing object still throws the adapter's error (`StoragePathError` or an fs miss).
 */
export async function readVerifiedFile(
  storage: StorageAdapter,
  file: VerifiableFile,
): Promise<Buffer> {
  const bytes = await readBounded(await storage.get(file.storageKey));
  if (bytes.length !== file.sizeBytes) {
    throw new FileIntegrityError('size_mismatch');
  }
  const actual = createHash('sha256').update(bytes).digest();
  const expected = Buffer.from(file.sha256, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
    throw new FileIntegrityError('hash_mismatch');
  }
  return bytes;
}

async function readBounded(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buffer = toBuffer(chunk);
      total += buffer.length;
      if (total > MAX_VERIFIED_FILE_BYTES) {
        throw new FileIntegrityError('too_large');
      }
      chunks.push(buffer);
    }
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return Buffer.concat(chunks);
}

function toBuffer(chunk: unknown): Buffer {
  if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  throw new Error('storage returned an unexpected chunk');
}
