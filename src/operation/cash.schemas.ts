import { z } from 'zod';

import {
  CashMovementType,
  CashRegisterSessionStatus,
  DiscountType,
} from '../generated/prisma/enums.js';
import { ExpectedVersionSchema, SortOrderSchema } from '../units/units.schemas.js';
import {
  ActorRefSchema,
  CreateOrderRequestSchema,
  CreateTabRequestSchema,
  PaymentMethodSchema,
  PaymentSchema,
  PlainDateSchema,
  TabSchema,
  TabStatusSchema,
} from './operation.schemas.js';

/*
 * Contracts of spec 05: discounts, payments, "paga antes", cash registers of the unit and their
 * sessions (aberturas de caixa). Money in integer cents (`…Cents`); dates in ISO 8601 (UTC).
 */

const MAX_CENTS = 100_000_000;

const PositiveCentsSchema = z
  .int()
  .min(1, { message: 'Informe um valor maior que zero.' })
  .max(MAX_CENTS, { message: 'Valor alto demais.' });

const ReasonSchema = z
  .string()
  .trim()
  .min(1, { message: 'Informe o motivo.' })
  .max(140, { message: 'Use no máximo 140 caracteres.' });

const TabVersionSchema = z.int().min(0).optional().meta({
  description:
    'Versão da comanda que o aparelho tem (opcional). Diferente da atual: 409 `TAB_CHANGED` com `details.currentVersion`.',
});

export const CashRegisterSessionStatusSchema = z.enum(CashRegisterSessionStatus).meta({
  id: 'CashRegisterSessionStatus',
  description:
    'Situação da abertura de caixa: `open` recebe pagamentos e movimentos; `closed` não volta a abrir (RN-05.21): abre-se o caixa de novo, numa abertura nova.',
});

export const CashMovementTypeSchema = z.enum(CashMovementType).meta({
  id: 'CashMovementType',
  description: '`withdrawal`: sangria; `deposit`: suprimento (RN-05.18).',
});

// ------------------------------------------------------------------------------------------------
// Discount (spec 05, section 3)
// ------------------------------------------------------------------------------------------------

export const PutDiscountRequestSchema = z
  .object({
    type: z.enum(DiscountType).meta({ description: '`amount` (centavos) ou `percent`.' }),
    value: z.int().min(1, { message: 'Informe um desconto maior que zero.' }).max(MAX_CENTS).meta({
      description:
        'Centavos (`amount`) ou percentual de 1 a 100 (`percent`), calculado sobre o subtotal e arredondado para baixo (RN-05.03).',
    }),
    reason: ReasonSchema.meta({ description: 'Motivo, obrigatório (RN-05.01).' }),
    version: TabVersionSchema,
  })
  .superRefine((value, ctx) => {
    if (value.type === 'percent' && value.value > 100) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'O percentual vai de 1 a 100.',
      });
    }
  })
  .meta({
    id: 'PutDiscountRequest',
    description: 'Aplica ou substitui o desconto da comanda (RN-05.01).',
  });

export const RemoveDiscountRequestSchema = z
  .object({
    reason: ReasonSchema.meta({ description: 'Motivo da remoção (RN-05.01).' }),
    version: TabVersionSchema,
  })
  .meta({ id: 'RemoveDiscountRequest' });

// ------------------------------------------------------------------------------------------------
// Payments (spec 05, section 4)
// ------------------------------------------------------------------------------------------------

const PaymentInputShape = {
  method: PaymentMethodSchema,
  amountCents: PositiveCentsSchema.optional().meta({
    description: 'Pix e cartões: valor, nunca maior que o saldo (RN-05.08).',
  }),
  tenderedCents: PositiveCentsSchema.optional().meta({
    description:
      'Dinheiro: valor entregue pelo cliente. Aplica-se o menor entre ele e o saldo; o resto é troco (RN-05.09).',
  }),
};

function checkPaymentInput(
  value: { method: string; amountCents?: number | undefined; tenderedCents?: number | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.method === 'cash') {
    if (value.tenderedCents === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tenderedCents'],
        message: 'Informe o valor entregue.',
      });
    }
    if (value.amountCents !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['amountCents'],
        message: 'No dinheiro, informe só o valor entregue.',
      });
    }
  } else {
    if (value.amountCents === undefined) {
      ctx.addIssue({ code: 'custom', path: ['amountCents'], message: 'Informe o valor.' });
    }
    if (value.tenderedCents !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tenderedCents'],
        message: 'Valor entregue só vale para dinheiro.',
      });
    }
  }
}

