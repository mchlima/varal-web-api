import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { PlatformPrismaService } from '../prisma/platform-prisma.service.js';
import { PgBossService } from './pg-boss.service.js';

export const MAINTENANCE_QUEUE = 'maintenance.cleanup';
/** Every day at 04:00 in São Paulo, outside the hours of the stalls. */
export const MAINTENANCE_CRON = '0 4 * * *';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Ended sessions stay listed for 30 days before being removed. */
const SESSION_HISTORY_MS = 30 * DAY_MS;

export interface CleanupResult {
  idempotencyKeys: number;
  sessions: number;
  passwordTokens: number;
  loginThrottles: number;
}

/**
 * Daily cleanup (pg-boss cron): expired idempotency keys (spec 01, section 5), old sessions, used or
 * expired password tokens and stale login counters.
 */
@Injectable()
export class MaintenanceJob implements OnModuleInit {
  private readonly logger = new Logger('MaintenanceJob');

  constructor(
    private readonly boss: PgBossService,
    private readonly platform: PlatformPrismaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.boss.register({
      name: MAINTENANCE_QUEUE,
      options: { retryLimit: 2, retryDelay: 300, expireInSeconds: 600 },
      schedule: MAINTENANCE_CRON,
      work: (boss) =>
        boss.work(MAINTENANCE_QUEUE, async () => {
          const result = await this.runCleanup();
          this.logger.log(`cleanup done: ${JSON.stringify(result)}`);
          return result;
        }),
    });
  }

  async runCleanup(now = new Date()): Promise<CleanupResult> {
    const idempotencyKeys = await this.idempotency.purgeExpired(now);
    const historyLimit = new Date(now.getTime() - SESSION_HISTORY_MS);
    const sessions = await this.platform.session.deleteMany({
      where: { OR: [{ expiresAt: { lt: historyLimit } }, { revokedAt: { lt: historyLimit } }] },
    });
    // Kept for a day after creation: RN-01.02 counts the reset links of the last hour.
    const passwordTokens = await this.platform.passwordToken.deleteMany({
      where: {
        createdAt: { lt: new Date(now.getTime() - DAY_MS) },
        OR: [{ usedAt: { not: null } }, { expiresAt: { lt: now } }],
      },
    });
    const loginThrottles = await this.platform.loginThrottle.deleteMany({
      where: {
        lastFailedAt: { lt: new Date(now.getTime() - DAY_MS) },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
    });
    return {
      idempotencyKeys,
      sessions: sessions.count,
      passwordTokens: passwordTokens.count,
      loginThrottles: loginThrottles.count,
    };
  }
}
