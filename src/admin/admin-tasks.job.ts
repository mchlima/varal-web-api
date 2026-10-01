import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { PgBossService } from '../jobs/pg-boss.service.js';
import { AnnouncementsService } from './announcements/announcements.service.js';

export const ADMIN_TASKS_QUEUE = 'admin.minutely';
/** Every minute: scheduled announcements. */
export const ADMIN_TASKS_CRON = '* * * * *';

export interface AdminTasksResult {
  announcementsPublished: number;
}

/**
 * Time-based transitions of the admin (pg-boss cron, every minute): scheduled announcements whose
 * date arrived become `published` (RN-02.15; owners already see them from `publish_at` on, so a
 * late job never delays the banner, CA-02.06). The "entrar como" has no deadline (RN-02.17): it is
 * never ended by this job, only by the admin.
 */
@Injectable()
export class AdminTasksJob implements OnModuleInit {
  private readonly logger = new Logger('AdminTasksJob');

  constructor(
    private readonly boss: PgBossService,
    private readonly announcements: AnnouncementsService,
  ) {}

  onModuleInit(): void {
    this.boss.register({
      name: ADMIN_TASKS_QUEUE,
      options: { retryLimit: 0, expireInSeconds: 50 },
      schedule: ADMIN_TASKS_CRON,
      work: (boss) =>
        boss.work(ADMIN_TASKS_QUEUE, async () => {
          const result = await this.run();
          if (result.announcementsPublished > 0) {
            this.logger.log(`admin tasks: ${JSON.stringify(result)}`);
          }
          return result;
        }),
    });
  }

  async run(now = new Date()): Promise<AdminTasksResult> {
    return {
      announcementsPublished: await this.announcements.publishDue(now),
    };
  }
}