const CashRegisterChoiceSchema = z.uuid().optional().meta({
  description:
    'Caixa cadastrado que recebe; o pagamento entra na abertura em andamento dele (RN-05.05). Opcional com um único caixa aberto na unidade; obrigatório com mais de um (`CASH_REGISTER_REQUIRED`).',
});

export const CreatePaymentRequestSchema = z
  .object({
    ...PaymentInputShape,
    cashRegisterId: CashRegisterChoiceSchema,
    version: TabVersionSchema,
  })
  .superRefine(checkPaymentInput)
  .meta({
    id: 'CreatePaymentRequest',
    description: '`amountCents` para Pix e cartões; `tenderedCents` para dinheiro.',
  });

export type CreatePaymentRequest = z.infer<typeof CreatePaymentRequestSchema>;

export const PaymentInputSchema = z
  .object(PaymentInputShape)
  .superRefine(checkPaymentInput)
  .meta({ id: 'PayFirstPayment' });

export const PaymentResultSchema = z
  .object({
    payment: PaymentSchema,
    tab: TabSchema.meta({ description: 'A comanda depois do pagamento (`paid` com saldo zero).' }),
  })
  .meta({ id: 'PaymentResult' });

export type PaymentResultDto = z.infer<typeof PaymentResultSchema>;

export const ReversePaymentRequestSchema = z
  .object({ reason: ReasonSchema.meta({ description: 'Motivo do estorno (RN-05.13).' }) })
  .meta({ id: 'ReversePaymentRequest' });

export const PayFirstRequestSchema = z
  .object({
    customerName: CreateTabRequestSchema.shape.customerName,
    items: CreateOrderRequestSchema.shape.items,
    payments: z.array(PaymentInputSchema).max(10).meta({
      description:
        'Pagamentos, aplicados na ordem enviada. A soma precisa cobrir o total; senão nada é gravado (CA-05.09).',
    }),
    cashRegisterId: CashRegisterChoiceSchema,
  })
  .meta({
    id: 'PayFirstRequest',
    description:
      'Comanda paga antes (RN-05.12): comanda, pedido e pagamentos numa única operação. O pedido só vai às estações com o pagamento registrado (CA-04.10).',
  });

export type PayFirstRequest = z.infer<typeof PayFirstRequestSchema>;

// ------------------------------------------------------------------------------------------------
// Cash register sessions (spec 05, sections 5.2 to 5.4)
// ------------------------------------------------------------------------------------------------

const CreditSettlementsCentsSchema = z.int().meta({
  description:
    'Quitações de fiado recebidas nesta abertura (não estornadas), separadas das vendas (RN-05.22). Já estão somadas no esperado.',
});

export const ExpectedByMethodSchema = z
  .object({
    method: PaymentMethodSchema,
    expectedCents: z.int(),
    salesCents: z.int().meta({
      description:
        'Pagamentos de comandas nesta forma (sem quitações de fiado, sem fundo e movimentos).',
    }),
    creditSettlementsCents: CreditSettlementsCentsSchema,
  })
  .meta({ id: 'CashRegisterExpected' });

export const CashBreakdownSchema = z
  .object({
    openingFloatCents: z.int(),
    paymentsCents: z.int().meta({ description: 'Pagamentos em dinheiro aplicados, sem estornos.' }),
    creditSettlementsCents: z.int().meta({
      description: 'Parte de `paymentsCents` que veio de quitações de fiado (RN-05.22).',
    }),
    depositsCents: z.int(),
    withdrawalsCents: z.int(),
  })
  .meta({
    id: 'CashBreakdown',
    description: 'Dinheiro esperado = fundo + pagamentos + suprimentos − sangrias (RN-05.19).',
  });

export const CashRegisterCountSchema = z
  .object({
    method: PaymentMethodSchema,
    expectedCents: z.int(),
    informedCents: z.int(),
    differenceCents: z.int().meta({ description: 'Informado − esperado (RN-05.20).' }),
    creditSettlementsCents: CreditSettlementsCentsSchema,
  })
  .meta({ id: 'CashRegisterCount' });

