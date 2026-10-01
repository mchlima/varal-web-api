import 'reflect-metadata';

import type { ModuleMetadata } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { AuthGuard } from '../../src/auth/auth.guard.js';
import { StubAuthGuard } from './stub-auth.js';

export interface TestAppOptions {
  /** Test-only modules (controllers used to exercise the infrastructure). */
  imports?: ModuleMetadata['imports'];
  /** Defaults to an unreachable database (tests without Postgres). */
  databaseUrl?: string;
  nodeEnv?: 'development' | 'test' | 'production';
  /**
   * `stub` (default): `X-Test-*` headers authenticate (stub-auth.ts). `real`: the real `AuthGuard`,
   * with session cookies from the login routes.
   */
  auth?: 'stub' | 'real';
}

/** The real AppModule plus the given test-only modules, with the stub or the real authentication. */
export async function createTestApp(options: TestAppOptions = {}): Promise<NestExpressApplication> {
  vi.stubEnv('DATABASE_URL', options.databaseUrl ?? 'postgresql://varal:varal@127.0.0.1:1/unused');
  vi.stubEnv('CORS_ORIGINS', 'http://localhost:3100');
  vi.stubEnv('NODE_ENV', options.nodeEnv ?? 'test');
  if (options.nodeEnv === 'production') {
    // Required in production (src/config/env.ts); dummy values, nothing is sent in these tests.
    vi.stubEnv('AUTH_PANEL_JWT_SECRET', 'p'.repeat(32));
    vi.stubEnv('AUTH_ADMIN_JWT_SECRET', 'a'.repeat(32));
    vi.stubEnv('EMAIL_PAYLOAD_SECRET', 'e'.repeat(32));
    vi.stubEnv('SMTP_USER', 'varal');
    vi.stubEnv('SMTP_PASSWORD', 'unused');
    vi.stubEnv('PANEL_URL', 'https://varal.kratinho.com.br');
    vi.stubEnv('ADMIN_URL', 'https://admin-varal.kratinho.com.br');
  }
  let builder = Test.createTestingModule({ imports: [AppModule, ...(options.imports ?? [])] });
  if ((options.auth ?? 'stub') === 'stub') {
    builder = builder.overrideProvider(AuthGuard).useClass(StubAuthGuard);
  }
  const moduleRef = await builder.compile();
  const app = configureApp(
    moduleRef.createNestApplication<NestExpressApplication>({ logger: false }),
  );
  await app.init();
  return app;
}
