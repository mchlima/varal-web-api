import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC keeps decorator metadata, which Nest dependency injection needs (esbuild drops it).
const plugins = [swc.vite({ module: { type: 'es6' } })];

export default defineConfig({
  plugins,
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.e2e-spec.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.int-spec.ts'],
          // Recreates the worktree test database (RN-01.06); skipped when no database is reachable.
          globalSetup: ['test/integration/global-setup.ts'],
          // One worker: integration tests share a single test database and a small pool.
          maxWorkers: 1,
          fileParallelism: false,
        },
      },
    ],
  },
});
