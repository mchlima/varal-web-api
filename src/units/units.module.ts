import { Module } from '@nestjs/common';

import { RealtimeModule } from '../realtime/realtime.module.js';
import { OperationGuard } from './operation-guard.js';
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
 * - `UnitTemplateService`: default template of a new unit, with "Caixa 1" (RN-03.03), also for spec 02 (platform
 *   admin creating an organization);
 * - `UnitAccessService`, `OwnerGuard`: who may read or change a unit;
 * - `OperationGuard`: RN-03.02 / RN-03.07, from the cash registers (spec 05) and tabs (spec 04);
 * - `SetupEvents`: versions and real-time events of the menu and the unit settings.
 */
@Module({
  imports: [RealtimeModule],
  controllers: [UnitsController],
  providers: [
    OperationGuard,
    OwnerGuard,
    SetupEvents,
    StationsService,
    UnitAccessService,
    UnitTemplateService,
    UnitsService,
    WorkflowService,
  ],
  exports: [OperationGuard, OwnerGuard, SetupEvents, UnitAccessService, UnitTemplateService],
})
export class UnitsModule {}
