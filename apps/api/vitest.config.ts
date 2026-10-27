import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));
const dbSource = resolve(root, '../../packages/db/src/index.ts');
const domainSource = resolve(root, '../../packages/domain/src/index.ts');
const documentsSource = resolve(root, '../../packages/documents/src/index.ts');
const integrationsSource = resolve(root, '../../packages/integrations/src/index.ts');

export default defineConfig({
  resolve: {
    alias: {
      '@bp/db': dbSource,
      '@bp/domain': domainSource,
      '@bp/documents': documentsSource,
      '@bp/integrations': integrationsSource,
    },
    conditions: ['bp-source', 'module', 'node', 'development|production'],
  },
  // Workspace packages are externalised in Vite 8 and Node then loads dist/.
  // Documents must be transformed from source so unit tests do not depend on a build.
  ssr: {
    noExternal: ['@bp/db', '@bp/domain', '@bp/documents', '@bp/integrations'],
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
  },
});
