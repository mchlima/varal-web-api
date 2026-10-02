import { z } from 'zod';

import {
  AgreementModality,
  ContractedEventStatus,
  DiscountType,
  OrderStatus,
  PaymentMethod,
  TabMode,
  TabStatus,
} from '../generated/prisma/enums.js';
import type { TabStatus as TabStatusValue } from '../generated/prisma/enums.js';
import { ActorTypeSchema } from '../openapi/enum-schemas.js';
import { WorkflowStageSchema } from '../units/units.schemas.js';
import { ORDER_ITEM_REJECTION_REASONS } from './order-rules.js';

/*
 * Contracts of the operation (spec 04): tabs, orders, items, payments and the station queue (KDS).
 * Money in integer cents (`…Cents`); instants in ISO 8601 (UTC); days of operation (`…Date`) as
 * `AAAA-MM-DD` in America/Sao_Paulo (RN-04.29).
 */

// ------------------------------------------------------------------------------------------------
// Enums
// ------------------------------------------------------------------------------------------------

export const AgreementModalitySchema = z.enum(AgreementModality).meta({
  id: 'AgreementModality',
  description:
    '`fixed_fee`: valor fixo; `per_quantity`: por quantidade; `consumption_billed`: o contratante paga o consumo no final; `other` (RN-04.05).',
});

export const ContractedEventStatusSchema = z.enum(ContractedEventStatus).meta({
  id: 'ContractedEventStatus',
  description:
    'Situação do evento contratado (RN-04.34): `scheduled` (agendado) → `in_progress` (em andamento) → `finished` (encerrado); `scheduled` → `canceled`.',
});

export const TabModeSchema = z.enum(TabMode).meta({
  id: 'TabMode',
  description:
    '`pay_first`: paga antes, o pedido só vai às estações depois do pagamento (spec 05); `open_tab`: comanda aberta, paga no fechamento (RN-04.11).',
});

export const TabStatusSchema = z.enum(TabStatus).meta({
  id: 'TabStatus',
  description:
    'Situação da comanda (RN-04.12): `open`, `closing` (pediu a conta), `paid` (spec 05), `on_credit` e `settled` (spec 06), `canceled`.',
});

export const OrderStatusSchema = z.enum(OrderStatus).meta({
  id: 'OrderStatus',
  description:
    '`sent` enquanto houver item em etapa não final; `completed` quando todos estão na etapa final ou cancelados.',
});

export const DiscountTypeSchema = z.enum(DiscountType).meta({
  id: 'DiscountType',
  description: 'Desconto da comanda (spec 05): `amount` em centavos ou `percent` de 1 a 100.',
});

export const PaymentMethodSchema = z.enum(PaymentMethod).meta({
  id: 'PaymentMethod',
  description:
    'Forma de pagamento, só registrada (RN-05.04): `pix`, `cash` (dinheiro, com troco), `credit_card`, `debit_card`.',
});

export const OrderItemRejectionReasonSchema = z.enum(ORDER_ITEM_REJECTION_REASONS).meta({
  id: 'OrderItemRejectionReason',
  description:
    'Motivo de um item recusado em `ORDER_REJECTED` (RN-04.17): `product_unavailable` (não existe ou é de outra unidade), `product_inactive`, `sold_out`, `modifier_required` (grupo obrigatório sem escolha, CA-03.06), `too_many_modifiers`, `invalid_modifier`.',
});

// ------------------------------------------------------------------------------------------------
// Shared pieces
// ------------------------------------------------------------------------------------------------

export const ActorRefSchema = z
  .object({ type: ActorTypeSchema, id: z.uuid().nullable() })
  .meta({ id: 'ActorRef', description: 'Quem fez a ação (dono ou colaborador).' });

const ReasonSchema = z
  .string()
  .trim()
  .min(1, { message: 'Informe o motivo.' })
  .max(140, { message: 'Use no máximo 140 caracteres.' });

const ItemVersionSchema = z.int().min(0).meta({
  description:
    'Versão do item que o aparelho tem. Se outro aparelho mudou o item antes, a API responde 409 `ITEM_CHANGED` com o estado atual em `details.item` (CA-04.05).',
});

const TabVersionSchema = z.int().min(0).optional().meta({
  description:
    'Versão da comanda que o aparelho tem (opcional). Diferente da atual: 409 `TAB_CHANGED` com `details.currentVersion`.',
});

export const PlainDateSchema = z.iso.date().meta({
  description: 'Dia de operação (AAAA-MM-DD, America/Sao_Paulo; RN-04.29).',
});

// ------------------------------------------------------------------------------------------------
// Orders and items (spec 04, section 5)
// ------------------------------------------------------------------------------------------------

