import { Module } from '@nestjs/common';

import { RealtimeModule } from '../realtime/realtime.module.js';
import { UnitsModule } from '../units/units.module.js';
import { StaffController } from './staff.controller.js';
import { StaffService } from './staff.service.js';

/** Staff members, their permissions and the team access code (spec 03, section 6). */
@Module({
  imports: [RealtimeModule, UnitsModule],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}
