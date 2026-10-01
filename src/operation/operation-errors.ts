import { z } from 'zod';

import { AppError } from '../errors/app-error.js';

/**
 * Error codes of the operation (spec 04): shifts, tabs, orders and items. Messages in pt-BR, safe
 * to show. Published in the OpenAPI as `OperationErrorCode`.
 */
export const OPERATION_ERRORS = {
  /** CA-04.01, RN-04.01: the unit already has an open shift. */
  SHIFT_ALREADY_OPEN: { status: 409, message: 'Esta unidade já está com um turno aberto.' },
  /** RN-04.03: shifts are not opened in an inactive unit. */
  UNIT_INACTIVE: {
    status: 409,
    message: 'Esta unidade está desativada. Ative-a para abrir turno.',
  },
  /** RN-04.08: a closed shift accepts no change. */
  SHIFT_CLOSED: { status: 409, message: 'Este turno já foi fechado e não aceita alterações.' },
  /**
   * CA-04.09, RN-04.07: tabs still `open`/`closing` (`details.tabs`) or cash registers still open
   * (`details.cashRegisters`, spec 05).
   */
  SHIFT_HAS_PENDING_ITEMS: {
    status: 409,
    message:
      'Ainda há comandas ou caixas em aberto neste turno. Resolva as pendências para fechar.',
  },
  /** RN-04.06: a product of the price table is not of the unit of the shift (`details.productIds`). */
  INVALID_SHIFT_PRICE: {
    status: 400,
    message: 'Um dos produtos da tabela de preços não existe ou não é desta unidade.',
  },
  /** RN-04.13: orders and "pedir a conta" only on an `open` tab. */
  TAB_NOT_OPEN: {
    status: 409,
    message: 'Esta comanda não está aberta. Reabra a comanda para lançar pedidos.',
  },
  /** RN-04.12: only a tab in `closing` is reopened. */
  TAB_NOT_CLOSING: { status: 409, message: 'Esta comanda não está em fechamento.' },
  /** RN-04.12, RN-04.28: the tab is already paid, on credit, settled or canceled. */
  TAB_CLOSED: {
    status: 409,
    message: 'Esta comanda já foi fechada e não pode ser alterada.',
  },
  /** RN-04.12: a tab is canceled only when every item is canceled (`details.itemIds`). */
  TAB_HAS_ACTIVE_ITEMS: {
    status: 409,
    message: 'Cancele os itens da comanda antes de cancelá-la.',
  },
  /** Spec 04, section 7: the tab changed on another device (`details.currentVersion`). */
  TAB_CHANGED: {
    status: 409,
    message: 'Outro aparelho alterou esta comanda antes. Confira e tente de novo.',
  },
  /**
   * RN-04.16, RN-04.17, CA-04.06: products inactive, sold out or of another unit, or modifiers
   * missing or invalid. `details.items` points each item (`index` in the body, `reason`).
   */
  ORDER_REJECTED: {
    status: 409,
    message: 'Alguns itens do pedido não podem ser enviados. Confira os itens indicados.',
  },
  /**
   * CA-04.05, spec 04 section 7: another device changed the item first. `details.item` has the
   * current state, `details.currentVersion` its version.
   */
  ITEM_CHANGED: {
    status: 409,
    message: 'Outro aparelho já mudou este item. A tela foi atualizada.',
  },
  /** The item is canceled: it does not change stage nor is canceled again. */
  ITEM_CANCELED: { status: 409, message: 'Este item já foi cancelado.' },
  /** RN-04.20, RN-04.22: no stage after the final one, and no going back from it. */
  ITEM_IN_FINAL_STAGE: { status: 409, message: 'Este item já está na etapa final.' },
  /** RN-04.22: the item is in the first stage. */
  NO_PREVIOUS_STAGE: { status: 409, message: 'Este item já está na primeira etapa.' },
  /** RN-04.24, RN-04.26: the quantity must be from 1 to the quantity of the line. */
  INVALID_QUANTITY: {
    status: 400,
    message: 'A quantidade precisa ser de 1 até a quantidade do item.',
  },
} as const satisfies Record<string, { status: number; message: string }>;

export type OperationErrorCode = keyof typeof OPERATION_ERRORS;

export function operationError(
  code: OperationErrorCode,
  details: Record<string, unknown> = {},
): AppError {
  const { status, message } = OPERATION_ERRORS[code];
  return new AppError(code, status, message, details);
}

export const OperationErrorCodeSchema = z
  .enum(Object.keys(OPERATION_ERRORS) as [OperationErrorCode, ...OperationErrorCode[]])
  .meta({
    id: 'OperationErrorCode',
    description:
      'Códigos de erro da operação (spec 04): turno, comandas, pedidos e itens. `SHIFT_OPEN` (spec 03) e `ORGANIZATION_SUSPENDED`/`ORGANIZATION_CANCELED` (spec 02) também aparecem nestas rotas.',
  });