export const OrderItemModifierSchema = z
  .object({
    modifierId: z.uuid(),
    groupName: z.string(),
    modifierName: z.string(),
    priceDeltaCents: z.int(),
  })
  .meta({ id: 'OrderItemModifier', description: 'Cópia do modificador escolhido (RN-04.18).' });

export const OrderItemSchema = z
  .object({
    id: z.uuid(),
    orderId: z.uuid(),
    tabId: z.uuid(),
    unitId: z.uuid(),
    tabNumber: z.int(),
    customerName: z.string(),
    orderNumberInTab: z.int(),
    productId: z.uuid(),
    productName: z.string().meta({ description: 'Cópia do nome no momento da venda (RN-04.18).' }),
    unitPriceCents: z.int().meta({
      description:
        'Preço unitário no envio: o da tabela efetiva da unidade, ou o preço normal quando o produto não tem preço nela (RN-04.18).',
    }),
    priceListId: z.uuid().nullable().meta({
      description: 'Tabela de preço cujo preço foi usado (RN-04.18); `null` = preço normal.',
    }),
    quantity: z.int(),
    note: z.string().nullable(),
    modifiers: z.array(OrderItemModifierSchema),
    totalCents: z.int().meta({
      description: '`(unitPriceCents + Σ priceDeltaCents) × quantity` (spec 04, seção 6).',
    }),
    prepStationId: z.uuid().meta({ description: 'Estação de preparo resolvida no envio.' }),
    stationId: z.uuid().nullable().meta({
      description: 'Estação em que o item aparece agora; `null` na etapa final ou cancelado.',
    }),
    stageId: z.uuid(),
    stageName: z.string(),
    stageIsFinal: z.boolean(),
    stageEnteredAt: z.iso.datetime(),
    sentAt: z.iso.datetime().meta({ description: 'Envio do pedido.' }),
    attentionAt: z.iso.datetime().nullable().meta({
      description:
        'Quando o item entra em atenção: envio + `attentionAfterMinutes` da estação de preparo (RN-04.23; no balcão vale a estação de preparo). `null` na etapa final ou cancelado.',
    }),
    lateAt: z.iso.datetime().nullable().meta({
      description:
        'Quando o item passa a estar atrasado: envio + `lateAfterMinutes` da estação de preparo (RN-04.23). `null` na etapa final ou cancelado.',
    }),
    isLate: z.boolean().meta({ description: 'Atrasado no momento da resposta (CA-04.11).' }),
    canceledAt: z.iso.datetime().nullable(),
    canceledBusinessDate: PlainDateSchema.nullable().meta({
      description: 'Dia de operação do cancelamento (RN-04.27, RN-04.30).',
    }),
    canceledBy: ActorRefSchema.nullable(),
    cancelReason: z.string().nullable(),
    wasted: z
      .boolean()
      .meta({ description: 'Cancelado depois de sair da primeira etapa: perda (RN-04.27).' }),
    splitFromId: z.uuid().nullable().meta({
      description: 'Linha original de uma divisão (avançar ou cancelar parte, RN-04.24/RN-04.26).',
    }),
    version: z.int(),
  })
  .meta({ id: 'OrderItem' });

export type OrderItemDto = z.infer<typeof OrderItemSchema>;

export const OrderSchema = z
  .object({
    id: z.uuid(),
    tabId: z.uuid(),
    unitId: z.uuid(),
    tabNumber: z.int(),
    customerName: z.string(),
    numberInTab: z.int().meta({
      description: 'Número do pedido na comanda; a partir do 2 é um "Adicional" (RN-04.44).',
    }),
    status: OrderStatusSchema,
    createdBy: ActorRefSchema,
    sentAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    items: z.array(OrderItemSchema),
    version: z.int(),
  })
  .meta({ id: 'Order' });

export type OrderDto = z.infer<typeof OrderSchema>;

export const OrderItemRejectionSchema = z
  .object({
    index: z.int().meta({ description: 'Posição do item no corpo do pedido (a partir de 0).' }),
    productId: z.string(),
    reason: OrderItemRejectionReasonSchema,
    modifierGroupId: z.uuid().nullable(),
  })
  .meta({ id: 'OrderItemRejection' });

export const OrderRejectedDetailsSchema = z
  .object({ items: z.array(OrderItemRejectionSchema) })
  .meta({
    id: 'OrderRejectedDetails',
    description: '`details` do 409 `ORDER_REJECTED` (RN-04.17, CA-04.06).',
  });

