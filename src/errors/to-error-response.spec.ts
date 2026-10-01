import { HttpException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { Prisma } from '../generated/prisma/client.js';
import { AppError } from './app-error.js';
import { ERROR_CODES } from './error-codes.js';
import { ErrorResponseSchema } from './error-response.schema.js';
import { toErrorResponse } from './to-error-response.js';
import { validationError } from './validation.js';

const production = { exposeInternals: false };
const development = { exposeInternals: true };

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError('prisma says no', {
    code,
    clientVersion: '7.10.0',
  });
}

describe('toErrorResponse (spec 01, section 5)', () => {
  it('renders an AppError with its code, pt-BR message and details', () => {
    const rendered = toErrorResponse(
      new AppError('TAB_ALREADY_CLOSED', 409, 'Esta comanda já foi fechada.', { tabId: 't1' }),
      production,
    );
    expect(rendered).toEqual({
      status: 409,
      unexpected: false,
      body: {
        error: {
          code: 'TAB_ALREADY_CLOSED',
          message: 'Esta comanda já foi fechada.',
          details: { tabId: 't1' },
        },
      },
    });
  });

  it.each([
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [429, 'RATE_LIMITED'],
  ] as const)('maps a framework %i to %s with the pt-BR message', (status, code) => {
    const rendered = toErrorResponse(new HttpException('English text', status), production);
    expect(rendered.status).toBe(status);
    expect(rendered.body.error).toEqual({ code, message: ERROR_CODES[code].message, details: {} });
  });

  it('never leaks the framework message (e.g. "Cannot GET /x")', () => {
    const rendered = toErrorResponse(new NotFoundException('Cannot GET /x'), production);
    expect(JSON.stringify(rendered.body)).not.toContain('Cannot GET');
  });

  it('turns validation issues into VALIDATION_FAILED with one entry per field', () => {
    const rendered = toErrorResponse(
      validationError([
        { message: 'Obrigatório', path: ['name'] },
        { message: 'Muito pequeno', path: ['items', 0, { key: 'quantity' }] },
      ]),
      production,
    );
    expect(rendered.status).toBe(400);
    expect(rendered.body.error.code).toBe('VALIDATION_FAILED');
    expect(rendered.body.error.details).toEqual({
      fields: [
        { path: 'name', message: 'Obrigatório' },
        { path: 'items.0.quantity', message: 'Muito pequeno' },
      ],
    });
  });

  it('maps "record not found" to 404, so another organization looks like a missing row (CA-01.02)', () => {
    expect(toErrorResponse(prismaError('P2025'), production)).toMatchObject({
      status: 404,
      body: { error: { code: 'NOT_FOUND' } },
    });
  });

  it('maps a unique violation to 409 ALREADY_EXISTS', () => {
    expect(toErrorResponse(prismaError('P2002'), production)).toMatchObject({
      status: 409,
      body: { error: { code: 'ALREADY_EXISTS' } },
    });
  });

  it('maps body-parser errors by status', () => {
    const error = Object.assign(new SyntaxError('Unexpected token'), {
      status: 400,
      type: 'entity.parse.failed',
    });
    expect(toErrorResponse(error, production)).toMatchObject({
      status: 400,
      body: { error: { code: 'BAD_REQUEST' } },
    });
  });

  it('hides unexpected errors in production: no message, no stack', () => {
    const rendered = toErrorResponse(new Error('password=hunter2 at /srv/app.ts:10'), production);
    expect(rendered).toEqual({
      status: 500,
      unexpected: true,
      body: {
        error: { code: 'INTERNAL_ERROR', message: ERROR_CODES.INTERNAL_ERROR.message, details: {} },
      },
    });
  });

  it('adds the internal message (never the stack) outside production', () => {
    const rendered = toErrorResponse(new TypeError('boom'), development);
    expect(rendered.body.error.details).toEqual({ debug: { name: 'TypeError', message: 'boom' } });
    expect(JSON.stringify(rendered.body)).not.toContain('at ');
  });

  it('passes an error envelope through as it is (stored idempotent responses)', () => {
    const body = { error: { code: 'UNIT_REJECTED', message: 'Unidade recusada.', details: {} } };
    expect(toErrorResponse(new HttpException(body, 422), production)).toEqual({
      status: 422,
      body,
      unexpected: false,
    });
  });

  it('always produces a body that matches the published ErrorResponse schema', () => {
    for (const error of [new Error('x'), new HttpException('x', 418), AppError.of('FORBIDDEN')]) {
      expect(ErrorResponseSchema.safeParse(toErrorResponse(error, development).body).success).toBe(
        true,
      );
    }
  });
});
