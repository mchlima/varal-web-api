import type { StandardSchemaValidationPipeOptions } from '@nestjs/common';
import { z } from 'zod';

import { AppError } from './app-error.js';
import type { ValidationIssue } from './error-response.schema.js';

/** A Standard Schema issue, typed through Nest (the spec package is not a direct dependency). */
type SchemaIssue = Parameters<
  NonNullable<StandardSchemaValidationPipeOptions['exceptionFactory']>
>[0][number];

function pathOf(issue: SchemaIssue): string {
  return (issue.path ?? [])
    .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
    .join('.');
}

/** Turns Standard Schema issues into `VALIDATION_FAILED` with one entry per field (spec 01, section 5). */
export function validationError(issues: readonly SchemaIssue[]): AppError {
  const fields: ValidationIssue[] = issues.map((issue) => ({
    path: pathOf(issue),
    message: issue.message,
  }));
  return AppError.of('VALIDATION_FAILED', { details: { fields } });
}

/** Validation messages in pt-BR: they are shown to the user (spec 01, section 5). */
export function configureZodLocale(): void {
  z.config(z.locales.ptBR());
}