const OrderItemInputSchema = z.object({
  productId: z.uuid(),
  quantity: z
    .int()
    .min(1, { message: 'A quantidade mínima é 1.' })
    .max(99, { message: 'A quantidade máxima é 99.' }),
  modifierIds: z.array(z.uuid()).max(50).default([]),
  note: z
    .string()
    .trim()
    .max(140, { message: 'Use no máximo 140 caracteres.' })
    .nullish()
    .meta({ description: 'Observação livre, até 140 caracteres.' }),
});

export const CreateOrderRequestSchema = z
  .object({
    items: z
      .array(OrderItemInputSchema)
      .min(1, { message: 'O pedido precisa de pelo menos 1 item.' })
      .max(50, { message: 'O pedido pode ter no máximo 50 itens.' }),
  })
  .meta({ id: 'CreateOrderRequest', description: 'Pedido com 1 a 50 itens (RN-04.16).' });

export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

export const AdvanceItemRequestSchema = z
  .object({
    version: ItemVersionSchema,
    quantity: z.int().min(1).max(99).optional().meta({
      description:
        'Quantas unidades seguem (RN-04.24); padrão: todas. Menos que a quantidade divide o item em duas linhas.',
    }),
  })
  .meta({ id: 'AdvanceItemRequest' });

export const BackItemRequestSchema = z
  .object({ version: ItemVersionSchema })
  .meta({ id: 'BackItemRequest' });

export const CancelItemRequestSchema = z
  .object({
    version: ItemVersionSchema,
    quantity: z.int().min(1).max(99).optional().meta({
      description: 'Quantas unidades cancelar (RN-04.26); padrão: todas.',
    }),
    reason: ReasonSchema.meta({ description: 'Motivo, até 140 caracteres (RN-04.25).' }),
  })
  .meta({ id: 'CancelItemRequest' });

export const ItemChangeSchema = z
  .object({
    changed: OrderItemSchema.meta({
      description:
        'A linha que mudou de etapa ou foi cancelada (a linha nova, quando houve divisão).',
    }),
    remaining: OrderItemSchema.nullable().meta({
      description:
        'Numa divisão (parte da quantidade), a linha original com o restante, na etapa em que estava; senão `null`.',
    }),
  })
  .meta({ id: 'ItemChange' });

export type ItemChangeDto = z.infer<typeof ItemChangeSchema>;

// ------------------------------------------------------------------------------------------------
// Tabs (spec 04, section 4)
// ------------------------------------------------------------------------------------------------

/** The customer of a tab on credit, without phone and CPF (tab events reach every device of the unit). */
export const TabCustomerSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    reference: z.string().nullable(),
    removed: z.boolean().meta({ description: 'Removido a pedido (RN-06.03).' }),
  })
  .meta({ id: 'TabCustomer' });

export const TabSummarySchema = z
  .object({
    id: z.uuid(),
    unitId: z.uuid(),
    number: z.int().meta({
      description:
        'Número no dia de operação, nunca repetido entre as comandas em aberto (RN-04.09).',
    }),
    businessDate: PlainDateSchema.meta({
      description:
        'Dia de operação em que foi aberta (RN-04.30); de um dia anterior, o balcão mostra "desde dd/mm" (RN-04.10).',
    }),
    closedBusinessDate: PlainDateSchema.nullable().meta({
      description:
        'Dia de operação em que saiu de `open`/`closing` (RN-04.38): o dia da venda (spec 07).',
    }),
    eventId: z.uuid().nullable().meta({
      description: 'Evento em andamento quando a comanda foi aberta (RN-04.36).',
    }),
    customerName: z.string(),
    mode: TabModeSchema,
    status: TabStatusSchema,
    subtotalCents: z.int().meta({ description: 'Soma dos itens não cancelados (RN-04.14).' }),
    discountType: DiscountTypeSchema.nullable(),
    discountValue: z.int().nullable(),
    discountCents: z.int(),
    totalCents: z.int().meta({ description: 'Subtotal − desconto (RN-04.14).' }),
    itemCount: z.int().meta({ description: 'Unidades em itens não cancelados.' }),
    readyItemCount: z.int().meta({
      description:
        'Unidades na etapa anterior à final (prontas para entregar): o sinal do cartão no varal.',
    }),
    lateItemCount: z.int().meta({
      description: 'Unidades atrasadas pelo limite da estação de preparo (RN-04.23).',
    }),
    discountReason: z.string().nullable().meta({ description: 'Motivo do desconto (RN-05.01).' }),
    paidCents: z.int().meta({
      description: 'Soma dos pagamentos não estornados (RN-05.07).',
    }),
    balanceCents: z.int().meta({
      description: 'Saldo a receber: `totalCents − paidCents` (RN-05.07).',
    }),
    openedAt: z.iso.datetime(),
    openedBy: ActorRefSchema,
    closedAt: z.iso.datetime().nullable(),
    version: z.int(),
    customer: TabCustomerSchema.nullable().meta({
      description: 'Cliente do fiado (`on_credit`, `settled`; RN-06.05); `null` nas outras.',
    }),
    creditAt: z.iso.datetime().nullable().meta({ description: 'Quando foi pendurada (spec 06).' }),
    settledAt: z.iso.datetime().nullable().meta({
      description: 'Quando o saldo pendurado chegou a zero (RN-06.10).',
    }),
  })
  .meta({ id: 'TabSummary', description: 'Cartão da comanda no varal do balcão.' });

