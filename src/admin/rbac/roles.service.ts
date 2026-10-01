import { Injectable } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service.js';
import { AppError } from '../../errors/app-error.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PlatformPrismaService } from '../../prisma/platform-prisma.service.js';
import { adminError } from '../admin-errors.js';
import {
  normalizePermissions,
  type Permission,
  PERMISSION_CATALOG,
  PERMISSIONS,
  SUPER_ADMIN_KEY,
} from './permissions.js';
import type { CreateRoleRequest, RoleResponse, UpdateRoleRequest } from './rbac.schemas.js';

const ROLE_NAME_TAKEN = 'Já existe um papel com este nome.';

const roleInclude = {
  permissions: { select: { permission: true } },
  _count: { select: { admins: true } },
} as const satisfies Prisma.RoleInclude;

type RoleRow = Prisma.RoleGetPayload<{ include: typeof roleInclude }>;

function toRole(row: RoleRow): RoleResponse {
  const isSuperAdmin = row.systemKey === SUPER_ADMIN_KEY;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    systemKey: (row.systemKey as RoleResponse['systemKey']) ?? null,
    permissions: isSuperAdmin
      ? [...PERMISSIONS]
      : normalizePermissions(row.permissions.map((item) => item.permission)),
    editable: !isSuperAdmin,
    deletable: !row.isSystem && row._count.admins === 0,
    userCount: row._count.admins,
  };
}

function snapshot(role: RoleResponse): Record<string, unknown> {
  return { name: role.name, description: role.description, permissions: role.permissions };
}

/**
 * Roles of the admin (spec 02, section 3; RN-02.04 and RN-02.07).
 *
 * Decisions: system roles are never removed; Super admin is never edited (it always has the whole
 * catalog). The other system roles (Suporte, Financeiro, Leitura) keep their name but may have the
 * description and permissions changed. Custom roles are created, renamed, changed and removed when
 * no user has them. Every change is audited (`role.*`).
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly platform: PlatformPrismaService,
    private readonly audit: AuditService,
  ) {}

  catalog(): { key: Permission; description: string }[] {
    return PERMISSIONS.map((key) => ({ key, description: PERMISSION_CATALOG[key] }));
  }

  async list(): Promise<RoleResponse[]> {
    const rows = await this.platform.role.findMany({
      include: roleInclude,
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
    return rows.map(toRole);
  }

  async create(input: CreateRoleRequest): Promise<RoleResponse> {
    return this.withNameConflict(() =>
      this.platform.$transaction(async (tx) => {
        const role = await tx.role.create({
          data: { name: input.name, description: input.description, isSystem: false },
        });
        await tx.rolePermission.createMany({
          data: normalizePermissions(input.permissions).map((permission) => ({
            roleId: role.id,
            permission,
          })),
        });
        const created = toRole(
          await tx.role.findUniqueOrThrow({ where: { id: role.id }, include: roleInclude }),
        );
        await this.audit.record(tx, {
          action: 'role.created',
          entityType: 'role',
          entityId: role.id,
          organizationId: null,
          after: snapshot(created),
        });
        return created;
      }),
    );
  }

  async update(id: string, input: UpdateRoleRequest): Promise<RoleResponse> {
    return this.withNameConflict(() =>
      this.platform.$transaction(async (tx) => {
        const current = await tx.role.findUnique({ where: { id }, include: roleInclude });
        if (!current) {
          throw AppError.of('NOT_FOUND');
        }
        const before = toRole(current);
        if (!before.editable) {
          throw adminError('ROLE_NOT_EDITABLE', {
            message: 'O papel Super admin tem sempre todas as permissões e não pode ser editado.',
          });
        }
        if (current.isSystem && input.name !== undefined && input.name !== current.name) {
          throw adminError('ROLE_NOT_EDITABLE', {
            message: 'O nome dos papéis do sistema não pode ser trocado.',
          });
        }
        await tx.role.update({
          where: { id },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.description === undefined ? {} : { description: input.description }),
          },
        });
        if (input.permissions !== undefined) {
          const wanted = normalizePermissions(input.permissions);
          await tx.rolePermission.deleteMany({
            where: { roleId: id, permission: { notIn: wanted } },
          });
          await tx.rolePermission.createMany({
            data: wanted.map((permission) => ({ roleId: id, permission })),
            skipDuplicates: true,
          });
        }
        const after = toRole(
          await tx.role.findUniqueOrThrow({ where: { id }, include: roleInclude }),
        );
        await this.audit.record(tx, {
          action: 'role.updated',
          entityType: 'role',
          entityId: id,
          organizationId: null,
          before: snapshot(before),
          after: snapshot(after),
        });
        return after;
      }),
    );
  }

  async remove(id: string): Promise<void> {
    await this.platform.$transaction(async (tx) => {
      const current = await tx.role.findUnique({ where: { id }, include: roleInclude });
      if (!current) {
        throw AppError.of('NOT_FOUND');
      }
      if (current.isSystem) {
        throw adminError('ROLE_NOT_EDITABLE', {
          message: 'Papéis do sistema não podem ser excluídos.',
        });
      }
      // Locks the role so nobody assigns it while it is being removed.
      await tx.$queryRaw`SELECT id FROM roles WHERE id = ${id}::uuid FOR UPDATE`;
      const users = await tx.platformAdminRole.count({ where: { roleId: id } });
      if (users > 0) {
        throw adminError('ROLE_IN_USE', { details: { userCount: users } });
      }
      const before = toRole(current);
      await tx.role.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'role.deleted',
        entityType: 'role',
        entityId: id,
        organizationId: null,
        before: snapshot(before),
      });
    });
  }

  private async withNameConflict<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw AppError.of('ALREADY_EXISTS', { message: ROLE_NAME_TAKEN });
      }
      throw error;
    }
  }
}
