import type { Prisma } from '../../generated/prisma/client.js';
import {
  normalizePermissions,
  type Permission,
  PERMISSIONS,
  SUPER_ADMIN_KEY,
} from './permissions.js';

export interface AdminRoleRef {
  id: string;
  name: string;
  isSystem: boolean;
  systemKey: string | null;
}

/** Roles, extra permissions and the effective permissions of one platform admin (RN-02.02). */
export interface AdminAccess {
  adminId: string;
  active: boolean;
  roles: AdminRoleRef[];
  /** Extra permissions given to the user directly (`platform_admin_permissions`). */
  extraPermissions: Permission[];
  /** Union of the permissions of the roles and the extra ones. Super admin: the whole catalog. */
  permissions: Permission[];
  isSuperAdmin: boolean;
}

/** What {@link toAdminAccess} needs of a `platform_admins` row. */
export const ADMIN_ACCESS_SELECT = {
  id: true,
  active: true,
  roles: {
    select: {
      role: {
        select: {
          id: true,
          name: true,
          isSystem: true,
          systemKey: true,
          permissions: { select: { permission: true } },
        },
      },
    },
    orderBy: { role: { name: 'asc' } },
  },
  permissions: { select: { permission: true } },
} as const satisfies Prisma.PlatformAdminSelect;

export type AdminAccessRow = Prisma.PlatformAdminGetPayload<{ select: typeof ADMIN_ACCESS_SELECT }>;

/** Effective permissions (RN-02.02); keys no longer in the catalog are ignored. */
export function toAdminAccess(row: AdminAccessRow): AdminAccess {
  const roles = row.roles.map(({ role }) => role);
  const isSuperAdmin = roles.some((role) => role.systemKey === SUPER_ADMIN_KEY);
  const extraPermissions = normalizePermissions(row.permissions.map((item) => item.permission));
  const permissions = isSuperAdmin
    ? [...PERMISSIONS]
    : normalizePermissions([
        ...roles.flatMap((role) => role.permissions.map((item) => item.permission)),
        ...extraPermissions,
      ]);
  return {
    adminId: row.id,
    active: row.active,
    roles: roles.map(({ id, name, isSystem, systemKey }) => ({ id, name, isSystem, systemKey })),
    extraPermissions,
    permissions,
    isSuperAdmin,
  };
}

/**
 * Loads the access of an admin. Called on every request of an admin route (RN-02.08: a change of
 * role or permission applies on the next request of the affected user).
 */
export async function loadAdminAccess(
  db: Prisma.TransactionClient,
  adminId: string,
): Promise<AdminAccess | null> {
  const row = await db.platformAdmin.findUnique({
    where: { id: adminId },
    select: ADMIN_ACCESS_SELECT,
  });
  return row ? toAdminAccess(row) : null;
}
