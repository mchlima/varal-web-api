// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['dist/', 'coverage/', 'src/generated/', 'node_modules/', '.worktrees/'],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // Nest modules are classes with decorators only.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Spec 01, section 6: the unscoped client (no organization filter) is restricted to the platform
    // admin module, authentication and jobs. Everything else uses the tenant-scoped PrismaService.
    files: ['src/**/*.ts'],
    ignores: ['src/prisma/**', 'src/admin/**', 'src/auth/**', 'src/jobs/**', 'src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/platform-prisma.service.js'],
              message:
                'PlatformPrismaService has no organization filter: only admin, auth and jobs may use it (spec 01, section 6). Use PrismaService.',
            },
            {
              group: ['**/generated/prisma/client.js'],
              importNames: ['PrismaClient'],
              message:
                'Do not create Prisma clients: inject PrismaService (one pool of 7 connections).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
