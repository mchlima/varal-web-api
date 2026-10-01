import { z } from 'zod';

import { CashMovementType, CashRegisterStatus, DiscountType } from '../generated/prisma/enums.js';
import { ExpectedVersionSchema } from '../units/units.schemas.js';
import {
  ActorRefSchema,
  CreateOrderRequestSchema,
  CreateTabRequestSchema,
  PaymentMethodSchema,
  PaymentSchema,
  TabSchema,
} from './operation.schemas.js';

/*
 * Contracts of spec 05: discounts, payments, "paga antes" and cash registers. Money in integer
 * cents (`…Cents`); dates in ISO 8601 (UTC).
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

export const CashRegisterStatusSchema = z.enum(CashRegisterStatus).meta({
  id: 'CashRegisterStatus',
  description: '`open` recebe pagamentos e movimentos; `closed` não volta a abrir (RN-05.21).',
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
    'Caixa que recebe (RN-05.05). Opcional com um único caixa aberto no turno; obrigatório com mais de um (`CASH_REGISTER_REQUIRED`).',
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
// Cash registers (spec 05, section 5)
// ------------------------------------------------------------------------------------------------

export const ExpectedByMethodSchema = z
  .object({ method: PaymentMethodSchema, expectedCents: z.int() })
  .meta({ id: 'CashRegisterExpected' });

export const CashBreakdownSchema = z
  .object({
    openingFloatCents: z.int(),
    paymentsCents: z.int().meta({ description: 'Pagamentos em dinheiro aplicados, sem estornos.' }),
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
  })
  .meta({ id: 'CashRegisterCount' });

export const CashRegisterSchema = z
  .object({
    id: z.uuid(),
    shiftId: z.uuid(),
    unitId: z.uuid(),
    name: z.string(),
    status: CashRegisterStatusSchema,
    openingFloatCents: z.int(),
    openedBy: ActorRefSchema.meta({ description: 'Responsável: quem abriu (RN-05.17).' }),
    openedAt: z.iso.datetime(),
    closedBy: ActorRefSchema.nullable(),
    closedAt: z.iso.datetime().nullable(),
    closingNote: z.string().nullable(),
    expected: z.array(ExpectedByMethodSchema).meta({
      description:
        'Esperado por forma, na ordem `cash`, `pix`, `credit_card`, `debit_card` (tabela da seção 5).',
    }),
    cash: CashBreakdownSchema,
    counts: z.array(CashRegisterCountSchema).meta({
      description: 'Conferência gravada no fechamento (vazia enquanto aberto).',
    }),
    version: z.int(),
  })
  .meta({ id: 'CashRegister', description: 'Caixa do turno com o esperado por forma.' });

export type CashRegisterDto = z.infer<typeof CashRegisterSchema>;

export const CashRegisterListSchema = z
  .object({ data: z.array(CashRegisterSchema) })
  .meta({ id: 'CashRegisterList' });

export const CashMovementSchema = z
  .object({
    id: z.uuid(),
    cashRegisterId: z.uuid(),
    type: CashMovementTypeSchema,
    amountCents: z.int(),
    reason: z.string(),
    createdBy: ActorRefSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'CashMovement' });

export type CashMovementDto = z.infer<typeof CashMovementSchema>;

export const CashRegisterDetailSchema = CashRegisterSchema.extend({
  movements: z.array(CashMovementSchema),
  payments: z.array(PaymentSchema).meta({
    description: 'Pagamentos recebidos neste caixa, inclusive os estornados.',
  }),
}).meta({ id: 'CashRegisterDetail' });

export type CashRegisterDetailDto = z.infer<typeof CashRegisterDetailSchema>;

export const OpenCashRegisterRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, { message: 'Informe o nome do caixa.' })
      .max(40, { message: 'Use no máximo 40 caracteres.' })
      .optional()
      .meta({ description: 'Padrão: "Caixa 1", "Caixa 2"… (RN-05.17).' }),
    openingFloatCents: z.int().min(0).max(MAX_CENTS).meta({
      description: 'Fundo de troco em dinheiro, zero ou mais (RN-05.17).',
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
    version: ExpectedVersionSchema.optional(),
  })
  .meta({ id: 'CloseCashRegisterRequest' });

export type CloseCashRegisterRequest = z.infer<typeof CloseCashRegisterRequestSchema>;

/** Named schemas that no route references directly. */
export const cashContractSchemas: readonly z.ZodType[] = [CashRegisterStatusSchema];