export const CashRegisterSessionSchema = z
  .object({
    id: z.uuid(),
    cashRegisterId: z.uuid(),
    name: z.string().meta({ description: 'Nome do caixa cadastrado.' }),
    unitId: z.uuid(),
    businessDate: PlainDateSchema.meta({
      description: 'Dia de operação da abertura (RN-05.25).',
    }),
    status: CashRegisterSessionStatusSchema,
    openingFloatCents: z.int(),
    openedBy: ActorRefSchema.meta({ description: 'Responsável: quem abriu (RN-05.23).' }),
    openedByName: z.string().nullable().meta({ description: 'Nome do responsável.' }),
    openedAt: z.iso.datetime(),
    openSinceEarlierDay: z.boolean().meta({
      description:
        'Aberta e de um dia anterior a hoje: "Caixa 1 aberto desde ontem, 17:02" (RN-05.26).',
    }),
    closedBy: ActorRefSchema.nullable(),
    closedAt: z.iso.datetime().nullable(),
    closingNote: z.string().nullable(),
    expected: z.array(ExpectedByMethodSchema).meta({
      description:
        'Esperado por forma, na ordem `cash`, `pix`, `credit_card`, `debit_card` (tabela da seção 5).',
    }),
    cash: CashBreakdownSchema,
    counts: z.array(CashRegisterCountSchema).meta({
      description: 'Conferência gravada no fechamento (vazia enquanto aberta).',
    }),
    creditSettlementsCents: z.int().meta({
      description:
        'Total de quitações de fiado recebidas nesta abertura, em todas as formas (RN-05.22).',
    }),
    receivedCents: z.int().meta({
      description: 'Pagamentos não estornados desta abertura, vendas e quitações.',
    }),
    differenceCents: z.int().meta({
      description: 'Soma das diferenças por forma; 0 enquanto aberta (RN-05.20).',
    }),
    pendingTabsCount: z.int().nullable().meta({
      description:
        'Comandas `open`/`closing` da unidade no fechamento (RN-05.28); `null` enquanto aberta.',
    }),
    pendingTabsTotalCents: z.int().nullable().meta({
      description: 'Valor total dessas comandas no fechamento (RN-05.28).',
    }),
    version: z.int(),
  })
  .meta({
    id: 'CashRegisterSession',
    description: 'Abertura de caixa: de abrir (fundo de troco) até fechar (conferência).',
  });

export type CashRegisterSessionDto = z.infer<typeof CashRegisterSessionSchema>;

export const CashMovementSchema = z
  .object({
    id: z.uuid(),
    cashRegisterSessionId: z.uuid(),
    type: CashMovementTypeSchema,
    amountCents: z.int(),
    reason: z.string(),
    createdBy: ActorRefSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'CashMovement' });

export type CashMovementDto = z.infer<typeof CashMovementSchema>;

export const CashRegisterSessionDetailSchema = CashRegisterSessionSchema.extend({
  movements: z.array(CashMovementSchema),
  payments: z.array(PaymentSchema).meta({
    description: 'Pagamentos recebidos nesta abertura, inclusive os estornados.',
  }),
}).meta({ id: 'CashRegisterSessionDetail' });

export type CashRegisterSessionDetailDto = z.infer<typeof CashRegisterSessionDetailSchema>;

// ------------------------------------------------------------------------------------------------
// Cash registers of the unit (spec 05, section 5.1)
// ------------------------------------------------------------------------------------------------

export const CashRegisterSchema = z
  .object({
    id: z.uuid(),
    unitId: z.uuid(),
    name: z.string(),
    sortOrder: z.int(),
    active: z.boolean(),
    session: CashRegisterSessionSchema.nullable().meta({
      description:
        'A abertura em andamento ou, com o caixa fechado, a última fechada (`null` se nunca foi aberto).',
    }),
    suggestedOpeningFloatCents: z.int().meta({
      description:
        'Fundo de troco sugerido: o da abertura anterior deste caixa (RN-05.23); 0 sem ela.',
    }),
    version: z.int().meta({
      description: 'Versão do caixa, incrementada a cada mudança dele ou das aberturas.',
    }),
  })
  .meta({
    id: 'CashRegister',
    description: 'Caixa cadastrado da unidade (RN-05.17) com a abertura atual ou a última.',
  });

export type CashRegisterDto = z.infer<typeof CashRegisterSchema>;

export const CashRegisterListSchema = z
  .object({ data: z.array(CashRegisterSchema) })
  .meta({ id: 'CashRegisterList' });

const RegisterNameSchema = z
  .string()
  .trim()
  .min(1, { message: 'Informe o nome do caixa.' })
  .max(40, { message: 'Use no máximo 40 caracteres.' });

export const CreateCashRegisterRequestSchema = z
  .object({
    name: RegisterNameSchema.meta({
      description: 'De 1 a 40 caracteres, único na unidade (RN-05.17).',
    }),
    sortOrder: SortOrderSchema.optional(),
  })
  .meta({ id: 'CreateCashRegisterRequest' });

export const UpdateCashRegisterRequestSchema = z
  .object({
    name: RegisterNameSchema.optional(),
    sortOrder: SortOrderSchema.optional(),
    active: z.boolean().optional().meta({
      description:
        'Caixa aberto não é desativado (`CASH_REGISTER_OPEN`), nem o último ativo (`LAST_ACTIVE_CASH_REGISTER`), RN-05.27, CA-05.14.',
    }),
    version: ExpectedVersionSchema.optional(),
  })
  .meta({ id: 'UpdateCashRegisterRequest' });

