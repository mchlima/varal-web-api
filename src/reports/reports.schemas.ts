import { z } from 'zod';

import { KeysetPaginationQuerySchema, pageSchema } from '../common/pagination.js';
import { CashRegisterSchema } from '../operation/cash.schemas.js';
import { ActorTypeSchema } from '../openapi/enum-schemas.js';
import {
  AgreementModalitySchema,
  PaymentMethodSchema,
  ShiftStatusSchema,
  ShiftTypeSchema,
  TabCustomerSchema,
  TabStatusSchema,
} from '../operation/operation.schemas.js';

/*
 * Contracts of spec 07 (relatórios). Money in integer cents (`…Cents`); instants in ISO 8601 (UTC);
 * days (`date`, `from`, `to`) in America/Sao_Paulo. Every value comes from what was copied into the
 * items, tabs and payments, never from the current menu (RN-07.05).
 */

const PlainDateSchema = z.iso.date({ error: 'Use o formato AAAA-MM-DD.' });

export const ReportActorSchema = z
  .object({
    type: ActorTypeSchema,
    id: z.uuid().nullable(),
    name: z.string().nullable().meta({
      description: 'Nome do dono ou do colaborador; `null` para o sistema ou o suporte.',
    }),
  })
  .meta({ id: 'ReportActor', description: 'Quem fez a ação, com o nome para exibir.' });

export type ReportActorDto = z.infer<typeof ReportActorSchema>;

// ------------------------------------------------------------------------------------------------
// Totals shared by the shift report and the history (RN-07.01 to RN-07.04)
// ------------------------------------------------------------------------------------------------

const ShiftTotalsShape = {
  salesCents: z.int().meta({
    description:
      'Venda: total, após desconto, das comandas `paid`, `on_credit` e `settled` do turno (RN-07.01).',
  }),
  receivedCents: z.int().meta({
    description:
      'Recebido: pagamentos não estornados que entraram no turno, vendas e quitações (RN-07.02).',
  }),
  receivedSalesCents: z
    .int()
    .meta({ description: 'Parte do recebido que é de comandas do turno.' }),
  receivedSettlementsCents: z.int().meta({
    description: 'Parte do recebido que é quitação de fiado, de qualquer turno (RN-07.02).',
  }),
  onCreditCents: z.int().meta({
    description:
      'Pendurado: saldo das comandas do turno no momento em que foram penduradas (RN-07.03).',
  }),
  discountsCents: z.int().meta({ description: 'Descontos das comandas que contam na venda.' }),
  wasteCents: z.int().meta({
    description: 'Perdas: valor dos itens cancelados marcados como perda (RN-07.04).',
  }),
  wasteQuantity: z.int().meta({ description: 'Unidades perdidas (RN-07.04).' }),
  cashDifferenceCents: z.int().meta({
    description:
      'Diferença de caixa: soma de informado − esperado dos caixas fechados, em todas as formas (CA-07.04).',
  }),
};

// ------------------------------------------------------------------------------------------------
// Shift report (spec 07, section 4)
// ------------------------------------------------------------------------------------------------

export const ShiftReportSummarySchema = z
  .object({
    ...ShiftTotalsShape,
    tabCount: z.int().meta({ description: 'Comandas que contam na venda (RN-07.01).' }),
    canceledTabCount: z.int(),
    averageTicketCents: z.int().meta({
      description: 'Venda ÷ comandas, arredondado para baixo; 0 sem comandas.',
    }),
  })
  .meta({ id: 'ShiftReportSummary' });

export const ProductModifierLineSchema = z
  .object({
    groupName: z.string(),
    modifierName: z.string(),
    priceDeltaCents: z.int(),
    quantity: z.int(),
    valueCents: z.int().meta({ description: 'Acréscimo × quantidade.' }),
  })
  .meta({ id: 'ReportProductModifier' });

export const ProductLineSchema = z
  .object({
    productId: z.uuid(),
    productName: z.string().meta({ description: 'Nome gravado no item (RN-04.18).' }),
    quantity: z.int().meta({ description: 'Unidades não canceladas (RN-07.04).' }),
    valueCents: z.int().meta({
      description: 'Preço gravado + acréscimos, vezes a quantidade (RN-07.05), antes do desconto.',
    }),
    modifiers: z.array(ProductModifierLineSchema).meta({
      description: 'Modificadores com acréscimo escolhidos, maior valor primeiro.',
    }),
  })
  .meta({ id: 'ReportProductLine' });

