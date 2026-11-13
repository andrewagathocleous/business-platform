import { StoragePathError } from '@bp/integrations';
import { CommerceError } from '../commerce/errors';
import type { FileIntegrityError } from './verified-file';

/** Audited as `file.integrity_failed`; no byte of the file is sent. */
export function integrityFailed(fileId: string, error: FileIntegrityError): CommerceError {
  return new CommerceError(
    409,
    'file_integrity_failed',
    'stored_file',
    fileId,
    'The stored file failed its integrity check and was not sent.',
    'file.integrity_failed',
    { integrity: error.reason },
  );
}

/** The object is not in storage (or its path is not allowed). */
export function isStorageMiss(error: unknown): boolean {
  if (error instanceof StoragePathError) {
    return true;
  }
  return isFsCode(error, 'ENOENT') || isFsCode(error, 'ELOOP') || isFsCode(error, 'ENOTDIR');
}

function isFsCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
