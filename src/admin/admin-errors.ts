import { z } from 'zod';

import { AppError } from '../errors/app-error.js';

/**
 * Error codes of the platform admin (spec 02). Messages in pt-BR, safe to show. Published in the
 * OpenAPI as `AdminErrorCode`. Missing permissions are the generic `FORBIDDEN` (RN-02.01).
 */
export const ADMIN_ERRORS = {
  /** RN-02.05: there is always at least one active Super admin. */
  LAST_SUPER_ADMIN: {
    status: 409,
    message: 'É preciso manter pelo menos um usuário ativo com o papel Super admin.',
  },
  /** RN-02.06: nobody changes their own roles, extra permissions or situation. */
  CANNOT_CHANGE_OWN_ACCESS: {
    status: 403,
    message: 'Você não pode alterar os próprios papéis, permissões ou situação.',
  },
  /** RN-02.04: system roles are never removed, and Super admin is never edited. */
  ROLE_NOT_EDITABLE: { status: 409, message: 'Este papel do sistema não pode ser alterado.' },
  /** RN-02.07: a custom role is removed only when no user has it. */
  ROLE_IN_USE: {
    status: 409,
    message: 'Este papel ainda está atribuído a usuários. Retire-o deles antes de excluir.',
  },
  /** RN-02.10: the e-mail of an owner is unique across organizations. */
  OWNER_EMAIL_TAKEN: { status: 409, message: 'Este e-mail já é de um dono cadastrado no Varal.' },
  OWNER_ALREADY_ACTIVE: {
    status: 409,
    message: 'O dono já definiu a senha. Para um novo acesso, ele pode usar "Esqueci a senha".',
  },
  ORGANIZATION_WITHOUT_OWNER: {
    status: 409,
    message: 'Esta organização não tem um dono ativo.',
  },
  /** RN-02.11 / RN-02.12: e.g. suspending a canceled organization. */
  INVALID_STATUS_TRANSITION: {
    status: 409,
    message: 'Esta mudança de situação não é possível a partir da situação atual.',
  },
  /** RN-02.15: once published, an announcement can only be archived. */
  ANNOUNCEMENT_NOT_EDITABLE: {
    status: 409,
    message: 'Comunicados publicados ou arquivados não podem ser editados.',
  },
  ANNOUNCEMENT_INVALID_TRANSITION: {
    status: 409,
    message: 'Esta ação não é possível na situação atual do comunicado.',
  },
  IMPERSONATION_NOT_ACTIVE: {
    status: 409,
    message: 'Este acesso de suporte já foi encerrado.',
  },
} as const satisfies Record<string, { status: number; message: string }>;

export type AdminErrorCode = keyof typeof ADMIN_ERRORS;

export function adminError(
  code: AdminErrorCode,
  options: { message?: string; details?: Record<string, unknown> } = {},
): AppError {
  const { status, message } = ADMIN_ERRORS[code];
  return new AppError(code, status, options.message ?? message, options.details ?? {});
}

export const AdminErrorCodeSchema = z
  .enum(Object.keys(ADMIN_ERRORS) as [AdminErrorCode, ...AdminErrorCode[]])
  .meta({ id: 'AdminErrorCode', description: 'Códigos de erro do admin da plataforma (spec 02).' });
