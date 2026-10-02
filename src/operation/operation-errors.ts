import { z } from 'zod';

import { AppError } from '../errors/app-error.js';

/**
 * Error codes of the operation (specs 04 to 06): cash registers, price lists in use, events, tabs,
 * orders, items, payments and the fiado. Messages in pt-BR, safe to show. Published in the OpenAPI
 * as `OperationErrorCode`.
 */
export const OPERATION_ERRORS = {
  /**
   * RN-04.02, CA-04.01, RN-05.06, CA-05.08: no cash register open in the unit, so no new tab, order
   * or payment.
   */
  NO_CASH_REGISTER_OPEN: {
    status: 409,
    message: 'Abra um caixa para vender e receber nesta unidade.',
  },
  /** RN-05.24: a register is not opened in an inactive unit. */
  UNIT_INACTIVE: {
    status: 409,
    message: 'Esta unidade está desativada. Ative-a para abrir o caixa.',
  },
  /** RN-05.23, CA-05.10: the register already has a session in progress (`details.sessionId`). */
  CASH_REGISTER_ALREADY_OPEN: { status: 409, message: 'Este caixa já está aberto.' },
  /** RN-05.27: an inactive register is not opened. */
  CASH_REGISTER_INACTIVE: {
    status: 409,
    message: 'Este caixa está desativado. Ative-o no cadastro dos caixas para abrir.',
  },
  /** RN-04.32, CA-04.14: during an event the current list is the event's and does not change. */
  EVENT_IN_PROGRESS: {
    status: 409,
    message:
      'Há um evento em andamento: a tabela de preço é a do evento. Encerre o evento para trocar a tabela.',
  },
  /** RN-04.35, CA-04.15: the unit already has an event in progress (`details.eventId`). */
  EVENT_ALREADY_IN_PROGRESS: {
    status: 409,
    message: 'Esta unidade já tem um evento em andamento. Encerre-o antes de iniciar outro.',
  },
  /** RN-04.34: only a scheduled event is started or canceled. */
  EVENT_NOT_SCHEDULED: {
    status: 409,
    message: 'Só um evento agendado pode ser iniciado ou cancelado.',
  },
  /** RN-04.34: only an event in progress is finished. */
  EVENT_NOT_IN_PROGRESS: { status: 409, message: 'Este evento não está em andamento.' },
  /** RN-04.34, RN-04.37: a finished or canceled event does not change. */
  EVENT_CLOSED: {
    status: 409,
    message: 'Este evento já foi encerrado ou cancelado e não pode ser alterado.',
  },
  /**
   * RN-04.05, RN-04.31: the price list does not exist in the unit or is inactive (spec 03,
   * RN-03.23).
   */
  INVALID_PRICE_LIST: {
    status: 400,
    message: 'Escolha uma tabela de preço ativa desta unidade.',
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
   * CA-04.05, CA-04.17, spec 04 section 7: another device changed the item first. `details.item` has
   * the current state, `details.currentVersion` its version; when advancing a whole order
   * (RN-04.39), `details.items` has the current lines of the order at the station.
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
  /** RN-04.39: the lines sent are not at the station (or stage) given. */
  ITEM_NOT_AT_STATION: {
    status: 409,
    message: 'Os itens enviados não estão nesta estação. A tela foi atualizada.',
  },
  // ----------------------------------------------------------------------------------------------
  // Spec 05: discounts, payments and cash registers
  // ----------------------------------------------------------------------------------------------
  /** RN-05.05: more than one register open; choose one (`details.cashRegisters`). */
  CASH_REGISTER_REQUIRED: {
    status: 409,
    message: 'Há mais de um caixa aberto. Escolha o caixa que recebe o pagamento.',
  },
  /** RN-05.05: the register does not exist in the unit of the tab. */
  INVALID_CASH_REGISTER: {
    status: 400,
    message: 'Este caixa não existe ou não é da unidade desta comanda.',
  },
  /**
   * RN-05.13, RN-05.21, CA-05.13: the session is closed (or the register chosen is not open): no
   * payment, reversal nor movement.
   */
  CASH_REGISTER_CLOSED: {
    status: 409,
    message: 'Este caixa já foi fechado e não aceita mais lançamentos.',
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
  /** RN-06.02: phone already used by another customer of the unit. */
  CUSTOMER_PHONE_TAKEN: {
    status: 409,
    message: 'Já existe um cliente com este telefone nesta unidade.',
  },
  /** RN-06.02: CPF already used by another customer of the unit. */
  CUSTOMER_CPF_TAKEN: { status: 409, message: 'Já existe um cliente com este CPF nesta unidade.' },
  /** RN-06.03, CA-06.05: a customer with a balance to receive is not removed (`details.balanceCents`). */
  CUSTOMER_HAS_RECEIVABLE: {
    status: 409,
    message: 'Este cliente tem valor a receber. Quite as comandas antes de remover o cadastro.',
  },
  /** RN-06.03: a removed customer is not edited nor used again. */
  CUSTOMER_REMOVED: { status: 409, message: 'Este cliente foi removido.' },
  /** RN-06.05: the customer does not exist in the unit of the tab (or was removed). */
  INVALID_CUSTOMER: {
    status: 400,
    message: 'Escolha um cliente desta unidade para pendurar a comanda.',
  },
  /** RN-06.05: putting on credit needs a customer (optional only in `consumption_billed`, RN-06.08). */
  CUSTOMER_REQUIRED: { status: 400, message: 'Escolha o cliente para pendurar a comanda.' },
  /** Concurrency: the `version` of the customer changed (`details.currentVersion`). */
  CUSTOMER_CHANGED: {
    status: 409,
    message: 'Outro aparelho alterou este cliente. Confira os dados e tente de novo.',
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
      'Códigos de erro da operação (specs 04 a 06): caixas, eventos, tabela vigente, comandas, pedidos, itens, descontos, pagamentos e fiado. Códigos da configuração (`SetupErrorCode`, como `CASH_REGISTER_OPEN`) e da assinatura (`ORGANIZATION_SUSPENDED`/`ORGANIZATION_CANCELED`, spec 02) também aparecem nestas rotas.',
  });
