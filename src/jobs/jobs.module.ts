import { Global, Module } from '@nestjs/common';

import { MaintenanceJob } from './maintenance.job.js';
import { PgBossService } from './pg-boss.service.js';

@Global()
@Module({
  providers: [PgBossService, MaintenanceJob],
  exports: [PgBossService, MaintenanceJob],
})
export class JobsModule {}
