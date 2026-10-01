import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

/** The API pool uses at most 7 of the 50 connections of the shared Postgres (plan 2.1, RN-01.16). */
export const DB_POOL_MAX = 7;
const DB_CONNECTION_TIMEOUT_MS = 2_000;

/**
 * Prisma client backed by the `pg` driver adapter. Connections are opened lazily,
 * so the app (and `pnpm openapi`) boots without a reachable database.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_ENV) env: Env) {
    super({
      adapter: new PrismaPg({
        connectionString: env.DATABASE_URL,
        max: DB_POOL_MAX,
        connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
      }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
