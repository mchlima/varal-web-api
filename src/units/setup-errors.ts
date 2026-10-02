import { z } from 'zod';

import { AppError } from '../errors/app-error.js';

/**
 * Error codes of the unit setup (spec 03): units, stations, workflow, menu and staff. Messages in
 * pt-BR, safe to show. Published in the OpenAPI as `SetupErrorCode`.
 */
export const SETUP_ERRORS = {
  /**
   * CA-03.03, RN-03.02, RN-03.07: the unit has an open cash register (spec 05). Also RN-05.27: an open
   * register is not deactivated.
   */
  CASH_REGISTER_OPEN: {
    status: 409,
    message:
      'Há um caixa aberto nesta unidade. Feche o caixa para alterar estações, fluxo, desativar a unidade ou o caixa.',
  },
  /** RN-03.07, CA-03.03: items still in non-final stages of open tabs (`details.itemCount`). */
  ITEMS_IN_PROGRESS: {
    status: 409,
    message:
      'Ainda há itens em preparo nas comandas abertas. Conclua os itens para alterar estações ou fluxo.',
  },
  /** RN-03.02: tabs still `open`/`closing` in the unit (`details.tabCount`). */
  UNIT_HAS_OPEN_TABS: {
    status: 409,
    message:
      'Ainda há comandas abertas nesta unidade. Feche ou cancele as comandas para desativá-la.',
  },
  /** RN-03.25, CA-03.12: 1 ≤ atenção < atraso ≤ 240. */
  INVALID_TIME_LIMITS: {
    status: 400,
    message:
      'O tempo de atenção precisa ser de 1 minuto até 1 minuto antes do atraso (máximo 240).',
  },
  /** RN-03.20, CA-03.10: another list of the unit already has this name. */
  PRICE_LIST_NAME_TAKEN: {
    status: 409,
    message: 'Já existe uma tabela de preço com este nome na unidade.',
  },
  /** RN-03.20, CA-03.10: "Normal" is the normal price of the menu. */
  PRICE_LIST_NAME_RESERVED: {
    status: 409,
    message: 'O nome "Normal" é reservado para o preço normal do cardápio. Escolha outro nome.',
  },
  /**
   * RN-03.23, CA-03.10: the current list of the unit, or the list of a scheduled or running event,
   * is not deactivated (`details.reason`: `current` or `event`).
   */
  PRICE_LIST_IN_USE: {
    status: 409,
    message:
      'Esta tabela está em uso (é a vigente ou a de um evento agendado ou em andamento) e não pode ser desativada.',
  },
  /** RN-05.17: another register of the unit already has this name. */
  CASH_REGISTER_NAME_TAKEN: {
    status: 409,
    message: 'Já existe um caixa com este nome nesta unidade.',
  },
  /** RN-05.17, CA-05.14: the unit keeps at least one active register. */
  LAST_ACTIVE_CASH_REGISTER: {
    status: 409,
    message: 'A unidade precisa de pelo menos um caixa ativo.',
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
      'Códigos de erro da configuração da unidade (spec 03): unidades, estações, fluxo, cardápio, tabelas de preço, colaboradores e o cadastro dos caixas (spec 05).',
  });
