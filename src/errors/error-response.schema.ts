import { z } from 'zod';

import { ERROR_CODE_VALUES } from './error-codes.js';

/** Generic error codes (spec 01, section 5). Modules may return other codes, always in English. */
export const ErrorCodeSchema = z.enum(ERROR_CODE_VALUES).meta({
  id: 'ErrorCode',
  description: 'Códigos genéricos de erro; cada módulo pode ter os seus.',
});

export const ErrorDetailsSchema = z.record(z.string(), z.unknown());

export type ErrorDetails = z.infer<typeof ErrorDetailsSchema>;

/** Body of every error response (spec 01, section 5). */
export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().meta({
        description: 'Código estável, em inglês (ex.: `NOT_FOUND`, `TAB_ALREADY_CLOSED`).',
        examples: ['VALIDATION_FAILED'],
      }),
      message: z
        .string()
        .meta({ description: 'Mensagem em português, pode ser mostrada ao usuário.' }),
      details: ErrorDetailsSchema.meta({
        description:
          'Dados extras do erro; em `VALIDATION_FAILED`, `{ fields: ValidationIssue[] }`.',
      }),
    }),
  })
  .meta({ id: 'ErrorResponse' });

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** One invalid field of a `VALIDATION_FAILED` error. */
export const ValidationIssueSchema = z
  .object({
    path: z
      .string()
      .meta({ description: 'Caminho do campo, com pontos (ex.: `items.0.quantity`).' }),
    message: z.string().meta({ description: 'Mensagem em português.' }),
  })
  .meta({ id: 'ValidationIssue' });

export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

/** Details of a `VALIDATION_FAILED` error. */
export const ValidationErrorDetailsSchema = z
  .object({ fields: z.array(ValidationIssueSchema) })
  .meta({ id: 'ValidationErrorDetails' });

export function isErrorResponse(value: unknown): value is ErrorResponse {
  return ErrorResponseSchema.safeParse(value).success;
}
