import { Module } from '@nestjs/common';

import { RealtimeModule } from '../realtime/realtime.module.js';
import { UnitsModule } from '../units/units.module.js';
import { CashRegistersService } from './cash-registers.service.js';
import { CashController } from './cash.controller.js';
import { CreditController } from './credit.controller.js';
import { CreditService } from './credit.service.js';
import { OperationAccessService } from './operation-access.js';
import { OperationController } from './operation.controller.js';
import { OperationEvents } from './operation-events.js';
import { EventsService } from './events.service.js';
import { OrderItemsService } from './order-items.service.js';
import { PaymentsService } from './payments.service.js';
import { TabsService } from './tabs.service.js';
import { UnitOperationService } from './unit-operation.service.js';

/**
 * Operation of the units (spec 04): day of operation, current price list, contracted events, tabs,
 * orders, items and station queues, with real-time events (section 7.1); their closing (spec 05):
 * discounts, payments, cash registers and their sessions; and the fiado (spec 06): customers, tabs
 * on credit and settlements.
 */
@Module({
  imports: [RealtimeModule, UnitsModule],
  controllers: [OperationController, CashController, CreditController],
  providers: [
    CashRegistersService,
    CreditService,
    EventsService,
    OperationAccessService,
    OperationEvents,
    OrderItemsService,
    PaymentsService,
    TabsService,
    UnitOperationService,
  ],
  exports: [OperationAccessService],
})
export class OperationModule {}