export const PaymentMethodLineSchema = z
  .object({
    method: PaymentMethodSchema,
    salesCents: z.int().meta({ description: 'Pagamentos de comandas do turno.' }),
    settlementsCents: z.int().meta({ description: 'Quitações de fiado recebidas no turno.' }),
    totalCents: z.int(),
  })
  .meta({ id: 'ReportPaymentMethodLine' });

export const StaffLineSchema = z
  .object({
    actor: ReportActorSchema,
    tabsOpened: z.int(),
    ordersSent: z.int().meta({ description: 'Pedidos lançados.' }),
    receivedCents: z.int().meta({ description: 'Pagamentos não estornados recebidos no turno.' }),
    itemsCanceled: z.int().meta({ description: 'Unidades de itens canceladas.' }),
    tabsCanceled: z.int(),
    discountCount: z.int().meta({ description: 'Descontos em vigor dados por quem.' }),
    discountsCents: z.int(),
  })
  .meta({ id: 'ReportStaffLine', description: 'Linha "Por colaborador" (o dono também aparece).' });

export const ReportCashRegisterSchema = CashRegisterSchema.extend({
  responsible: ReportActorSchema.meta({ description: 'Quem abriu o caixa (RN-05.17).' }),
  closedByActor: ReportActorSchema.nullable(),
  differenceCents: z.int().meta({
    description: 'Soma das diferenças por forma; 0 enquanto aberto (CA-07.04).',
  }),
}).meta({ id: 'ReportCashRegister' });

export const CreditTabLineSchema = z
  .object({
    tabId: z.uuid(),
    number: z.int(),
    customerName: z.string(),
    customer: TabCustomerSchema.nullable(),
    status: TabStatusSchema,
    creditAt: z.iso.datetime(),
    amountCents: z.int().meta({ description: 'Valor pendurado (RN-07.03).' }),
    balanceCents: z.int().meta({ description: 'Saldo atual a receber.' }),
  })
  .meta({ id: 'ReportCreditTab' });

export const SettlementLineSchema = z
  .object({
    paymentId: z.uuid(),
    tabId: z.uuid(),
    tabNumber: z.int(),
    tabShiftId: z.uuid().meta({ description: 'Turno da comanda quitada (pode ser outro).' }),
    customerName: z.string(),
    customer: TabCustomerSchema.nullable(),
    method: PaymentMethodSchema,
    amountCents: z.int(),
    receivedAt: z.iso.datetime(),
    receivedBy: ReportActorSchema,
  })
  .meta({ id: 'ReportSettlement' });

export const CanceledItemLineSchema = z
  .object({
    itemId: z.uuid(),
    tabId: z.uuid(),
    tabNumber: z.int(),
    productName: z.string(),
    quantity: z.int(),
    valueCents: z.int().meta({ description: 'Valor gravado do item cancelado.' }),
    reason: z.string().nullable(),
    canceledAt: z.iso.datetime(),
    canceledBy: ReportActorSchema.nullable(),
    wasted: z.boolean().meta({ description: 'Perda (RN-04.27).' }),
  })
  .meta({ id: 'ReportCanceledItem' });

export const CanceledTabLineSchema = z
  .object({
    tabId: z.uuid(),
    number: z.int(),
    customerName: z.string(),
    canceledAt: z.iso.datetime().nullable(),
    canceledBy: ReportActorSchema.nullable(),
  })
  .meta({ id: 'ReportCanceledTab' });

export const AgreementReportSchema = z
  .object({
    contractorName: z.string(),
    modality: AgreementModalitySchema,
    agreedAmountCents: z.int().nullable(),
    agreedQuantity: z.int().nullable(),
    limits: z.string().nullable(),
    notes: z.string().nullable(),
    consumedQuantity: z.int().meta({
      description: 'Unidades não canceladas das comandas que contam na venda.',
    }),
    consumedCents: z.int().meta({ description: 'Valor consumido (= venda do turno).' }),
    quantityDifference: z.int().nullable().meta({
      description:
        'Quantidade combinada − consumida (CA-07.03); negativa se passou do combinado; `null` sem quantidade combinada.',
    }),
  })
  .meta({ id: 'ShiftReportAgreement', description: 'Acordo do turno contratado (RN-04.05).' });

