import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import {
  type Permission,
  PERMISSIONS,
  SUPER_ADMIN_KEY,
  SYSTEM_ROLE_KEYS,
  SYSTEM_ROLES,
  type SystemRoleKey,
} from '../../src/admin/rbac/permissions.js';
import { PERMISSIONS_EXTENSION } from '../../src/admin/rbac/require-permission.js';
import { buildOpenApiDocument } from '../../src/openapi/openapi.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import {
  type AdminClient,
  adminClient,
  type HttpMethod,
  uniqueEmail,
} from '../support/admin-kit.js';
import { loginOwner, setPassword } from '../support/auth-kit.js';
import { errorOf } from '../support/http.js';
import { createTenant } from '../support/isolation-kit.js';
import { createTestApp } from '../support/test-app.js';

const databaseUrl = inject('databaseUrl');
const API = '/api/v1';
const METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

describe.skipIf(!databaseUrl)('RBAC of the platform admin (spec 02, section 3)', () => {
  let app: NestExpressApplication;
  let platform: PlatformPrismaService;
  let superAdmin: AdminClient;
  let readOnly: AdminClient;

  beforeAll(async () => {
    app = await createTestApp({ auth: 'real', databaseUrl: databaseUrl ?? '' });
    platform = app.get(PlatformPrismaService);
    superAdmin = await adminClient(app, platform);
    readOnly = await adminClient(app, platform, { roles: ['read_only'] });
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  async function roleId(key: SystemRoleKey): Promise<string> {
    return (await platform.role.findUniqueOrThrow({ where: { systemKey: key } })).id;
  }

  describe('system roles (RN-02.04)', () => {
    it('the migration creates the four system roles with the permissions of section 3.2', async () => {
      const roles = await platform.role.findMany({
        where: { systemKey: { in: [...SYSTEM_ROLE_KEYS] } },
        include: { permissions: true },
      });
      expect(roles).toHaveLength(4);
      for (const role of roles) {
        const definition = SYSTEM_ROLES[role.systemKey as SystemRoleKey];
        expect(role).toMatchObject({ name: definition.name, isSystem: true });
        const stored = role.permissions.map((row) => row.permission).sort();
        expect(stored).toEqual(
          definition.permissions === 'all' ? [] : [...definition.permissions].sort(),
        );
      }
    });

    it('GET /admin/permissions lists the catalog to any admin', async () => {
      const response = await readOnly.call('get', `${API}/admin/permissions`).expect(200);
      expect((response.body as { data: { key: string }[] }).data.map((item) => item.key)).toEqual([
        ...PERMISSIONS,
      ]);
    });

    it('GET /admin/auth/me returns the roles and the effective permissions (Super admin: all)', async () => {
      const me = await superAdmin.call('get', `${API}/admin/auth/me`).expect(200);
      expect(me.body).toMatchObject({
        roles: [{ systemKey: 'super_admin' }],
        permissions: [...PERMISSIONS],
      });
      const reader = await readOnly.call('get', `${API}/admin/auth/me`).expect(200);
      expect((reader.body as { permissions: string[] }).permissions).toEqual([
        'organizations:read',
        'announcements:read',
        'metrics:read',
      ]);
    });

    it('Super admin cannot be edited and system roles cannot be removed', async () => {
      const superId = await roleId('super_admin');
      const edit = await superAdmin
        .call('patch', `${API}/admin/roles/${superId}`, { permissions: [] })
        .expect(409);
      expect(errorOf(edit).code).toBe('ROLE_NOT_EDITABLE');
      const remove = await superAdmin
        .call('delete', `${API}/admin/roles/${await roleId('read_only')}`)
        .expect(409);
      expect(errorOf(remove).code).toBe('ROLE_NOT_EDITABLE');
    });
  });

  describe('permission denied by role (RN-02.01): 403 on every admin route without the permission', () => {
    const cases: { label: string; roles: SystemRoleKey[] }[] = [
      { label: 'Suporte', roles: ['support'] },
      { label: 'Financeiro', roles: ['finance'] },
      { label: 'Leitura', roles: ['read_only'] },
      { label: 'sem papel', roles: [] },
    ];

    for (const { label, roles } of cases) {
      it(`${label}: 403 exactly where the role lacks the permission`, async () => {
        const client = await adminClient(app, platform, { roles });
        const granted = new Set<Permission>(
          roles.flatMap((key) => {
            const permissions = SYSTEM_ROLES[key].permissions;
            return permissions === 'all' ? [...PERMISSIONS] : [...permissions];
          }),
        );
        const document = buildOpenApiDocument(app);
        const missing: string[] = [];
        const unexpected: string[] = [];
        for (const [path, item] of Object.entries(document.paths)) {
          if (!path.startsWith('/api/v1/admin/') || path.startsWith('/api/v1/admin/auth/')) {
            continue;
          }
          for (const method of METHODS) {
            const operation = item[method] as Record<string, unknown> | undefined;
            if (!operation) {
              continue;
            }
            const required = operation[PERMISSIONS_EXTENSION] as Permission[];
            const allowed = required.length === 0 || required.some((p) => granted.has(p));
            const url = path.replaceAll('{id}', crypto.randomUUID());
            const response = await client.call(method, url);
            if (!allowed && response.status !== 403) {
              missing.push(`${method.toUpperCase()} ${path} → ${response.status}`);
            }
            if (allowed && response.status === 403) {
              unexpected.push(`${method.toUpperCase()} ${path}`);
            }
          }
        }
        expect(missing).toEqual([]);
        expect(unexpected).toEqual([]);
      });
    }

    it('the 403 has the standard error and the permission needed', async () => {
      const response = await readOnly
        .call('post', `${API}/admin/organizations`, {
          name: 'X',
          unitName: 'Y',
          owner: { name: 'Z', email: uniqueEmail('x') },
        })
        .expect(403);
      expect(errorOf(response)).toMatchObject({
        code: 'FORBIDDEN',
        details: { requiredPermissions: ['organizations:create'] },
      });
    });

    it('CA-01.04 still holds: a panel session never reaches the admin routes', async () => {
      const tenant = await createTenant(platform, 'RBAC painel');
      await setPassword(platform, { owner: tenant.ownerId });
      const owner = await platform.user.findUniqueOrThrow({ where: { id: tenant.ownerId } });
      const { jar } = await loginOwner(app, owner.email);
      await request(app.getHttpServer())
        .get(`${API}/admin/organizations`)
        .set('Cookie', jar.header())
        .expect(401);
    });
  });

  describe('CA-02.01 and CA-02.02', () => {
    it('CA-02.01: Leitura sees organizations and metrics, but cannot create, suspend or impersonate', async () => {
      const tenant = await createTenant(platform, 'CA-02.01');
      await readOnly.call('get', `${API}/admin/organizations`).expect(200);
      await readOnly.call('get', `${API}/admin/organizations/${tenant.organizationId}`).expect(200);
      await readOnly.call('get', `${API}/admin/metrics/overview`).expect(200);
      await readOnly.call('get', `${API}/admin/metrics/organizations`).expect(200);
      await readOnly
        .call('post', `${API}/admin/organizations`, {
          name: 'Barraca',
          unitName: 'Unidade',
          owner: { name: 'Dono', email: uniqueEmail('ca0201') },
        })
        .expect(403);
      await readOnly
        .call('post', `${API}/admin/organizations/${tenant.organizationId}/suspend`, {
          reason: 'Inadimplente',
        })
        .expect(403);
      await readOnly
        .call('post', `${API}/admin/impersonations`, {
          organizationId: tenant.organizationId,
          reason: 'Suporte ao cardápio',
        })
        .expect(403);
      await readOnly.call('get', `${API}/admin/emails/usage`).expect(403);
    });

    it('CA-02.02: Leitura + extra organizations:create creates organizations, and nothing else', async () => {
      const client = await adminClient(app, platform, {
        roles: ['read_only'],
        permissions: ['organizations:create'],
      });
      const created = await client
        .call('post', `${API}/admin/organizations`, {
          name: 'Barraca Avulsa',
          unitName: 'Feira',
          owner: { name: 'Dona Avulsa', email: uniqueEmail('ca0202') },
        })
        .expect(201);
      const organizationId = (created.body as { id: string }).id;
      await client
        .call('post', `${API}/admin/organizations/${organizationId}/suspend`, {
          reason: 'Teste de permissão',
        })
        .expect(403);
      await client
        .call('patch', `${API}/admin/organizations/${organizationId}`, { name: 'Outro' })
        .expect(403);
      await client.call('get', `${API}/admin/users`).expect(403);
    });
  });

  describe('users of the admin', () => {
    it('invites a user with roles and extra permissions: admin_invite e-mail and audit', async () => {
      const email = uniqueEmail('Convidado');
      const response = await superAdmin
        .call('post', `${API}/admin/users`, {
          name: 'Pessoa Convidada',
          email: email.toUpperCase(),
          roleIds: [await roleId('support')],
          permissions: ['audit:read'],
        })
        .expect(201);
      const user = response.body as { id: string; permissions: string[]; invitePending: boolean };
      expect(response.body).toMatchObject({
        email: email.toLowerCase(),
        invitePending: true,
        roles: [{ systemKey: 'support' }],
        extraPermissions: ['audit:read'],
      });
      expect(user.permissions).toContain('impersonation:use');
      expect(user.permissions).toContain('audit:read');
      await expect(
        platform.emailLog.count({ where: { to: email.toLowerCase(), type: 'admin_invite' } }),
      ).resolves.toBe(1);
      await expect(
        platform.auditLog.findFirst({
          where: { action: 'platform_admin.created', entityId: user.id },
        }),
      ).resolves.toMatchObject({ actorType: 'platform_admin', actorId: superAdmin.id });
      await superAdmin.call('post', `${API}/admin/users`, { name: 'Outra', email }).expect(409);
      const unknownRole = await superAdmin
        .call('post', `${API}/admin/users`, {
          name: 'Outra',
          email: uniqueEmail('outra'),
          roleIds: [crypto.randomUUID()],
        })
        .expect(400);
      expect(errorOf(unknownRole).code).toBe('VALIDATION_FAILED');
    });

    it('lists and searches users; sends the invite again or a reset link', async () => {
      const target = await adminClient(app, platform, { roles: ['finance'] });
      const list = await superAdmin
        .call('get', `${API}/admin/users?search=${encodeURIComponent(target.email)}`)
        .expect(200);
      expect((list.body as { data: { id: string }[] }).data.map((item) => item.id)).toEqual([
        target.id,
      ]);
      const link = await superAdmin
        .call('post', `${API}/admin/users/${target.id}/password-link`)
        .expect(202);
      expect(link.body).toMatchObject({ kind: 'reset' });
      await expect(
        platform.emailLog.count({ where: { to: target.email, type: 'admin_password_reset' } }),
      ).resolves.toBe(1);
    });

    it('RN-02.08: a change of role applies on the next request of the user', async () => {
      const user = await adminClient(app, platform, { roles: ['read_only'] });
      await user.call('get', `${API}/admin/audit-logs`).expect(403);
      await superAdmin
        .call('put', `${API}/admin/users/${user.id}/permissions`, { permissions: ['audit:read'] })
        .expect(200);
      await user.call('get', `${API}/admin/audit-logs`).expect(200);
      await superAdmin
        .call('put', `${API}/admin/users/${user.id}/roles`, { roleIds: [] })
        .expect(200);
      await user.call('get', `${API}/admin/organizations`).expect(403);
      await expect(
        platform.auditLog.count({
          where: {
            entityId: user.id,
            action: { in: ['platform_admin.roles_changed', 'platform_admin.permissions_changed'] },
          },
        }),
      ).resolves.toBe(2);
    });

    it('RN-02.06: nobody changes their own roles, permissions or situation', async () => {
      for (const [method, path, body] of [
        ['put', `${API}/admin/users/${superAdmin.id}/roles`, { roleIds: [] }],
        ['put', `${API}/admin/users/${superAdmin.id}/permissions`, { permissions: [] }],
        ['patch', `${API}/admin/users/${superAdmin.id}`, { active: false }],
      ] as const) {
        const response = await superAdmin.call(method, path, body).expect(403);
        expect(errorOf(response).code).toBe('CANNOT_CHANGE_OWN_ACCESS');
      }
      // The own name is fine.
      await superAdmin
        .call('patch', `${API}/admin/users/${superAdmin.id}`, { name: 'Novo Nome' })
        .expect(200);
    });

    it('deactivating ends the sessions of the user at once', async () => {
      const user = await adminClient(app, platform, { roles: ['support'] });
      await user.call('get', `${API}/admin/organizations`).expect(200);
      await superAdmin
        .call('patch', `${API}/admin/users/${user.id}`, { active: false })
        .expect(200);
      await user.call('get', `${API}/admin/organizations`).expect(401);
      await expect(
        platform.auditLog.findFirst({
          where: { action: 'platform_admin.deactivated', entityId: user.id },
        }),
      ).resolves.not.toBeNull();
    });

    it('CA-02.03: refuses to deactivate, or remove the role of, the last active Super admin (RN-02.05)', async () => {
      // A manager that is not Super admin, and one single active Super admin in the database.
      const manager = await adminClient(app, platform, {
        roles: ['read_only'],
        permissions: ['admin.users:manage'],
      });
      const last = await adminClient(app, platform);
      const others = await platform.platformAdmin.findMany({
        where: {
          id: { not: last.id },
          active: true,
          roles: { some: { role: { systemKey: SUPER_ADMIN_KEY } } },
        },
        select: { id: true },
      });
      const otherIds = others.map((row) => row.id);
      await platform.platformAdmin.updateMany({
        where: { id: { in: otherIds } },
        data: { active: false },
      });
      try {
        const deactivate = await manager
          .call('patch', `${API}/admin/users/${last.id}`, { active: false })
          .expect(409);
        expect(errorOf(deactivate).code).toBe('LAST_SUPER_ADMIN');
        const removeRole = await manager
          .call('put', `${API}/admin/users/${last.id}/roles`, {
            roleIds: [await roleId('support')],
          })
          .expect(409);
        expect(errorOf(removeRole).code).toBe('LAST_SUPER_ADMIN');
        await last.call('get', `${API}/admin/organizations`).expect(200);

        // With a second active Super admin, the change is allowed.
        await platform.platformAdmin.update({
          where: { id: otherIds[0] ?? superAdmin.id },
          data: { active: true },
        });
        await manager
          .call('put', `${API}/admin/users/${last.id}/roles`, {
            roleIds: [await roleId('support')],
          })
          .expect(200);
      } finally {
        await platform.platformAdmin.updateMany({
          where: { id: { in: otherIds } },
          data: { active: true },
        });
      }
    });
  });

  describe('custom roles (RN-02.07)', () => {
    it('creates, renames, changes and removes a custom role; refuses removal while in use', async () => {
      const name = `Papel ${crypto.randomUUID().slice(0, 6)}`;
      const created = await superAdmin
        .call('post', `${API}/admin/roles`, {
          name,
          description: 'Só auditoria',
          permissions: ['audit:read', 'audit:read'],
        })
        .expect(201);
      const role = created.body as { id: string };
      expect(created.body).toMatchObject({
        name,
        isSystem: false,
        permissions: ['audit:read'],
        editable: true,
        deletable: true,
      });
      await superAdmin.call('post', `${API}/admin/roles`, { name, permissions: [] }).expect(409);

      const renamed = await superAdmin
        .call('patch', `${API}/admin/roles/${role.id}`, {
          name: `${name} 2`,
          permissions: ['metrics:read', 'audit:read'],
        })
        .expect(200);
      expect(renamed.body).toMatchObject({
        name: `${name} 2`,
        permissions: ['metrics:read', 'audit:read'],
      });

      const user = await adminClient(app, platform, { roles: [] });
      await superAdmin
        .call('put', `${API}/admin/users/${user.id}/roles`, { roleIds: [role.id] })
        .expect(200);
      await user.call('get', `${API}/admin/audit-logs`).expect(200);
      const inUse = await superAdmin.call('delete', `${API}/admin/roles/${role.id}`).expect(409);
      expect(errorOf(inUse).code).toBe('ROLE_IN_USE');

      await superAdmin
        .call('put', `${API}/admin/users/${user.id}/roles`, { roleIds: [] })
        .expect(200);
      await superAdmin.call('delete', `${API}/admin/roles/${role.id}`).expect(204);
      await expect(
        platform.auditLog.count({
          where: {
            entityId: role.id,
            action: { in: ['role.created', 'role.updated', 'role.deleted'] },
          },
        }),
      ).resolves.toBe(3);
    });

    it('other system roles keep their name but may have permissions changed', async () => {
      const finance = await roleId('finance');
      const rename = await superAdmin
        .call('patch', `${API}/admin/roles/${finance}`, { name: 'Contas' })
        .expect(409);
      expect(errorOf(rename).code).toBe('ROLE_NOT_EDITABLE');
      const before = [...(SYSTEM_ROLES.finance.permissions as Permission[])];
      await superAdmin
        .call('patch', `${API}/admin/roles/${finance}`, { permissions: [...before, 'emails:read'] })
        .expect(200);
      await superAdmin
        .call('patch', `${API}/admin/roles/${finance}`, { permissions: before })
        .expect(200);
    });
  });
});
