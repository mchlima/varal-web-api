import { z } from 'zod';

import { PaginationQuerySchema, pageSchema } from '../../common/pagination.js';
import {
  EmailInputSchema,
  PersonNameSchema,
  QueryFlagSchema,
  SearchSchema,
} from '../admin-schemas.js';
import { PermissionSchema } from '../rbac/permissions.js';

export const AdminRoleRefSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    isSystem: z.boolean(),
    systemKey: z.string().nullable(),
  })
  .meta({ id: 'AdminRoleRef' });

export const AdminUserSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    active: z.boolean(),
    invitePending: z.boolean().meta({ description: 'Ainda não definiu a senha pelo convite.' }),
    lastLoginAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    roles: z.array(AdminRoleRefSchema),
    extraPermissions: z
      .array(PermissionSchema)
      .meta({ description: 'Permissões avulsas, além das dos papéis (RN-02.02).' }),
    permissions: z
      .array(PermissionSchema)
      .meta({ description: 'Permissões efetivas: papéis + avulsas (RN-02.02).' }),
  })
  .meta({ id: 'AdminUser' });

export const AdminUserPageSchema = pageSchema('AdminUserPage', AdminUserSchema);

export const AdminUserListQuerySchema = PaginationQuerySchema.extend({
  search: SearchSchema.meta({ description: 'Parte do nome ou do e-mail.' }),
  active: QueryFlagSchema,
}).meta({ id: 'AdminUserListQuery' });

const RoleIdsSchema = z.array(z.uuid()).max(50);

const PermissionListSchema = z.array(PermissionSchema).max(100);

export const CreateAdminUserRequestSchema = z
  .object({
    name: PersonNameSchema,
    email: EmailInputSchema,
    roleIds: RoleIdsSchema.default([]),
    permissions: PermissionListSchema.default([]),
  })
  .meta({ id: 'CreateAdminUserRequest' });

export const UpdateAdminUserRequestSchema = z
  .object({
    name: PersonNameSchema.optional(),
    active: z
      .boolean()
      .optional()
      .meta({ description: 'Desativar encerra as sessões do usuário na hora.' }),
  })
  .meta({ id: 'UpdateAdminUserRequest' });

export const SetAdminUserRolesRequestSchema = z
  .object({ roleIds: RoleIdsSchema })
  .meta({ id: 'SetAdminUserRolesRequest' });

export const SetAdminUserPermissionsRequestSchema = z
  .object({ permissions: PermissionListSchema })
  .meta({ id: 'SetAdminUserPermissionsRequest' });

export const AdminPasswordLinkSchema = z
  .object({
    kind: z
      .enum(['invite', 'reset'])
      .meta({ description: '`invite` se ainda não definiu a senha; senão `reset`.' }),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminPasswordLink' });

export type AdminUser = z.infer<typeof AdminUserSchema>;
