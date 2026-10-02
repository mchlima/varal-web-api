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
  Station: 'organizationId',
  WorkflowStage: 'organizationId',
  Category: 'organizationId',
  Product: 'organizationId',
  ModifierGroup: 'organizationId',
  Modifier: 'organizationId',
  // Spec 02: what the owner reads in the panel (banner reads, support accesses).
  AnnouncementTarget: 'organizationId',
  AnnouncementRead: 'organizationId',
  ImpersonationSession: 'organizationId',
  // Spec 03: price lists.
  PriceList: 'organizationId',
  ProductPrice: 'organizationId',
  // Spec 04: events, tabs, orders and items.
  ContractedEvent: 'organizationId',
  Tab: 'organizationId',
  Order: 'organizationId',
  OrderItem: 'organizationId',
  OrderItemModifier: 'organizationId',
  // Legacy shifts (read only until the contraction migration, plan phase 7.5).
  Shift: 'organizationId',
  ShiftAgreement: 'organizationId',
  ShiftPrice: 'organizationId',
  // Spec 05: cash registers, sessions, movements, counts and payments.
  CashRegister: 'organizationId',
  CashRegisterSession: 'organizationId',
  CashMovement: 'organizationId',
  CashRegisterCount: 'organizationId',
  Payment: 'organizationId',
  // Spec 06: customers of the fiado.
  Customer: 'organizationId',
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
