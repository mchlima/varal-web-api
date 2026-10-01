import { Module } from '@nestjs/common';

import { RealtimeModule } from '../realtime/realtime.module.js';
import { UnitsModule } from '../units/units.module.js';
import { OperationAccessService } from './operation-access.js';
import { OperationController } from './operation.controller.js';
import { OperationEvents } from './operation-events.js';
import { OrderItemsService } from './order-items.service.js';
import { ShiftsService } from './shifts.service.js';
import { TabsService } from './tabs.service.js';

/**
 * Operation of the units (spec 04): shifts, tabs, orders, items and station queues, with real-time
 * events (section 7.1). Payments, discounts and cash registers (spec 05) extend it.
 */
@Module({
  imports: [RealtimeModule, UnitsModule],
  controllers: [OperationController],
  providers: [
    OperationAccessService,
    OperationEvents,
    OrderItemsService,
    ShiftsService,
    TabsService,
  ],
  exports: [ShiftsService],
})
export class OperationModule {}
