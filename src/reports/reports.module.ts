import { Module } from '@nestjs/common';

import { UnitsModule } from '../units/units.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/** Reports of the owner's panel (spec 07): queries over shifts, tabs, items, payments and cash. */
@Module({
  imports: [UnitsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
