import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { PasswordLinkService } from '../auth/password-link.service.js';
import { AppError } from '../errors/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { PlatformPrismaService } from '../prisma/platform-prisma.service.js';
import { EmailInputSchema, PersonNameSchema } from './admin-schemas.js';
import { normalizePermissions, type Permission, SUPER_ADMIN_KEY } from './rbac/permissions.js';

/** Name and e-mail of a new platform admin (spec 02, `platform_admins`). E-mail always lowercase. */
export const NewPlatformAdminSchema = z.object({
  name: PersonNameSchema,
  email: EmailInputSchema,
});

export type NewPlatformAdmin = z.infer<typeof NewPlatformAdminSchema>;

export interface CreatedPlatformAdmin {
  id: string;
  name: string;
  email: string;
  inviteExpiresAt: Date;
  roleNames: string[];
}

export interface PlatformAdminAccessInput {
  /** Roles given at creation (`platform_admin_roles`). */
  roleIds?: readonly string[];
  /** Extra permissions given at creation (`platform_admin_permissions`). */
  permissions?: readonly Permission[];
}

const EMAIL_TAKEN_MESSAGE = 'Já existe um admin da plataforma com este e-mail.';

/** The role was not found: `VALIDATION_FAILED` on `roleIds` (or `role` in the command line). */
export function unknownRolesError(path = 'roleIds'): AppError {
  return AppError.of('VALIDATION_FAILED', {
    details: { fields: [{ path, message: 'Papel não encontrado.' }] },
  });
}

/**
 * Creation of platform admin users, shared by the command line (`src/cli/create-platform-admin.ts`,
 * first access to the admin) and `POST /admin/users` (spec 02). The rest of the user management
 * (roles, deactivation, links) is in `AdminUsersService`.
 */
@Injectable()
export class PlatformAdminsService {
  constructor(
    private readonly platform: PlatformPrismaService,
    private readonly passwordLinks: PasswordLinkService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates an active admin without a password and, in the same transaction, the roles and extra
   * permissions, the invite (7 days) with its `admin_invite` e-mail queued (spec 01, sections 7.4 and
   * 9) and the audit row (section 8). Throws `ALREADY_EXISTS` (409) when the e-mail is taken and
   * `VALIDATION_FAILED` for unknown roles. The invite link is never returned.
   * `source` goes to the audit metadata (e.g. `cli`), to tell where a system action came from.
   */
  async create(
    input: NewPlatformAdmin,
    access: PlatformAdminAccessInput = {},
    options: { source?: string } = {},
  ): Promise<CreatedPlatformAdmin> {
    const { name, email } = NewPlatformAdminSchema.parse(input);
    const roleIds = [...new Set(access.roleIds ?? [])];
    const permissions = normalizePermissions(access.permissions ?? []);
    try {
      return await this.platform.$transaction(async (tx) => {
        const existing = await tx.platformAdmin.findUnique({
          where: { email },
          select: { id: true },
        });
        if (existing) {
          throw AppError.of('ALREADY_EXISTS', { message: EMAIL_TAKEN_MESSAGE });
        }
        const roles = await tx.role.findMany({
          where: { id: { in: roleIds } },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        });
        if (roles.length !== roleIds.length) {
          throw unknownRolesError();
        }
        const admin = await tx.platformAdmin.create({
          data: { name, email, active: true, passwordHash: null },
        });
        await tx.platformAdminRole.createMany({
          data: roles.map((role) => ({ platformAdminId: admin.id, roleId: role.id })),
        });
        await tx.platformAdminPermission.createMany({
          data: permissions.map((permission) => ({ platformAdminId: admin.id, permission })),
        });
        await this.audit.record(tx, {
          action: 'platform_admin.created',
          entityType: 'platform_admin',
          entityId: admin.id,
          organizationId: null,
          after: {
            name: admin.name,
            email: admin.email,
            active: admin.active,
            roles: roles.map((role) => role.name),
            extraPermissions: permissions,
          },
          ...(options.source ? { metadata: { source: options.source } } : {}),
        });
        const invite = await this.passwordLinks.issueAdminInvite(tx, admin.id);
        return {
          id: admin.id,
          name: admin.name,
          email: admin.email,
          inviteExpiresAt: invite.expiresAt,
          roleNames: roles.map((role) => role.name),
        };
      });
    } catch (error) {
      // Two creations racing for the same e-mail: the unique index decides.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw AppError.of('ALREADY_EXISTS', { message: EMAIL_TAKEN_MESSAGE });
      }
      throw error;
    }
  }

  /**
   * Roles of an admin created by the command line. With `--role <name>` (case-insensitive), that
   * role. Without it: Super admin when there is no active Super admin yet (the first admin, so
   * RN-02.05 holds from the start); otherwise no role, to be given in the users screen.
   */
  async resolveCliRoles(roleName: string | undefined): Promise<string[]> {
    if (roleName !== undefined) {
      const role = await this.platform.role.findFirst({
        where: { name: { equals: roleName.trim(), mode: 'insensitive' } },
        select: { id: true },
      });
      if (!role) {
        throw unknownRolesError('role');
      }
      return [role.id];
    }
    const activeSuperAdmins = await this.platform.platformAdmin.count({
      where: { active: true, roles: { some: { role: { systemKey: SUPER_ADMIN_KEY } } } },
    });
    if (activeSuperAdmins > 0) {
      return [];
    }
    const superAdmin = await this.platform.role.findUniqueOrThrow({
      where: { systemKey: SUPER_ADMIN_KEY },
      select: { id: true },
    });
    return [superAdmin.id];
  }
}
