import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { z } from 'zod';

import { getRequestContext } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import { toErrorResponse } from '../errors/to-error-response.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  IDEMPOTENT_TRANSACTION_TIMEOUT_MS,
} from './idempotency.constants.js';
import { IdempotencyService } from './idempotency.service.js';
import { hashRequest } from './request-hash.js';

const keySchema = z.uuid();

/**
 * Applies `Idempotency-Key` to a write route (spec 01, section 5; CA-01.06). Use it through the
 * {@link Idempotent} decorator. Without the header the route runs normally.
 *
 * The handler runs inside an ambient transaction (`PrismaService.transaction` joins it), and the
 * response is stored in that same transaction: a repeated request gets the stored status and body
 * (with `Idempotent-Replayed: true`) instead of running the action again.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const header = request.header(IDEMPOTENCY_KEY_HEADER);
    if (header === undefined || header === '') {
      return next.handle();
    }
    return from(this.handle(request, http.getResponse<Response>(), header, next));
  }

  private async handle(
    request: Request,
    response: Response,
    header: string,
    next: CallHandler,
  ): Promise<unknown> {
    const parsedKey = keySchema.safeParse(header);
    if (!parsedKey.success) {
      throw AppError.of('VALIDATION_FAILED', {
        details: {
          fields: [{ path: IDEMPOTENCY_KEY_HEADER, message: 'A chave de envio deve ser um UUID.' }],
        },
      });
    }
    const auth = getRequestContext()?.auth;
    if (!auth?.actor.id) {
      throw AppError.of('UNAUTHENTICATED');
    }

    const claim = await this.idempotency.claim({
      key: parsedKey.data.toLowerCase(),
      subjectId: auth.actor.id,
      organizationId: auth.organizationId,
      requestHash: hashRequest(request.method, request.originalUrl, request.body),
    });

    if (claim.kind === 'replay') {
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
      if (claim.statusCode >= 400) {
        // The global filter sends stored error envelopes as they are.
        throw new HttpException(claim.response as Record<string, unknown>, claim.statusCode);
      }
      response.status(claim.statusCode);
      return claim.response;
    }

    try {
      return await this.prisma.transaction(
        async (tx) => {
          const body: unknown = await lastValueFrom(next.handle() as Observable<unknown>, {
            defaultValue: undefined,
          });
          await this.idempotency.complete(tx, claim.id, response.statusCode, body);
          return body;
        },
        { timeout: IDEMPOTENT_TRANSACTION_TIMEOUT_MS },
      );
    } catch (error) {
      const rendered = toErrorResponse(error, { exposeInternals: false });
      if (rendered.unexpected) {
        await this.idempotency.release(claim.id);
      } else {
        await this.idempotency.storeError(claim.id, rendered.status, rendered.body);
      }
      throw error;
    }
  }
}
