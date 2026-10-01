import { z } from 'zod';

import {
  AgreementModality,
  DiscountType,
  OrderStatus,
  PaymentMethod,
  ShiftStatus,
  ShiftType,
  TabMode,
  TabStatus,
} from '../generated/prisma/enums.js';
import type { TabStatus as TabStatusValue } from '../generated/prisma/enums.js';
import { ActorTypeSchema } from '../openapi/enum-schemas.js';
import { ExpectedVersionSchema, WorkflowStageSchema } from '../units/units.schemas.js';
import { ORDER_ITEM_REJECTION_REASONS } from './order-rules.js';

/*
 * Contracts of the operation (spec 04): shifts, tabs, orders, items and the station queue.
 * Money in integer cents (`…Cents`); dates in ISO 8601 (UTC).
 */

// ------------------------------------------------------------------------------------------------
// Enums
// ------------------------------------------------------------------------------------------------

export const ShiftTypeSchema = z.enum(ShiftType).meta({
  id: 'ShiftType',
  description:
    '`direct_sale`: venda direta; `contracted`: turno contratado, com acordo (RN-04.04). Não muda depois da abertura.',
});

export const ShiftStatusSchema = z.enum(ShiftStatus).meta({ id: 'ShiftStatus' });

export const AgreementModalitySchema = z.enum(AgreementModality).meta({
  id: 'AgreementModality',
  description:
    '`fixed_fee`: valor fixo; `per_quantity`: por quantidade; `consumption_billed`: o contratante paga o consumo no final; `other` (RN-04.05).',
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

const CentsSchema = z.int().min(0).max(100_000_000);

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

// ------------------------------------------------------------------------------------------------
// Shifts (spec 04, section 3)
// ------------------------------------------------------------------------------------------------

export const ShiftAgreementSchema = z
  .object({
    contractorName: z.string(),
    modality: AgreementModalitySchema,
    agreedAmountCents: z.int().nullable(),
    agreedQuantity: z.int().nullable(),
    limits: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .meta({ id: 'ShiftAgreement', description: 'Acordo do turno contratado (RN-04.05).' });

export const ShiftPriceSchema = z
  .object({ productId: z.uuid(), priceCents: CentsSchema })
  .meta({ id: 'ShiftPrice', description: 'Preço de um produto só neste turno (RN-04.06).' });

export const ShiftSchema = z
  .object({
    id: z.uuid(),
    unitId: z.uuid(),
    type: ShiftTypeSchema,
    status: ShiftStatusSchema,
    openedAt: z.iso.datetime(),
    openedBy: ActorRefSchema,
    closedAt: z.iso.datetime().nullable(),
    closedBy: ActorRefSchema.nullable(),
    agreement: ShiftAgreementSchema.nullable().meta({
      description: 'Só no turno contratado.',
    }),
    prices: z.array(ShiftPriceSchema).meta({
      description:
        'Tabela de preços do turno; produtos fora dela usam o preço do cardápio (RN-04.06).',
    }),
    version: z.int(),
  })
  .meta({ id: 'Shift' });

export type ShiftDto = z.infer<typeof ShiftSchema>;

export const CurrentShiftSchema = z
  .object({ shift: ShiftSchema.nullable().meta({ description: '`null` sem turno aberto.' }) })
  .meta({ id: 'CurrentShift' });

const AgreementInputSchema = z.object({
  contractorName: z
    .string()
    .trim()
    .min(1, { message: 'Informe o nome do contratante.' })
    .max(80, { message: 'Use no máximo 80 caracteres.' }),
  modality: AgreementModalitySchema,
  agreedAmountCents: CentsSchema.nullable().optional(),
  agreedQuantity: z.int().min(1).max(1_000_000).nullable().optional(),
  limits: z.string().trim().max(200, { message: 'Use no máximo 200 caracteres.' }).nullish(),
  notes: z.string().trim().max(500, { message: 'Use no máximo 500 caracteres.' }).nullish(),
});

const PricesInputSchema = z
  .array(ShiftPriceSchema)
  .max(500)
  .refine(
    (prices) =>
      new Set(prices.map((price) => price.productId.toLowerCase())).size === prices.length,
    {
      message: 'Cada produto aparece uma vez só na tabela de preços.',
    },
  );

export const OpenShiftRequestSchema = z
  .object({
    type: ShiftTypeSchema,
    agreement: AgreementInputSchema.nullish().meta({
      description: 'Obrigatório no turno contratado; não vale na venda direta (RN-04.05).',
    }),
    prices: PricesInputSchema.default([]),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'contracted' && !value.agreement) {
      ctx.addIssue({
        code: 'custom',
        path: ['agreement'],
        message: 'O turno contratado precisa do acordo.',
      });
    }
    if (value.type === 'direct_sale' && value.agreement) {
      ctx.addIssue({
        code: 'custom',
        path: ['agreement'],
        message: 'A venda direta não tem acordo.',
      });
    }
  })
  .meta({ id: 'OpenShiftRequest' });

export type OpenShiftRequest = z.infer<typeof OpenShiftRequestSchema>;

export const PutShiftPricesRequestSchema = z
  .object({
    prices: PricesInputSchema.meta({ description: 'A tabela inteira; substitui a anterior.' }),
    version: ExpectedVersionSchema.optional(),
  })
  .meta({ id: 'PutShiftPricesRequest' });

export const ShiftPendingTabSchema = z
  .object({
    id: z.uuid(),
    number: z.int(),
    customerName: z.string(),
    status: TabStatusSchema,
  })
  .meta({ id: 'ShiftPendingTab' });

export const ShiftPendingItemsSchema = z
  .object({
    tabs: z.array(ShiftPendingTabSchema).meta({ description: 'Comandas em `open` ou `closing`.' }),
    cashRegisters: z
      .array(z.object({ id: z.uuid(), name: z.string() }))
      .meta({ description: 'Caixas do turno ainda abertos (spec 05).' }),
  })
  .meta({
    id: 'ShiftPendingItems',
    description:
      '`details` do 409 `SHIFT_HAS_PENDING_ITEMS` ao fechar o turno (RN-04.07, CA-04.09).',
  });

export type ShiftPendingItems = z.infer<typeof ShiftPendingItemsSchema>;

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
      description: 'Preço unitário vigente no envio: do turno ou do cardápio (RN-04.18).',
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
    lateAt: z.iso.datetime().nullable().meta({
      description:
        'Quando o item passa a estar atrasado: envio + `lateAfterMinutes` da unidade (RN-04.23). `null` na etapa final ou cancelado.',
    }),
    isLate: z.boolean().meta({ description: 'Atrasado no momento da resposta (CA-04.11).' }),
    canceledAt: z.iso.datetime().nullable(),
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
    shiftId: z.uuid(),
    unitId: z.uuid(),
    tabNumber: z.int(),
    customerName: z.string(),
    numberInTab: z.int(),
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
    shiftId: z.uuid(),
    unitId: z.uuid(),
    number: z.int(),
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
    lateItemCount: z.int().meta({ description: 'Unidades atrasadas (RN-04.23).' }),
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
    shiftId: z.uuid().meta({ description: 'Turno em que o dinheiro entrou.' }),
    cashRegisterId: z.uuid(),
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
// Station queue (spec 04, section 8.2)
// ------------------------------------------------------------------------------------------------

export const StationQueueSchema = z
  .object({
    stationId: z.uuid(),
    unitId: z.uuid(),
    lateAfterMinutes: z.int(),
    stages: z.array(WorkflowStageSchema).meta({
      description:
        'Fluxo da unidade em ordem, para o nome do botão de avançar ("Começar", "Pronto") e o filtro por etapa.',
    }),
    items: z.array(OrderItemSchema).meta({
      description:
        'Itens nesta estação, do pedido mais antigo para o mais novo; itens do mesmo pedido juntos.',
    }),
  })
  .meta({ id: 'StationQueue' });

export type StationQueueDto = z.infer<typeof StationQueueSchema>;

/** Named schemas that no route references directly (error details). */
export const operationContractSchemas: readonly z.ZodType[] = [
  ShiftStatusSchema,
  OrderStatusSchema,
  OrderItemRejectionReasonSchema,
  OrderRejectedDetailsSchema,
  ShiftPendingItemsSchema,
];
