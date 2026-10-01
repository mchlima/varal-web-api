import { Injectable } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service.js';
import { AuthService } from '../../auth/auth.service.js';
import { PasswordLinkService } from '../../auth/password-link.service.js';
import { pageArgs, type Page, type PaginationQuery, toPage } from '../../common/pagination.js';
import { getRequestContext } from '../../context/request-context.js';
import { AppError } from '../../errors/app-error.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PlatformPrismaService } from '../../prisma/platform-prisma.service.js';
import { adminError } from '../admin-errors.js';
import { flagOf } from '../admin-schemas.js';
import { PlatformAdminsService, unknownRolesError } from '../platform-admins.service.js';
import { ADMIN_ACCESS_SELECT, toAdminAccess } from '../rbac/admin-access.js';
import { normalizePermissions, type Permission, SUPER_ADMIN_KEY } from '../rbac/permissions.js';
import type { AdminUser } from './admin-users.schemas.js';

const USER_SELECT = {
  ...ADMIN_ACCESS_SELECT,
  name: true,
  email: true,
  passwordHash: true,
  lastLoginAt: true,
  createdAt: true,
} as const satisfies Prisma.PlatformAdminSelect;

type UserRow = Prisma.PlatformAdminGetPayload<{ select: typeof USER_SELECT }>;

function toAdminUser(row: UserRow): AdminUser {
  const access = toAdminAccess(row);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    active: row.active,
    invitePending: row.passwordHash === null,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    roles: access.roles,
    extraPermissions: access.extraPermissions,
    permissions: access.permissions,
  };
}

