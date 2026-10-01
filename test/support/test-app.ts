import 'reflect-metadata';

import type { ModuleMetadata } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { StubAuthModule } from './stub-auth.js';

export interface TestAppOptions {
  /** Test-only modules (controllers used to exercise the infrastructure). */
  imports?: ModuleMetadata['imports'];
  /** Defaults to an unreachable database (tests without Postgres). */
  databaseUrl?: string;
  nodeEnv?: 'development' | 'test' | 'production';
}

/** The real AppModule plus the test-only stub authentication and the given modules. */
export async function createTestApp(options: TestAppOptions = {}): Promise<NestExpressApplication> {
  vi.stubEnv('DATABASE_URL', options.databaseUrl ?? 'postgresql://varal:varal@127.0.0.1:1/unused');
  vi.stubEnv('CORS_ORIGINS', 'http://localhost:3100');
  vi.stubEnv('NODE_ENV', options.nodeEnv ?? 'test');
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, StubAuthModule, ...(options.imports ?? [])],
  }).compile();
  const app = configureApp(
    moduleRef.createNestApplication<NestExpressApplication>({ logger: false }),
  );
  await app.init();
  return app;
}
