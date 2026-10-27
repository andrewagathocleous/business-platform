import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['bp-source', 'module', 'node', 'development|production'],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    reporters: ['verbose'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
