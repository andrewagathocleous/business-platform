import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['bp-source', 'module', 'node', 'development|production'],
  },
  test: {
    environment: 'node',
    include: ['scripts/**/*.test.ts'],
  },
});
