import { Module } from '@nestjs/common';

import { RealtimeAccessService } from './realtime-access.service.js';
import { RealtimeAuthenticator } from './realtime-auth.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeService } from './realtime.service.js';

/**
 * Real-time channel of the customers' app (spec 01, section 10): Socket.IO at `/ws`. Business
 * modules import it and emit with {@link RealtimeService}.
 */
@Module({
  providers: [RealtimeGateway, RealtimeService, RealtimeAuthenticator, RealtimeAccessService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
