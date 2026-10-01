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
  // ----------------------------------------------------------------------------------------------
  // Spec 05: discounts, payments and cash registers
  // ----------------------------------------------------------------------------------------------
  /** RN-05.06, CA-05.08: no cash register open in the shift. */
  NO_CASH_REGISTER_OPEN: {
    status: 409,
    message: 'Abra um caixa para receber.',
  },
  /** RN-05.05: more than one register open; choose one (`details.cashRegisters`). */
  CASH_REGISTER_REQUIRED: {
    status: 409,
    message: 'Há mais de um caixa aberto. Escolha o caixa que recebe o pagamento.',
  },
  /** RN-05.05: the register is not of the shift of the tab. */
  INVALID_CASH_REGISTER: {
    status: 400,
    message: 'Este caixa não existe ou não é do turno desta comanda.',
  },
  /** RN-05.13, RN-05.21: a closed register takes no payment, reversal nor movement. */
  CASH_REGISTER_CLOSED: {
    status: 409,
    message: 'Este caixa já foi fechado e não aceita mais lançamentos.',
  },
  /** RN-05.17: another register of the shift already has this name. */
  CASH_REGISTER_NAME_TAKEN: {
    status: 409,
    message: 'Já existe um caixa com este nome neste turno.',
  },
  /** RN-05.18: a withdrawal never goes past the cash expected in the drawer (`details`). */
  WITHDRAWAL_EXCEEDS_CASH: {
    status: 409,
    message: 'A sangria passa do dinheiro esperado na gaveta.',
  },
  /** RN-05.20, CA-05.07: a difference needs a note (`details.counts`). */
  CLOSING_NOTE_REQUIRED: {
    status: 400,
    message: 'Há diferença na conferência. Escreva uma observação para fechar o caixa.',
  },
  /** RN-05.08, CA-05.03: pix and cards never go past the balance (`details.balanceCents`). */
  PAYMENT_EXCEEDS_BALANCE: {
    status: 409,
    message: 'O valor passa do saldo da comanda.',
  },
  /** RN-05.11: the tab has nothing left to pay (`details.balanceCents`). */
  TAB_NOTHING_TO_PAY: {
    status: 409,
    message: 'Esta comanda não tem saldo a receber.',
  },
  /** RN-05.12, CA-05.09: "paga antes" payments do not cover the total; nothing was saved. */
  PAYMENT_INSUFFICIENT: {
    status: 409,
    message: 'Os pagamentos não cobrem o total do pedido. Nada foi registrado.',
  },
  /** RN-05.15: the payment was already reversed. */
  PAYMENT_ALREADY_REVERSED: { status: 409, message: 'Este pagamento já foi estornado.' },
  /**
   * RN-05.07: a discount or a canceled item would leave the total below what was already paid
   * (`details.paidCents`, `details.totalCents`). Reverse a payment first.
   */
  TAB_PAYMENTS_EXCEED_TOTAL: {
    status: 409,
    message: 'Os pagamentos já registrados passam do novo total. Estorne um pagamento antes.',
  },
  /** RN-04.12: a tab with payments is not canceled; reverse them first (`details.paymentIds`). */
  TAB_HAS_PAYMENTS: {
    status: 409,
    message: 'Esta comanda tem pagamentos registrados. Estorne os pagamentos antes de cancelar.',
  },
  /**
   * RN-04.28, RN-05.14: a paid tab does not change; reverse the payment first, which takes it back
   * to `closing` (`details.paymentIds`).
   */
  TAB_PAID: {
    status: 409,
    message: 'Esta comanda já foi paga. Estorne o pagamento para alterar os itens.',
  },
  /** RN-04.11: a "paga antes" tab has a single order and is not reopened. */
  TAB_PAY_FIRST: {
    status: 409,
    message: 'Comanda paga antes não recebe novos pedidos. Abra outra comanda.',
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
      'Códigos de erro da operação (specs 04 e 05): turno, comandas, pedidos, itens, descontos, pagamentos e caixas. `SHIFT_OPEN` (spec 03) e `ORGANIZATION_SUSPENDED`/`ORGANIZATION_CANCELED` (spec 02) também aparecem nestas rotas.',
  });