/**
 * Users of the admin (spec 02, sections 3 and 10): invite, edit, deactivate, roles, extra permissions
 * and password links. Every change is audited (`platform_admin.*`).
 *
 * - RN-02.05: deactivating the last active Super admin, or removing its role, is refused
 *   (`LAST_SUPER_ADMIN`). Those changes take a lock on the Super admin role, so two of them never
 *   race past the check.
 * - RN-02.06: nobody changes their own roles, extra permissions or active flag
 *   (`CANNOT_CHANGE_OWN_ACCESS`).
 * - Deactivating ends every session of the user at once (spec 01, section 7.2).
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly platform: PlatformPrismaService,
    private readonly admins: PlatformAdminsService,
    private readonly auth: AuthService,
    private readonly passwordLinks: PasswordLinkService,
    private readonly audit: AuditService,
  ) {}

  async list(
    query: PaginationQuery & { search?: string | undefined; active?: 'true' | 'false' | undefined },
  ): Promise<Page<AdminUser>> {
    const args = pageArgs(query);
    const active = flagOf(query.active);
    const search = query.search;
    const filters: Prisma.PlatformAdminWhereInput = {
      ...(active === undefined ? {} : { active }),
      ...(!search
        ? {}
        : {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search.toLowerCase() } },
            ],
          }),
    };
    const rows = await this.platform.platformAdmin.findMany({
      ...args,
      where: { AND: [filters, args.where] },
      select: USER_SELECT,
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toAdminUser), nextCursor: page.nextCursor };
  }

  async get(id: string): Promise<AdminUser> {
    const row = await this.platform.platformAdmin.findUnique({
      where: { id },
      select: USER_SELECT,
    });
    if (!row) {
      throw AppError.of('NOT_FOUND');
    }
    return toAdminUser(row);
  }

  /** Invite (`POST /admin/users`): the user receives the e-mail to define the password. */
  async invite(input: {
    name: string;
    email: string;
    roleIds: string[];
    permissions: Permission[];
  }): Promise<AdminUser> {
    const created = await this.admins.create(
      { name: input.name, email: input.email },
      { roleIds: input.roleIds, permissions: input.permissions },
    );
    return this.get(created.id);
  }

  async update(
    id: string,
    input: { name?: string | undefined; active?: boolean | undefined },
  ): Promise<AdminUser> {
    const changesAccess = input.active !== undefined;
    if (changesAccess) {
      this.assertNotSelf(id);
    }
    let notify: (() => void) | null = null;
    await this.platform.$transaction(async (tx) => {
      const before = await this.loadForUpdate(tx, id);
      if (input.active === false && before.active && toAdminAccess(before).isSuperAdmin) {
        await this.assertAnotherActiveSuperAdmin(tx, id);
      }
      const updated = await tx.platformAdmin.update({
        where: { id },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.active === undefined ? {} : { active: input.active }),
        },
      });
      const deactivated = before.active && !updated.active;
      await this.audit.record(tx, {
        action: deactivated
          ? 'platform_admin.deactivated'
          : !before.active && updated.active
            ? 'platform_admin.reactivated'
            : 'platform_admin.updated',
        entityType: 'platform_admin',
        entityId: id,
        organizationId: null,
        before: { name: before.name, active: before.active },
        after: { name: updated.name, active: updated.active },
      });
      if (deactivated) {
        const revoked = await this.auth.revokeSessionsInTransaction(
          tx,
          { subjectType: 'platform_admin', subjectId: id, organizationId: null },
          'subject_deactivated',
        );
        notify = revoked.notify;
      }
    });
    (notify as (() => void) | null)?.();
    return this.get(id);
  }

  async setRoles(id: string, requestedRoleIds: string[]): Promise<AdminUser> {
    this.assertNotSelf(id);
    const roleIds = [...new Set(requestedRoleIds)];
    await this.platform.$transaction(async (tx) => {
      const before = await this.loadForUpdate(tx, id);
      const beforeAccess = toAdminAccess(before);
      const roles = await tx.role.findMany({
        where: { id: { in: roleIds } },
        select: { id: true, name: true, systemKey: true },
      });
      if (roles.length !== roleIds.length) {
        throw unknownRolesError();
      }
      const keepsSuperAdmin = roles.some((role) => role.systemKey === SUPER_ADMIN_KEY);
      if (beforeAccess.isSuperAdmin && !keepsSuperAdmin && before.active) {
        await this.assertAnotherActiveSuperAdmin(tx, id);
      }
      await tx.platformAdminRole.deleteMany({
        where: { platformAdminId: id, roleId: { notIn: roleIds } },
      });
      await tx.platformAdminRole.createMany({
        data: roleIds.map((roleId) => ({ platformAdminId: id, roleId })),
        skipDuplicates: true,
      });
      await this.audit.record(tx, {
        action: 'platform_admin.roles_changed',
        entityType: 'platform_admin',
        entityId: id,
        organizationId: null,
        before: { roles: beforeAccess.roles.map((role) => role.name) },
        after: { roles: roles.map((role) => role.name).sort((a, b) => a.localeCompare(b)) },
      });
    });
    return this.get(id);
  }

  async setPermissions(id: string, permissions: Permission[]): Promise<AdminUser> {
    this.assertNotSelf(id);
    const wanted = normalizePermissions(permissions);
    await this.platform.$transaction(async (tx) => {
      const before = await this.loadForUpdate(tx, id);
      await tx.platformAdminPermission.deleteMany({
        where: { platformAdminId: id, permission: { notIn: wanted } },
      });
      await tx.platformAdminPermission.createMany({
        data: wanted.map((permission) => ({ platformAdminId: id, permission })),
        skipDuplicates: true,
      });
      await this.audit.record(tx, {
        action: 'platform_admin.permissions_changed',
        entityType: 'platform_admin',
        entityId: id,
        organizationId: null,
        before: { extraPermissions: toAdminAccess(before).extraPermissions },
        after: { extraPermissions: wanted },
      });
    });
    return this.get(id);
  }

  /**
   * Sends the invite again (no password yet) or a reset link (spec 01, section 7.4). The link goes
   * only by e-mail; RN-01.02 limits resets to 3 per hour.
   */
  async sendPasswordLink(id: string): Promise<{ kind: 'invite' | 'reset'; expiresAt: string }> {
    return this.platform.$transaction(async (tx) => {
      const admin = await tx.platformAdmin.findUnique({ where: { id } });
      if (!admin) {
        throw AppError.of('NOT_FOUND');
      }
      if (!admin.active) {
        throw AppError.of('CONFLICT', {
          message: 'Este usuário está desativado. Reative-o antes de enviar um link.',
        });
      }
      const kind = admin.passwordHash === null ? 'invite' : 'reset';
      const link =
        kind === 'invite'
          ? await this.passwordLinks.issueAdminInvite(tx, id)
          : await this.passwordLinks.issueAdminPasswordReset(tx, id);
      return { kind, expiresAt: link.expiresAt.toISOString() };
    });
  }

  private assertNotSelf(id: string): void {
    if (getRequestContext()?.auth?.actor.id === id) {
      throw adminError('CANNOT_CHANGE_OWN_ACCESS');
    }
  }

  private async loadForUpdate(tx: Prisma.TransactionClient, id: string): Promise<UserRow> {
    const row = await tx.platformAdmin.findUnique({ where: { id }, select: USER_SELECT });
    if (!row) {
      throw AppError.of('NOT_FOUND');
    }
    return row;
  }

  /** RN-02.05, under a lock on the Super admin role (serializes the changes that could break it). */
  private async assertAnotherActiveSuperAdmin(
    tx: Prisma.TransactionClient,
    exceptAdminId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM roles WHERE system_key = ${SUPER_ADMIN_KEY} FOR UPDATE`;
    const others = await tx.platformAdmin.count({
      where: {
        id: { not: exceptAdminId },
        active: true,
        roles: { some: { role: { systemKey: SUPER_ADMIN_KEY } } },
      },
    });
    if (others === 0) {
      throw adminError('LAST_SUPER_ADMIN');
    }
  }
}
