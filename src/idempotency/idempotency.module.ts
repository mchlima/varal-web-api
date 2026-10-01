import { Global, Module } from '@nestjs/common';

import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { IdempotencyService } from './idempotency.service.js';

@Global()
@Module({
  providers: [IdempotencyService, IdempotencyInterceptor],
  exports: [IdempotencyService, IdempotencyInterceptor],
})
export class IdempotencyModule {}
