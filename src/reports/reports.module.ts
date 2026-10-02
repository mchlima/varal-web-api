import { Module } from '@nestjs/common';

import { UnitsModule } from '../units/units.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/** Reports of the owner's panel (spec 07): queries over days of operation, tabs, items, payments, cash register sessions and events. */
@Module({
  imports: [UnitsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
