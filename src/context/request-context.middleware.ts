import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import { runWithContext } from './request-context.js';

export const REQUEST_ID_HEADER = 'X-Request-Id';
export const DEVICE_ID_HEADER = 'X-Device-Id';

/** An incoming request id is reused only when it is short and harmless in logs. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const deviceIdSchema = z.uuid();

function singleHeader(request: Request, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Opens the request context (spec 01, section 6) for everything after it: guards, interceptors,
 * handlers and the services they call. Authentication (phase 1b) fills `auth` later in the same
 * context with `setAuthContext`.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const incomingRequestId = singleHeader(request, REQUEST_ID_HEADER);
    const requestId =
      incomingRequestId !== undefined && REQUEST_ID_PATTERN.test(incomingRequestId)
        ? incomingRequestId
        : crypto.randomUUID();
    response.setHeader(REQUEST_ID_HEADER, requestId);

    const rawDeviceId = singleHeader(request, DEVICE_ID_HEADER);
    let deviceId: string | null = null;
    if (rawDeviceId !== undefined && rawDeviceId !== '') {
      const parsed = deviceIdSchema.safeParse(rawDeviceId);
      if (!parsed.success) {
        throw AppError.of('VALIDATION_FAILED', {
          details: {
            fields: [
              { path: DEVICE_ID_HEADER, message: 'O identificador do aparelho é inválido.' },
            ],
          },
        });
      }
      deviceId = parsed.data.toLowerCase();
    }

    runWithContext({ requestId, deviceId, ip: request.ip ?? null, auth: null }, () => {
      next();
    });
  }
}
