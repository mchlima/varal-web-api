import type { z } from 'zod';

import { AdminErrorCodeSchema } from '../admin/admin-errors.js';
import { PermissionSchema } from '../admin/rbac/permissions.js';
import { AuthErrorCodeSchema } from '../auth/auth-errors.js';
import { PaginationQuerySchema } from '../common/pagination.js';
import { SubscriptionErrorCodeSchema } from '../common/subscription.js';
import {
  ErrorCodeSchema,
  ErrorResponseSchema,
  ValidationErrorDetailsSchema,
} from '../errors/error-response.schema.js';
import { realtimeContractSchemas } from '../realtime/realtime.contracts.js';
import { SetupErrorCodeSchema } from '../units/setup-errors.js';
import { setupEventSchemas } from '../units/setup-events.js';
import { unitContractSchemas } from '../units/units.schemas.js';
import {
  ActorTypeSchema,
  EmailStatusSchema,
  EmailTypeSchema,
  SubscriptionStatusSchema,
} from './enum-schemas.js';

export { defineEvent } from './define-event.js';

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
  // Spec 02: permission catalog (RN-02.03) and error codes of the admin and of the subscription.
  PermissionSchema,
  AdminErrorCodeSchema,
  SubscriptionErrorCodeSchema,
  ...realtimeContractSchemas,
  SetupErrorCodeSchema,
  ...unitContractSchemas,
  ...setupEventSchemas,
];
