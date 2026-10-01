import { z } from 'zod';

/**
 * Permission catalog of the platform admin (spec 02, section 3.2). Fixed in code and published in the
 * OpenAPI as the enum `Permission` (RN-02.03), from which `varal-admin-web` reads it. A new permission
 * arrives by deploy; roles and assignments are data.
 *
 * The value is the pt-BR description shown in the admin (`GET /admin/permissions`).
 */
export const PERMISSION_CATALOG = {
  'admin.users:manage':
    'Convidar, editar e desativar usuários do admin; atribuir papéis e permissões avulsas',
  'admin.roles:manage': 'Criar, editar e excluir papéis personalizados',
  'organizations:read': 'Ver a lista e os detalhes das organizações',
  'organizations:create': 'Criar organização com unidade e convite do dono',
  'organizations:update': 'Editar o nome, reenviar o convite do dono e trocar o e-mail do dono',
  'organizations:suspend': 'Suspender e reativar organizações',
  'subscriptions:update': 'Mudar a situação da assinatura',
  'announcements:read': 'Ver comunicados e leituras',
  'announcements:manage': 'Criar, editar, agendar, publicar e arquivar comunicados',
  'metrics:read': 'Ver métricas',
  'impersonation:use': 'Entrar como o dono de uma organização',
  'emails:read': 'Ver consumo e histórico de e-mails',
  'audit:read': 'Consultar a auditoria',
} as const satisfies Record<string, string>;

export type Permission = keyof typeof PERMISSION_CATALOG;

export const PERMISSIONS = Object.keys(PERMISSION_CATALOG) as [Permission, ...Permission[]];

const PERMISSION_SET = new Set<string>(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

export const PermissionSchema = z.enum(PERMISSIONS).meta({
  id: 'Permission',
  description:
    'Permissão do admin da plataforma (`recurso:ação`, spec 02, seção 3.2). Catálogo fixo no código da API (RN-02.03).',
});

/** Keys of the system roles (`roles.system_key`), created by the migration (RN-02.04). */
export const SYSTEM_ROLE_KEYS = ['super_admin', 'support', 'finance', 'read_only'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export const SUPER_ADMIN_KEY: SystemRoleKey = 'super_admin';
export const SUPER_ADMIN_NAME = 'Super admin';

/**
 * System roles as the migration creates them (table of section 3.2). Super admin has no stored
 * permissions: it always has the whole catalog, including permissions created later (RN-02.04).
 * The seed and an integration test check that the database matches this table.
 */
export const SYSTEM_ROLES: Record<
  SystemRoleKey,
  { name: string; permissions: readonly Permission[] | 'all' }
> = {
  super_admin: { name: SUPER_ADMIN_NAME, permissions: 'all' },
  support: {
    name: 'Suporte',
    permissions: [
      'organizations:read',
      'organizations:create',
      'organizations:update',
      'announcements:read',
      'announcements:manage',
      'metrics:read',
      'impersonation:use',
      'emails:read',
    ],
  },
  finance: {
    name: 'Financeiro',
    permissions: [
      'organizations:read',
      'organizations:suspend',
      'subscriptions:update',
      'announcements:read',
      'metrics:read',
    ],
  },
  read_only: {
    name: 'Leitura',
    permissions: ['organizations:read', 'announcements:read', 'metrics:read'],
  },
};

/** Catalog order, without duplicates and without keys removed from the catalog. */
export function normalizePermissions(values: Iterable<string>): Permission[] {
  const wanted = new Set(values);
  return PERMISSIONS.filter((permission) => wanted.has(permission));
}
