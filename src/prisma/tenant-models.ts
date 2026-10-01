import type { Prisma } from '../generated/prisma/client.js';

/**
 * Tenant models and the field that ties each row to its organization (spec 01, section 6).
 * The tenant-scoping extension filters these models by the organization of the request context.
 *
 * `Organization` is the tenant itself: through the tenant client an organization sees only its own
 * row, and cannot create or delete organizations (that is the platform admin's job, spec 02).
 *
 * Every new model with `organizationId` must be listed here or in {@link PLATFORM_MODELS_WITH_ORGANIZATION};
 * a unit test fails otherwise.
 */
export const TENANT_MODELS = {
  Organization: 'id',
  Unit: 'organizationId',
  User: 'organizationId',
  StaffMember: 'organizationId',
  StaffUnitPermission: 'organizationId',
} as const satisfies Partial<Record<Prisma.ModelName, string>>;

export type TenantModel = keyof typeof TENANT_MODELS;

/**
 * Models with an optional `organization_id` that are not tenant data: they also hold platform rows
 * (admin sessions, platform audit, e-mails) and are read by authentication, jobs and the admin.
 * They are never filtered automatically; queries on them filter by hand.
 */
export const PLATFORM_MODELS_WITH_ORGANIZATION = [
  'Session',
  'AuditLog',
  'EmailLog',
  'IdempotencyKey',
] as const satisfies readonly Prisma.ModelName[];

export function tenantFieldOf(model: string | undefined): string | undefined {
  return model !== undefined && Object.hasOwn(TENANT_MODELS, model)
    ? TENANT_MODELS[model as TenantModel]
    : undefined;
}
