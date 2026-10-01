import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { AuditModule } from './audit/audit.module.js';
import { ConfigModule } from './config/config.module.js';
import { RequestContextModule } from './context/context.module.js';
import { AllExceptionsFilter } from './errors/all-exceptions.filter.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

@Module({
  imports: [ConfigModule, RequestContextModule, PrismaModule, AuditModule, HealthModule],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
