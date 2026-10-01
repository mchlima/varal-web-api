import { Module } from '@nestjs/common';

import { RealtimeModule } from '../realtime/realtime.module.js';
import { UnitsModule } from '../units/units.module.js';
import { CashRegistersService } from './cash-registers.service.js';
import { CashController } from './cash.controller.js';
import { OperationAccessService } from './operation-access.js';
import { OperationController } from './operation.controller.js';
import { OperationEvents } from './operation-events.js';
import { OrderItemsService } from './order-items.service.js';
import { PaymentsService } from './payments.service.js';
import { ShiftsService } from './shifts.service.js';
import { TabsService } from './tabs.service.js';

/**
 * Operation of the units (spec 04): shifts, tabs, orders, items and station queues, with real-time
 * events (section 7.1), and their closing (spec 05): discounts, payments and cash registers.
 */
@Module({
  imports: [RealtimeModule, UnitsModule],
  controllers: [OperationController, CashController],
  providers: [
    CashRegistersService,
    OperationAccessService,
    OperationEvents,
    OrderItemsService,
    PaymentsService,
    ShiftsService,
    TabsService,
  ],
  exports: [ShiftsService],
})
export class OperationModule {}
