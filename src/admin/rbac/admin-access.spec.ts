import { describe, expect, it } from 'vitest';

import { type AdminAccessRow, toAdminAccess } from './admin-access.js';
import { normalizePermissions, PERMISSIONS, SYSTEM_ROLES } from './permissions.js';

function row(
  roles: { key: string | null; permissions: string[] }[],
  extra: string[] = [],
): AdminAccessRow {
  return {
    id: 'a',
    active: true,
    roles: roles.map((role, index) => ({
      role: {
        id: `r${index}`,
        name: `Role ${index}`,
        isSystem: role.key !== null,
        systemKey: role.key,
        permissions: role.permissions.map((permission) => ({ permission })),
      },
    })),
    permissions: extra.map((permission) => ({ permission })),
  };
}

describe('effective permissions (RN-02.02)', () => {
  it('is the union of the roles and the extra permissions, in catalog order, without repeats', () => {
    const access = toAdminAccess(
      row(
        [
          { key: null, permissions: ['metrics:read', 'organizations:read'] },
          { key: null, permissions: ['organizations:read'] },
        ],
        ['organizations:create'],
      ),
    );
    expect(access.permissions).toEqual([
      'organizations:read',
      'organizations:create',
      'metrics:read',
    ]);
    expect(access.extraPermissions).toEqual(['organizations:create']);
    expect(access.isSuperAdmin).toBe(false);
  });

  it('Super admin has the whole catalog, including permissions created later (RN-02.04)', () => {
    const access = toAdminAccess(row([{ key: 'super_admin', permissions: [] }]));
    expect(access.isSuperAdmin).toBe(true);
    expect(access.permissions).toEqual([...PERMISSIONS]);
  });

  it('ignores keys no longer in the catalog', () => {
    expect(normalizePermissions(['old:permission', 'audit:read'])).toEqual(['audit:read']);
  });

  it('system roles follow the table of spec 02, section 3.2', () => {
    expect(SYSTEM_ROLES.read_only.permissions).toEqual([
      'organizations:read',
      'announcements:read',
      'metrics:read',
    ]);
    expect(SYSTEM_ROLES.finance.permissions).toContain('subscriptions:update');
    expect(SYSTEM_ROLES.support.permissions).toContain('impersonation:use');
    expect(SYSTEM_ROLES.support.permissions).not.toContain('audit:read');
  });
});
