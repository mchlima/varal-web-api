import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { PgBossService } from '../jobs/pg-boss.service.js';
import { AnnouncementsService } from './announcements/announcements.service.js';
import { ImpersonationsService } from './impersonation/impersonations.service.js';

export const ADMIN_TASKS_QUEUE = 'admin.minutely';
/** Every minute: scheduled announcements and expired "entrar como". */
export const ADMIN_TASKS_CRON = '* * * * *';

export interface AdminTasksResult {
  announcementsPublished: number;
  impersonationsExpired: number;
}

/**
 * Time-based transitions of the admin (pg-boss cron, every minute):
 * - scheduled announcements whose date arrived become `published` (RN-02.15; owners already see
 *   them from `publish_at` on, so a late job never delays the banner, CA-02.06);
 * - "entrar como" past 60 minutes are marked `expired` (their sessions already stopped at
 *   `expires_at`, CA-02.08; this only records the end for the owner's list, RN-02.22).
 */
@Injectable()
export class AdminTasksJob implements OnModuleInit {
  private readonly logger = new Logger('AdminTasksJob');

  constructor(
    private readonly boss: PgBossService,
    private readonly announcements: AnnouncementsService,
    private readonly impersonations: ImpersonationsService,
  ) {}

  onModuleInit(): void {
    this.boss.register({
      name: ADMIN_TASKS_QUEUE,
      options: { retryLimit: 0, expireInSeconds: 50 },
      schedule: ADMIN_TASKS_CRON,
      work: (boss) =>
        boss.work(ADMIN_TASKS_QUEUE, async () => {
          const result = await this.run();
          if (result.announcementsPublished > 0 || result.impersonationsExpired > 0) {
            this.logger.log(`admin tasks: ${JSON.stringify(result)}`);
          }
          return result;
        }),
    });
  }

  async run(now = new Date()): Promise<AdminTasksResult> {
    return {
      announcementsPublished: await this.announcements.publishDue(now),
      impersonationsExpired: await this.impersonations.endExpired(now),
    };
  }
}
