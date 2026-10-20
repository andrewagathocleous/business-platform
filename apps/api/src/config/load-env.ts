import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

/** Loads the repo-root `.env` without overriding variables already set in the process. */
export function loadRootEnv(): void {
  loadEnv({ path: resolve(__dirname, '../../../../.env') });
}
