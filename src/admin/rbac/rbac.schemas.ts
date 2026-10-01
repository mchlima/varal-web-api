import { z } from 'zod';

import { PermissionSchema } from './permissions.js';

export const PermissionInfoSchema = z
  .object({ key: PermissionSchema, description: z.string() })
  .meta({ id: 'PermissionInfo' });

export const PermissionCatalogSchema = z
  .object({ data: z.array(PermissionInfoSchema) })
  .meta({ id: 'PermissionCatalog', description: 'Catálogo de permissões (RN-02.03).' });

export const RoleSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string(),
    isSystem: z.boolean(),
    systemKey: z
      .enum(['super_admin', 'support', 'finance', 'read_only'])
      .nullable()
      .meta({ description: 'Chave dos papéis do sistema; `null` nos personalizados.' }),
    /** Super admin: every permission of the catalog (RN-02.04). */
    permissions: z.array(PermissionSchema),
    editable: z
      .boolean()
      .meta({ description: 'Falso no Super admin, que não pode ser editado (RN-02.04).' }),
    deletable: z.boolean().meta({
      description:
        'Só papéis personalizados sem usuários podem ser excluídos (RN-02.04, RN-02.07).',
    }),
    userCount: z.number().int(),
  })
  .meta({ id: 'Role' });

export const RoleListSchema = z.object({ data: z.array(RoleSchema) }).meta({ id: 'RoleList' });

const RoleNameSchema = z
  .string({ error: 'Informe o nome do papel.' })
  .trim()
  .min(2, { error: 'O nome precisa ter pelo menos 2 caracteres.' })
  .max(60, { error: 'O nome pode ter no máximo 60 caracteres.' });

const RoleDescriptionSchema = z
  .string()
  .trim()
  .max(300, { error: 'A descrição pode ter no máximo 300 caracteres.' });

const PermissionListSchema = z.array(PermissionSchema).max(100);

export const CreateRoleRequestSchema = z
  .object({
    name: RoleNameSchema,
    description: RoleDescriptionSchema.default(''),
    permissions: PermissionListSchema,
  })
  .meta({ id: 'CreateRoleRequest' });

export const UpdateRoleRequestSchema = z
  .object({
    name: RoleNameSchema.optional(),
    description: RoleDescriptionSchema.optional(),
    permissions: PermissionListSchema.optional(),
  })
  .meta({ id: 'UpdateRoleRequest' });

export type RoleResponse = z.infer<typeof RoleSchema>;
export type CreateRoleRequest = z.infer<typeof CreateRoleRequestSchema>;
export type UpdateRoleRequest = z.infer<typeof UpdateRoleRequestSchema>;
