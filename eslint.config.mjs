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
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: false,
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
);