export type TabSummaryDto = z.infer<typeof TabSummarySchema>;

// ------------------------------------------------------------------------------------------------
// Payments (spec 05, section 4)
// ------------------------------------------------------------------------------------------------

export const PaymentSchema = z
  .object({
    id: z.uuid(),
    tabId: z.uuid(),
    tabNumber: z.int(),
    customerName: z.string(),
    cashRegisterSessionId: z.uuid().meta({
      description: 'Abertura de caixa em que o dinheiro entrou (RN-05.05).',
    }),
    cashRegisterId: z.uuid().meta({ description: 'Caixa cadastrado dessa abertura.' }),
    cashRegisterName: z.string(),
    method: PaymentMethodSchema,
    amountCents: z.int().meta({ description: 'Valor aplicado à comanda (RN-05.09).' }),
    tenderedCents: z.int().nullable().meta({
      description: 'Só dinheiro: valor entregue pelo cliente.',
    }),
    changeCents: z.int().nullable().meta({
      description: 'Só dinheiro: troco (`tenderedCents − amountCents`), exibido em destaque.',
    }),
    isCreditSettlement: z.boolean().meta({ description: 'Quitação de fiado (spec 06).' }),
    receivedBy: ActorRefSchema,
    createdAt: z.iso.datetime(),
    reversedAt: z.iso.datetime().nullable().meta({
      description:
        'Estornado (RN-05.15): o pagamento continua registrado e sai do saldo e do caixa.',
    }),
    reversedBy: ActorRefSchema.nullable(),
    reversalReason: z.string().nullable(),
  })
  .meta({ id: 'Payment', description: 'Pagamento registrado (spec 05, seção 4).' });

export type PaymentDto = z.infer<typeof PaymentSchema>;

export const TabSchema = TabSummarySchema.extend({
  orders: z.array(OrderSchema).meta({ description: 'Pedidos, do primeiro ao último.' }),
  payments: z.array(PaymentSchema).meta({
    description: 'Pagamentos da comanda, inclusive os estornados, do primeiro ao último.',
  }),
}).meta({ id: 'Tab', description: 'Comanda com pedidos, itens e totais.' });

export type TabDto = z.infer<typeof TabSchema>;

export const TabListSchema = z.object({ data: z.array(TabSummarySchema) }).meta({ id: 'TabList' });

export const CreateTabRequestSchema = z
  .object({
    customerName: z
      .string()
      .trim()
      .min(1, { message: 'Informe o nome do cliente.' })
      .max(40, { message: 'Use no máximo 40 caracteres.' })
      .meta({ description: 'Nome do cliente, de 1 a 40 caracteres (RN-04.10).' }),
  })
  .meta({ id: 'CreateTabRequest' });

export const TabActionRequestSchema = z
  .object({ version: TabVersionSchema })
  .meta({ id: 'TabActionRequest' });

export const CancelTabRequestSchema = z
  .object({
    version: TabVersionSchema,
    reason: ReasonSchema.optional().meta({ description: 'Motivo, até 140 caracteres.' }),
  })
  .meta({ id: 'CancelTabRequest' });

const TAB_STATUS_LIST = new RegExp(
  `^(${TabStatusSchema.options.join('|')})(,(${TabStatusSchema.options.join('|')}))*$`,
);

/** `?status=open,closing`: unnamed (query schemas never carry `.meta({ id })`). */
export const TabListQuerySchema = z.object({
  status: z
    .string()
    .regex(TAB_STATUS_LIST, {
      message: `Use situações separadas por vírgula: ${TabStatusSchema.options.join(', ')}.`,
    })
    .optional()
    .meta({
      description:
        'Situações (`TabStatus`) separadas por vírgula; padrão `open,closing`. Ex.: `open,closing,paid`.',
    }),
});

