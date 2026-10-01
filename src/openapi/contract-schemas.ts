import type { z } from 'zod';

import { EmailLogListQuerySchema, EmailUsageQuerySchema } from '../admin/admin-emails.schemas.js';
import { AdminErrorCodeSchema } from '../admin/admin-errors.js';
import { AnnouncementListQuerySchema } from '../admin/announcements/announcements.schemas.js';
import { AuditLogListQuerySchema } from '../admin/audit-logs.controller.js';
import { ImpersonationListQuerySchema } from '../admin/impersonation/impersonations.schemas.js';
import {
  MetricsPeriodQuerySchema,
  OrganizationUsageQuerySchema,
} from '../admin/metrics/metrics.schemas.js';
import { OrganizationListQuerySchema } from '../admin/organizations/organizations.schemas.js';
import { PermissionSchema } from '../admin/rbac/permissions.js';
import { AuthErrorCodeSchema } from '../auth/auth-errors.js';
import { AdminUserListQuerySchema } from '../admin/users/admin-users.schemas.js';
import { PaginationQueryContractSchema, PaginationQuerySchema } from '../common/pagination.js';
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
  PaginationQueryContractSchema,
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

/**
 * Named input shapes of the query schemas (`<id>Input` in `components.schemas`), published before
 * the routes listed their query parameters. Kept so the apps' types keep compiling (additive
 * contract); routes now publish each field as an `in: query` parameter. Query schemas themselves
 * stay unnamed (see `PaginationQuerySchema`), so new lists do not need an entry here.
 */
export const queryContractSchemas: readonly z.ZodType[] = Object.entries({
  PaginationQuery: PaginationQuerySchema,
  AdminUserListQuery: AdminUserListQuerySchema,
  AnnouncementListQuery: AnnouncementListQuerySchema,
  AuditLogListQuery: AuditLogListQuerySchema,
  EmailLogListQuery: EmailLogListQuerySchema,
  EmailUsageQuery: EmailUsageQuerySchema,
  ImpersonationListQuery: ImpersonationListQuerySchema,
  MetricsPeriodQuery: MetricsPeriodQuerySchema,
  OrganizationListQuery: OrganizationListQuerySchema,
  OrganizationUsageQuery: OrganizationUsageQuerySchema,
}).map(([id, schema]) => schema.meta({ id }));
