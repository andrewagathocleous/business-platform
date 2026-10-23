import eslint from '@eslint/js';
import nxPlugin from '@nx/eslint-plugin';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/generated/**',
      '**/.nx/**',
      '**/coverage/**',
      'node_modules/**',
      'pnpm-lock.yaml',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  prettier,
  {
    plugins: {
      '@nx': nxPlugin,
    },
    rules: {
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: false,
          allow: ['^.*/tools/test-db-guard\\.mjs$'],
          depConstraints: [
            {
              sourceTag: 'type:domain',
              onlyDependOnLibsWithTags: [],
              bannedExternalImports: ['@nestjs/*', '@prisma/*', 'prisma'],
            },
            {
              sourceTag: 'type:data',
              onlyDependOnLibsWithTags: ['type:domain'],
            },
            {
              sourceTag: 'type:infra',
              onlyDependOnLibsWithTags: ['type:domain'],
            },
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: ['type:domain', 'type:data', 'type:infra'],
            },
            {
              sourceTag: 'web',
              onlyDependOnLibsWithTags: ['type:domain'],
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*', '@prisma/*', 'prisma', '@bp/db', '@bp/documents', '@bp/integrations'],
              message: 'packages/domain depends only on decimal.js and zod',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/integrations/src/**/*.ts'],
    ignores: ['packages/integrations/src/http/**', 'packages/integrations/src/**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'use createSafeFetch from http/safe-fetch',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'globalThis',
          property: 'fetch',
          message: 'use createSafeFetch from http/safe-fetch',
        },
        {
          object: 'global',
          property: 'fetch',
          message: 'use createSafeFetch from http/safe-fetch',
        },
        {
          object: 'self',
          property: 'fetch',
          message: 'use createSafeFetch from http/safe-fetch',
        },
        {
          object: 'window',
          property: 'fetch',
          message: 'use createSafeFetch from http/safe-fetch',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:http',
              message: 'use createSafeFetch from http/safe-fetch',
            },
            {
              name: 'node:https',
              message: 'use createSafeFetch from http/safe-fetch',
            },
            {
              name: 'http',
              message: 'use createSafeFetch from http/safe-fetch',
            },
            {
              name: 'https',
              message: 'use createSafeFetch from http/safe-fetch',
            },
            {
              name: 'undici',
              message: 'use createSafeFetch from http/safe-fetch',
            },
          ],
        },
      ],
    },
  },
);
