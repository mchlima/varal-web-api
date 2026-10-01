import { Module } from '@nestjs/common';

import { RealtimeModule } from '../realtime/realtime.module.js';
import { OpenShiftChecker } from './open-shift.js';
import { SetupEvents } from './setup-events.js';
import { StationsService } from './stations.service.js';
import { OwnerGuard, UnitAccessService } from './unit-access.js';
import { UnitTemplateService } from './unit-template.service.js';
import { UnitsController } from './units.controller.js';
import { UnitsService } from './units.service.js';
import { WorkflowService } from './workflow.service.js';

/**
 * Units, stations and workflow (spec 03, sections 3 and 4).
 *
 * Exports for the other modules:
 * - `UnitTemplateService`: default template of a new unit (RN-03.03), also for spec 02 (platform
 *   admin creating an organization);
 * - `UnitAccessService`, `OwnerGuard`: who may read or change a unit;
 * - `OpenShiftChecker`: RN-03.02 / RN-03.07, replaced by spec 04;
 * - `SetupEvents`: versions and real-time events of the menu and the unit settings.
 */
@Module({
  imports: [RealtimeModule],
  controllers: [UnitsController],
  providers: [
    OpenShiftChecker,
    OwnerGuard,
    SetupEvents,
    StationsService,
    UnitAccessService,
    UnitTemplateService,
    UnitsService,
    WorkflowService,
  ],
  exports: [OpenShiftChecker, OwnerGuard, SetupEvents, UnitAccessService, UnitTemplateService],
})
export class UnitsModule {}
