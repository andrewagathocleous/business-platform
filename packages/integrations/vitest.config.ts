import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@bp/domain': resolve(root, '../domain/src/index.ts'),
    },
    conditions: ['bp-source', 'module', 'node', 'development|production'],
  },
  ssr: {
    noExternal: ['@bp/domain'],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