export const OpenCashRegisterRequestSchema = z
  .object({
    openingFloatCents: z.int().min(0).max(MAX_CENTS).meta({
      description: 'Fundo de troco em dinheiro, zero ou mais (RN-05.23).',
    }),
    startEventId: z.uuid().optional().meta({
      description:
        'Inicia junto o evento agendado da unidade ("Hoje tem o evento… Iniciar junto?", RN-04.35).',
    }),
  })
  .meta({ id: 'OpenCashRegisterRequest' });

export const CashMovementRequestSchema = z
  .object({
    type: CashMovementTypeSchema,
    amountCents: PositiveCentsSchema,
    reason: ReasonSchema.meta({ description: 'Motivo, obrigatório (RN-05.18).' }),
    version: ExpectedVersionSchema.optional(),
  })
  .meta({ id: 'CashMovementRequest' });

export const PendingTabSchema = z
  .object({
    id: z.uuid(),
    number: z.int(),
    customerName: z.string(),
    status: TabStatusSchema,
    totalCents: z.int(),
    businessDate: PlainDateSchema.meta({ description: 'Desde quando (dia de operação).' }),
    openedAt: z.iso.datetime(),
  })
  .meta({ id: 'PendingTab', description: 'Comanda que segue aberta (RN-05.28).' });

export const ClosePreviewSchema = z
  .object({
    session: CashRegisterSessionSchema,
    pendingTabs: z.array(PendingTabSchema).meta({
      description:
        'Comandas `open`/`closing` da unidade: não impedem fechar e seguem abertas para o próximo dia ou outro caixa (RN-05.28).',
    }),
    pendingTabsTotalCents: z.int(),
    lastOpenRegister: z.boolean().meta({
      description: 'É o último caixa aberto da unidade: a confirmação mostra o resto (RN-05.29).',
    }),
    itemsInProgress: z.int().meta({
      description:
        'Unidades em etapas não finais na unidade; só no último caixa ("Encerrar o preparo pendente", RN-04.08). 0 nos outros.',
    }),
    eventInProgress: z.object({ id: z.uuid(), contractorName: z.string() }).nullable().meta({
      description:
        'Evento em andamento, só no último caixa ("Encerrar também o evento", RN-05.29).',
    }),
  })
  .meta({ id: 'CashRegisterClosePreview' });

export type ClosePreviewDto = z.infer<typeof ClosePreviewSchema>;

export const CloseCashRegisterRequestSchema = z
  .object({
    counts: z
      .array(
        z.object({
          method: PaymentMethodSchema,
          informedCents: z.int().min(0).max(MAX_CENTS),
        }),
      )
      .length(4, { message: 'Informe o valor conferido de cada forma de pagamento.' })
      .refine((counts) => new Set(counts.map((count) => count.method)).size === counts.length, {
        message: 'Cada forma de pagamento aparece uma vez só.',
      })
      .meta({
        description:
          'Valor conferido de cada forma (`cash`, `pix`, `credit_card`, `debit_card`), uma vez cada (RN-05.20).',
      }),
    note: z
      .string()
      .trim()
      .max(500, { message: 'Use no máximo 500 caracteres.' })
      .optional()
      .meta({ description: 'Observação; obrigatória quando alguma diferença não é zero.' }),
    finishPendingItems: z.boolean().default(true).meta({
      description:
        'Só no último caixa aberto: leva os itens em preparo à etapa final (padrão `true`, RN-04.08).',
    }),
    finishEvent: z.boolean().default(false).meta({
      description: 'Só no último caixa aberto: encerra o evento em andamento (padrão `false`).',
    }),
    version: ExpectedVersionSchema.optional(),
  })
  .meta({ id: 'CloseCashRegisterRequest' });

export type CloseCashRegisterRequest = z.infer<typeof CloseCashRegisterRequestSchema>;

export const CashRegisterRequiredDetailsSchema = z
  .object({
    cashRegisters: z.array(z.object({ id: z.uuid(), name: z.string() })),
  })
  .meta({
    id: 'CashRegisterRequiredDetails',
    description: '`details` do 409 `CASH_REGISTER_REQUIRED`: os caixas abertos (RN-05.05).',
  });

/** Named schemas that no route references directly. */
export const cashContractSchemas: readonly z.ZodType[] = [
  CashRegisterSessionStatusSchema,
  CashRegisterRequiredDetailsSchema,
];
