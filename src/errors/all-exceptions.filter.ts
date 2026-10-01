import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { getRequestContext } from '../context/request-context.js';
import { toErrorResponse } from './to-error-response.js';

/**
 * Global filter: every error leaves the API as `{ "error": { "code", "message", "details" } }`
 * (spec 01, section 5). Registered in AppModule as APP_FILTER.
 */
@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  constructor(@Inject(APP_ENV) private readonly env: Env) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const rendered = toErrorResponse(exception, {
      exposeInternals: this.env.NODE_ENV !== 'production',
    });
    if (rendered.unexpected) {
      const requestId = getRequestContext()?.requestId ?? '-';
      this.logger.error(
        `[${requestId}] ${exception instanceof Error ? exception.message : String(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }
    if (host.getType() !== 'http') {
      // WebSocket errors get their own handling in the realtime gateway (phase 1b).
      throw exception;
    }
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) {
      return;
    }
    response.status(rendered.status).json(rendered.body);
  }
}