export const ShiftReportSchema = z
  .object({
    shift: z.object({
      id: z.uuid(),
      unitId: z.uuid(),
      unitName: z.string(),
      type: ShiftTypeSchema,
      status: ShiftStatusSchema,
      date: z.iso.date().meta({ description: 'Dia da abertura em America/Sao_Paulo.' }),
      openedAt: z.iso.datetime(),
      openedBy: ReportActorSchema,
      closedAt: z.iso.datetime().nullable(),
      closedBy: ReportActorSchema.nullable(),
    }),
    partial: z.boolean().meta({
      description:
        'Turno aberto: o app mostra a faixa "Turno em andamento — valores parciais" (RN-07.06).',
    }),
    timeZone: z.literal('America/Sao_Paulo'),
    summary: ShiftReportSummarySchema,
    products: z
      .array(ProductLineSchema)
      .meta({ description: 'Por produto, maior valor primeiro.' }),
    paymentMethods: z.array(PaymentMethodLineSchema).meta({
      description: 'Sempre as quatro formas, na ordem `cash`, `pix`, `credit_card`, `debit_card`.',
    }),
    staff: z
      .array(StaffLineSchema)
      .meta({ description: 'Por colaborador, maior recebido primeiro.' }),
    cashRegisters: z.array(ReportCashRegisterSchema),
    credit: z.object({
      onCreditCents: z.int(),
      settlementsCents: z.int(),
      tabs: z.array(CreditTabLineSchema).meta({
        description: 'Comandas do turno penduradas (hoje `on_credit` ou já `settled`).',
      }),
      settlements: z.array(SettlementLineSchema).meta({
        description: 'Quitações não estornadas recebidas no turno.',
      }),
    }),
    cancellations: z.object({
      wasteCents: z.int(),
      wasteQuantity: z.int(),
      items: z.array(CanceledItemLineSchema),
      tabs: z.array(CanceledTabLineSchema),
    }),
    agreement: AgreementReportSchema.nullable().meta({ description: 'Só no turno contratado.' }),
  })
  .meta({ id: 'ShiftReport', description: 'Relatório do turno (spec 07, seção 4).' });

export type ShiftReportDto = z.infer<typeof ShiftReportSchema>;

// ------------------------------------------------------------------------------------------------
// History (spec 07, section 5)
// ------------------------------------------------------------------------------------------------

/** Unnamed: query schemas never carry `.meta({ id })`. */
export const ShiftHistoryQuerySchema = KeysetPaginationQuerySchema.extend({
  unitId: z.uuid().optional().meta({ description: 'Unidade; sem ela, todas da organização.' }),
  from: PlainDateSchema.optional().meta({
    description: 'Primeiro dia (AAAA-MM-DD, horário de Brasília). Padrão: 29 dias antes de `to`.',
  }),
  to: PlainDateSchema.optional().meta({
    description: 'Último dia, inclusive (AAAA-MM-DD, horário de Brasília). Padrão: hoje.',
  }),
  type: ShiftTypeSchema.optional(),
});

export type ShiftHistoryQuery = z.infer<typeof ShiftHistoryQuerySchema>;

export const ShiftHistoryRowSchema = z
  .object({
    shiftId: z.uuid(),
    unitId: z.uuid(),
    unitName: z.string(),
    type: ShiftTypeSchema,
    status: ShiftStatusSchema,
    date: z.iso.date().meta({ description: 'Dia da abertura em America/Sao_Paulo.' }),
    openedAt: z.iso.datetime(),
    closedAt: z.iso.datetime().nullable(),
    tabCount: z.int(),
    ...ShiftTotalsShape,
  })
  .meta({ id: 'ShiftHistoryRow' });

export type ShiftHistoryRowDto = z.infer<typeof ShiftHistoryRowSchema>;

export const ShiftHistoryTotalsSchema = z
  .object({ shiftCount: z.int(), tabCount: z.int(), ...ShiftTotalsShape })
  .meta({ id: 'ShiftHistoryTotals', description: 'Totais do período inteiro, não só da página.' });

export const ShiftHistorySchema = pageSchema('ShiftHistory', ShiftHistoryRowSchema)
  .extend({
    period: z.object({
      from: z.iso.date(),
      to: z.iso.date().meta({ description: 'Inclusive.' }),
      timeZone: z.literal('America/Sao_Paulo'),
    }),
    totals: ShiftHistoryTotalsSchema,
  })
  .meta({
    id: 'ShiftHistory',
    description:
      'Turnos do período, mais recentes primeiro (pela abertura), paginados por cursor, com os totais do período (spec 07, seção 5).',
  });

export type ShiftHistoryDto = z.infer<typeof ShiftHistorySchema>;
