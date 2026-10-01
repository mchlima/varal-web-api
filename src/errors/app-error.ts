import { HttpException } from '@nestjs/common';

import { ERROR_CODES, type ErrorCode } from './error-codes.js';
import type { ErrorDetails, ErrorResponse } from './error-response.schema.js';

interface AppErrorOptions {
  /** Overrides the default pt-BR message of the code. */
  message?: string;
  details?: ErrorDetails;
}

/**
 * Error with a stable code, rendered as `{ "error": { "code", "message", "details" } }`
 * (spec 01, section 5).
 *
 * - Generic codes: `AppError.of('NOT_FOUND')`.
 * - Module codes: `new AppError('TAB_ALREADY_CLOSED', 409, 'Esta comanda já foi fechada.')`.
 */
export class AppError extends HttpException {
  constructor(
    readonly code: string,
    status: number,
    message: string,
    readonly details: ErrorDetails = {},
  ) {
    super({ error: { code, message, details } } satisfies ErrorResponse, status);
    this.name = 'AppError';
  }

  static of(code: ErrorCode, options: AppErrorOptions = {}): AppError {
    const definition = ERROR_CODES[code];
    return new AppError(
      code,
      definition.status,
      options.message ?? definition.message,
      options.details,
    );
  }

  /** The response body sent to the client. */
  toResponse(): ErrorResponse {
    return this.getResponse() as ErrorResponse;
  }
}
