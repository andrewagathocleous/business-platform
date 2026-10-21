import type { Readable } from 'node:stream';

/**
 * Private document bytes. Callers pass server-generated keys.
 * An implementation must refuse any key that would leave its root.
 */
export interface StorageAdapter {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
}
