import type { z } from 'zod';

import { AuthErrorCodeSchema } from '../auth/auth-errors.js';
import { PaginationQuerySchema } from '../common/pagination.js';
import {
  ErrorCodeSchema,
  ErrorResponseSchema,
  ValidationErrorDetailsSchema,
} from '../errors/error-response.schema.js';
import {
  ActorTypeSchema,
  EmailStatusSchema,
  EmailTypeSchema,
  SubscriptionStatusSchema,
} from './enum-schemas.js';

/**
 * Names a real-time event payload schema. Events are published in `components.schemas`
 * with the `Event` prefix, e.g. `EventOrderCreated` (RN-01.10).
 */
export function defineEvent<T extends z.ZodType>(id: `Event${string}`, schema: T): T {
  return schema.meta({ id });
}

/**
 * Schemas that must appear in `components.schemas` even when no route references them:
 * state enums (`TabStatus`, `OrderStatus`…), real-time event payloads (RN-01.10) and the shared
 * contracts of spec 01, section 5 (errors and pagination).
 * Each one is named with `.meta({ id })` (or {@link defineEvent}).
 */
export const contractSchemas: readonly z.ZodType[] = [
  ErrorResponseSchema,
  ErrorCodeSchema,
  ValidationErrorDetailsSchema,
  PaginationQuerySchema,
  SubscriptionStatusSchema,
  ActorTypeSchema,
  EmailTypeSchema,
  EmailStatusSchema,
  AuthErrorCodeSchema,
];
