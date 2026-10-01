import { Module } from '@nestjs/common';

import { PlatformAdminsService } from '../admin/platform-admins.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { PasswordLinkService } from '../auth/password-link.service.js';
import { PasswordTokenService } from '../auth/password-token.service.js';
import { ConfigModule } from '../config/config.module.js';
import { EmailService } from '../email/email.service.js';
import { MailerService } from '../email/mailer.service.js';
import { PG_BOSS_WORKERS, PgBossService } from '../jobs/pg-boss.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';

/**
 * Lean application context of the command line tools (no HTTP, no WebSocket, no cron). pg-boss runs
 * producer-only ({@link PG_BOSS_WORKERS} `false`): jobs enqueued here, such as e-mails, are processed
 * by the workers of the running API.
 */
@Module({
  imports: [ConfigModule, PrismaModule, AuditModule],
  providers: [
    { provide: PG_BOSS_WORKERS, useValue: false },
    PgBossService,
    MailerService,
    EmailService,
    PasswordTokenService,
    PasswordLinkService,
    PlatformAdminsService,
  ],
})
export class CliModule {}
