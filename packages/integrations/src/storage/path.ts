import { isAbsolute } from 'node:path';

/** The key would leave the storage root, or it is not a relative object key. */
export class StoragePathError extends Error {
  override readonly name = 'StoragePathError';

  constructor(message = 'storage key escapes the root') {
    super(message);
  }
}

/**
 * Splits a relative key into segments.
 * Absolute paths, `..`, empty segments, backslashes and percent-encoding are refused
 * before the path is joined to the root. Percent-encoding covers encoded separators
 * (`%2F`, `%5C`) and encoded `..` (`%2e%2e`).
 */
export function safeSegments(key: string): string[] {
  if (key.length === 0 || key.length > 512) {
    throw new StoragePathError();
  }
  if (key.includes('\0') || key.includes('\\') || key.includes('%') || key.includes(':')) {
    throw new StoragePathError();
  }
  if (isAbsolute(key) || key.startsWith('/')) {
    throw new StoragePathError();
  }
  const segments = key.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..' || segment.includes('..')) {
      throw new StoragePathError();
    }
  }
  return segments;
}