/** The statuses of `?status=` (already validated by {@link TabListQuerySchema}). */
export function tabStatusesOf(query: { status?: string | undefined }): TabStatusValue[] {
  const values = (query.status ?? 'open,closing').split(',') as TabStatusValue[];
  return [...new Set(values)];
}

export type TabListQuery = z.infer<typeof TabListQuerySchema>;

// ------------------------------------------------------------------------------------------------
// Station queue: one order, one card (spec 04, sections 5.2 and 8.2)
// ------------------------------------------------------------------------------------------------

export const STATION_LINE_STATES = ['pending', 'done', 'canceled'] as const;

export const StationLineStateSchema = z.enum(STATION_LINE_STATES).meta({
  id: 'StationLineState',
  description:
    'Linha do cartão (RN-04.41, RN-04.45): `pending` está nesta estação; `done` passou por ela e saiu (riscada, com confirmação); `canceled` foi cancelada no cartão (riscada, com o motivo).',
});

export const StationLineSchema = OrderItemSchema.extend({
  state: StationLineStateSchema,
}).meta({ id: 'StationLine' });

export const StationOrderSchema = z
  .object({
    orderId: z.uuid(),
    tabId: z.uuid(),
    tabNumber: z.int(),
    customerName: z.string(),
    tabMode: TabModeSchema.meta({ description: 'O cartão mostra "Paga antes" quando for.' }),
    numberInTab: z.int(),
    isAdditional: z.boolean().meta({
      description:
        'Pedido 2 em diante da comanda: o cartão mostra "Adicional · pedido N" (RN-04.44).',
    }),
    sentAt: z.iso.datetime(),
    attentionAt: z.iso.datetime().meta({
      description: 'Envio + limite de atenção da estação (RN-04.46).',
    }),
    lateAt: z.iso
      .datetime()
      .meta({ description: 'Envio + limite de atraso da estação (RN-04.46).' }),
    lines: z.array(StationLineSchema).meta({
      description:
        'Linhas do pedido que são desta estação, na ordem do pedido: pendentes, feitas e canceladas (RN-04.40 a RN-04.45).',
    }),
    otherStationsQuantity: z.int().meta({
      description:
        'Unidades ativas do pedido que estão em etapas de outras estações: "+ N itens em outra estação" (RN-04.43).',
    }),
  })
  .meta({ id: 'StationOrder', description: 'Um cartão da estação: um pedido (RN-04.40).' });

export type StationOrderDto = z.infer<typeof StationOrderSchema>;

export const StationQueueSchema = z
  .object({
    stationId: z.uuid(),
    unitId: z.uuid(),
    attentionAfterMinutes: z
      .int()
      .meta({ description: 'Limite de atenção da estação (RN-03.25).' }),
    lateAfterMinutes: z.int().meta({ description: 'Limite de atraso da estação (RN-03.25).' }),
    stages: z.array(WorkflowStageSchema).meta({
      description:
        'Fluxo da unidade em ordem, para o nome do botão de avançar ("Começar", "Pronto") e o filtro por etapa.',
    }),
    orders: z.array(StationOrderSchema).meta({
      description:
        'Cartões com pelo menos uma linha pendente nesta estação, do pedido mais antigo para o mais novo (RN-04.40, RN-04.42).',
    }),
  })
  .meta({ id: 'StationQueue' });

export type StationQueueDto = z.infer<typeof StationQueueSchema>;

export const AdvanceOrderRequestSchema = z
  .object({
    stationId: z.uuid().meta({ description: 'Estação do cartão.' }),
    stageId: z.uuid().optional().meta({
      description:
        'Com o filtro por etapa: só as linhas nesta etapa. Sem ele, todas as linhas do pedido na estação.',
    }),
    items: z
      .array(z.object({ id: z.uuid(), version: ItemVersionSchema }))
      .min(1)
      .max(100)
      .meta({
        description:
          'Todas as linhas do pedido que estão na estação (e na etapa), com a versão que o aparelho tem. Se alguma mudou ou faltou, nada é aplicado (RN-04.39).',
      }),
  })
  .meta({ id: 'AdvanceOrderRequest' });

export const AdvanceOrderResultSchema = z
  .object({
    orderId: z.uuid(),
    items: z.array(OrderItemSchema).meta({ description: 'As linhas na etapa nova.' }),
  })
  .meta({ id: 'AdvanceOrderResult' });

export type AdvanceOrderResultDto = z.infer<typeof AdvanceOrderResultSchema>;

/** Named schemas that no route references directly (error details). */
export const operationContractSchemas: readonly z.ZodType[] = [
  OrderStatusSchema,
  OrderItemRejectionReasonSchema,
  OrderRejectedDetailsSchema,
];
