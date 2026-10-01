import { HttpException } from '@nestjs/common';

import { Prisma } from '../generated/prisma/client.js';
import { AppError } from './app-error.js';
import { codeForStatus, ERROR_CODES } from './error-codes.js';
import { type ErrorResponse, isErrorResponse } from './error-response.schema.js';

export interface RenderedError {
  status: number;
  body: ErrorResponse;
  /** Unexpected errors (5xx) are logged with their stack; expected ones are not. */
  unexpected: boolean;
}

interface RenderOptions {
  /** Development and tests only: adds the internal error message to `details.debug`. Never in production. */
  exposeInternals: boolean;
}

function generic(status: number, unexpected = status >= 500): RenderedError {
  const code = codeForStatus(status);
  return {
    status,
    body: { error: { code, message: ERROR_CODES[code].message, details: {} } },
    unexpected,
  };
}

/** Status of errors raised by Express middleware (body-parser and other `http-errors`). */
function httpErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const value = typeof status === 'number' ? status : statusCode;
  return typeof value === 'number' && value >= 400 && value < 600 ? value : undefined;
}

function fromPrisma(error: Prisma.PrismaClientKnownRequestError): RenderedError | undefined {
  switch (error.code) {
    // Record to update/delete not found: in the tenant client this also covers rows of another
    // organization, which must look exactly like missing ones (CA-01.02).
    case 'P2025':
      return { ...generic(404), body: AppError.of('NOT_FOUND').toResponse() };
    case 'P2002':
      return { ...generic(409), body: AppError.of('ALREADY_EXISTS').toResponse() };
    default:
      return undefined;
  }
}

/**
 * Maps any thrown value to the error envelope of spec 01, section 5. Messages of unexpected errors
 * never reach the client in production, and stacks never reach it at all (they go to the log).
 */
export function toErrorResponse(exception: unknown, options: RenderOptions): RenderedError {
  if (exception instanceof AppError) {
    return { status: exception.getStatus(), body: exception.toResponse(), unexpected: false };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();
    // Already in the envelope (e.g. a stored idempotent response being replayed).
    if (isErrorResponse(response)) {
      return { status, body: response, unexpected: status >= 500 };
    }
    return generic(status);
  }
  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = fromPrisma(exception);
    if (mapped) {
      return mapped;
    }
  }
  const status = httpErrorStatus(exception);
  if (status !== undefined && status < 500) {
    return generic(status);
  }

  const rendered = generic(500, true);
  if (options.exposeInternals && exception instanceof Error) {
    rendered.body.error.details = { debug: { name: exception.name, message: exception.message } };
  }
  return rendered;
}
