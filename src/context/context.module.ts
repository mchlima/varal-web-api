import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';

import { RequestContextMiddleware } from './request-context.middleware.js';

@Module({})
export class RequestContextModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route, including unknown ones (their 404 also gets X-Request-Id).
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
  }
}
