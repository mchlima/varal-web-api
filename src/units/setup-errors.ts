import { z } from 'zod';

import { AppError } from '../errors/app-error.js';

/**
 * Error codes of the unit setup (spec 03): units, stations, workflow, menu and staff. Messages in
 * pt-BR, safe to show. Published in the OpenAPI as `SetupErrorCode`.
 */
export const SETUP_ERRORS = {
  /** CA-03.03, RN-03.02, RN-03.07: the unit has an open shift. */
  SHIFT_OPEN: {
    status: 409,
    message:
      'A unidade está com um turno aberto. Feche o turno para alterar estações, fluxo ou desativar a unidade.',
  },
  /** RN-03.01: the organization keeps at least one active unit. */
  LAST_ACTIVE_UNIT: {
    status: 409,
    message: 'A organização precisa de pelo menos uma unidade ativa.',
  },
  UNIT_NAME_TAKEN: { status: 409, message: 'Já existe uma unidade com este nome.' },
  STATION_NAME_TAKEN: { status: 409, message: 'Já existe uma estação com este nome na unidade.' },
  CATEGORY_NAME_TAKEN: {
    status: 409,
    message: 'Já existe uma categoria com este nome na unidade.',
  },
  /** CA-03.07: usernames are unique in the organization, ignoring case. */
  USERNAME_TAKEN: { status: 409, message: 'Este nome de usuário já está em uso.' },
  /** RN-03.04: at least one active `counter` and one active `queue` station. */
  STATION_KIND_REQUIRED: {
    status: 409,
    message: 'A unidade precisa de pelo menos uma estação de balcão e uma de fila ativas.',
  },
  /** A station used by the workflow, a category or a product cannot be deactivated or retyped. */
  STATION_IN_USE: {
    status: 409,
    message:
      'Esta estação está em uso no fluxo, em uma categoria ou em um produto. Troque a estação deles antes.',
  },
  /** CA-03.02, RN-03.05, RN-03.06: `details.issues` lists each problem. */
  INVALID_WORKFLOW: {
    status: 400,
    message: 'O fluxo de etapas tem problemas. Confira e salve de novo.',
  },
  /** RN-03.08: the preparation station must be an active `queue` station of the same unit. */
  INVALID_PREP_STATION: {
    status: 400,
    message: 'A estação de preparo precisa ser uma estação de fila ativa da mesma unidade.',
  },
  /** A station, category or unit sent in the body is not of this unit (or does not exist). */
  INVALID_REFERENCE: {
    status: 400,
    message: 'Um dos itens escolhidos não existe ou não pertence a esta unidade.',
  },
  /** Reordering must list exactly the items of the list, once each. */
  INVALID_ORDER: {
    status: 400,
    message: 'A nova ordem precisa conter todos os itens da lista, uma vez cada.',
  },
  /** RN-03.13: 0 ≤ minimum ≤ maximum and maximum ≥ 1. */
  INVALID_MODIFIER_LIMITS: {
    status: 400,
    message: 'O mínimo de escolhas precisa ser de 0 até o máximo, e o máximo pelo menos 1.',
  },
} as const satisfies Record<string, { status: number; message: string }>;

export type SetupErrorCode = keyof typeof SETUP_ERRORS;

export function setupError(code: SetupErrorCode, details: Record<string, unknown> = {}): AppError {
  const { status, message } = SETUP_ERRORS[code];
  return new AppError(code, status, message, details);
}

export const SetupErrorCodeSchema = z
  .enum(Object.keys(SETUP_ERRORS) as [SetupErrorCode, ...SetupErrorCode[]])
  .meta({
    id: 'SetupErrorCode',
    description:
      'Códigos de erro da configuração da unidade (spec 03): unidades, estações, fluxo, cardápio e colaboradores.',
  });
