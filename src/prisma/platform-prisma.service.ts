import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

/** The API pool uses at most 7 of the 50 connections of the shared Postgres (plan 2.1, RN-01.16). */
export const DB_POOL_MAX = 7;
const DB_CONNECTION_TIMEOUT_MS = 2_000;

export function createPgAdapter(databaseUrl: string): PrismaPg {
  return new PrismaPg({
    connectionString: databaseUrl,
    max: DB_POOL_MAX,
    connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
  });
}

/**
 * UNSCOPED Prisma client: no organization filter (spec 01, section 6).
 *
 * Restricted use, enforced by an ESLint rule (`no-restricted-imports`):
 * - the platform admin module (spec 02), which works across organizations;
 * - authentication (phase 1b), which looks subjects up before the organization is known;
 * - jobs and scripts that run outside a request.
 * Everything else uses {@link PrismaService}, which filters tenant tables by the organization of
 * the request context.
 *
 * It owns the only connection pool of the API: the tenant client is an extension of this client
 * and shares the pool, so the API never holds more than {@link DB_POOL_MAX} connections.
 * Connections are opened lazily, so the app (and `pnpm openapi`) boots without a database.
 */
@Injectable()
export class PlatformPrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_ENV) env: Env) {
    super({ adapter: createPgAdapter(env.DATABASE_URL) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
