import { applyDecorators, UseInterceptors } from '@nestjs/common';
import { ApiConflictResponse, ApiHeader } from '@nestjs/swagger';

import { ErrorResponseSchema } from '../errors/error-response.schema.js';
import { IDEMPOTENCY_KEY_HEADER } from './idempotency.constants.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

/**
 * Marks a write route as idempotent (spec 01, section 5): it accepts `Idempotency-Key` and replays
 * the stored response for 24 h. Required on every operational write (orders, payments, stage
 * changes, cash movements).
 */
export function Idempotent(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({
      name: IDEMPOTENCY_KEY_HEADER,
      required: false,
      description:
        'UUID gerado no aparelho. Repetir a mesma chave devolve a mesma resposta por 24 h, sem repetir a ação.',
      schema: { type: 'string', format: 'uuid' },
    }),
    ApiConflictResponse({
      description:
        '`IDEMPOTENCY_KEY_REUSED` (mesma chave com outro corpo) ou `IDEMPOTENCY_REQUEST_IN_PROGRESS`.',
      standardSchema: ErrorResponseSchema,
    }),
  );
}
