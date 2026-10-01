import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { AdminModule } from './admin/admin.module.js';
import { AnnouncementsModule } from './announcements/announcements.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ConfigModule } from './config/config.module.js';
import { RequestContextModule } from './context/context.module.js';
import { AllExceptionsFilter } from './errors/all-exceptions.filter.js';
import { EmailModule } from './email/email.module.js';
import { HealthModule } from './health/health.module.js';
import { IdempotencyModule } from './idempotency/idempotency.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { MenuModule } from './menu/menu.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { StaffModule } from './staff/staff.module.js';
import { SupportAccessModule } from './support-access/support-access.module.js';
import { UnitsModule } from './units/units.module.js';

@Module({
  imports: [
    ConfigModule,
    RequestContextModule,
    PrismaModule,
    AuditModule,
    IdempotencyModule,
    JobsModule,
    EmailModule,
    AuthModule,
    AdminModule,
    AnnouncementsModule,
    SupportAccessModule,
    RealtimeModule,
    UnitsModule,
    MenuModule,
    StaffModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
