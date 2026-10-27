import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['bp-source', 'module', 'node', 'development|production'],
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.mjs'],
    // The release and backup tests run real shell scripts, perl and age.
    testTimeout: 20_000,
  },
});
