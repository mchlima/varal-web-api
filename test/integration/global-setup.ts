import { execFileSync } from 'node:child_process';

import pg from 'pg';
import type { TestProject } from 'vitest/node';

import { loadEnvFiles } from '../../src/config/load-env.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string | null;
  }
}

/**
 * Recreates the worktree test database (`varal_<slug>_test`, RN-01.06) and applies the migrations.
 * Without DATABASE_URL_TEST, or with the server unreachable, integration tests are skipped.
 */
export default async function setup(project: TestProject): Promise<void> {
  loadEnvFiles();
  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    console.warn('[integration] DATABASE_URL_TEST not set: integration tests skipped.');
    project.provide('databaseUrl', null);
    return;
  }

  const database = new URL(url).pathname.slice(1);
  // Never drop anything that is not a test database.
  if (!/^[a-z0-9_]+_test$/.test(database)) {
    throw new Error(
      `DATABASE_URL_TEST must point to a database ending in _test (got "${database}")`,
    );
  }

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({
    connectionString: adminUrl.toString(),
    connectionTimeoutMillis: 2_000,
  });
  try {
    await admin.connect();
  } catch (error) {
    console.warn(
      `[integration] database server unreachable (${error instanceof Error ? error.message : String(error)}): integration tests skipped.`,
    );
    project.provide('databaseUrl', null);
    return;
  }
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    stdio: 'inherit',
  });
  project.provide('databaseUrl', url);
}
