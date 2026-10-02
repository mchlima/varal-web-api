import { z } from 'zod';

import { KeysetPaginationQuerySchema, pageSchema } from '../common/pagination.js';
import { CashRegisterSessionSchema } from '../operation/cash.schemas.js';
import { ContractedEventSchema } from '../operation/events.schemas.js';
import { ActorTypeSchema } from '../openapi/enum-schemas.js';
import {
  CashMovementTypeSchema,
  CashRegisterSessionStatusSchema,
} from '../operation/cash.schemas.js';
import {
  ContractedEventStatusSchema,
  PaymentMethodSchema,
  TabCustomerSchema,
  TabStatusSchema,
} from '../operation/operation.schemas.js';

/*
 * Contracts of spec 07 (relatórios): the day or period report, the cash register session report,
 * the event report and the histories. Money in integer cents (`…Cents`); instants in ISO 8601
 * (UTC); days (`businessDate`, `from`, `to`) are days of operation in America/Sao_Paulo
 * (RN-04.29). Every value comes from what was copied into the items, tabs and payments, never from
 * the current menu (RN-07.05).
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
// Totals shared by every report and history (RN-07.01 to RN-07.04, RN-07.08)
// ------------------------------------------------------------------------------------------------

const TotalsShape = {
  salesCents: z.int().meta({
    description:
      'Venda: total, após desconto, das comandas que passaram a `paid` ou `on_credit` no período (`settled` conta pelo dia em que foi pendurada), RN-07.01.',
  }),
  receivedCents: z.int().meta({
    description:
      'Recebido: pagamentos não estornados das aberturas de caixa do período, vendas e quitações (RN-07.02).',
  }),
  receivedSalesCents: z.int().meta({ description: 'Parte do recebido que é de comandas.' }),
  receivedSettlementsCents: z.int().meta({
    description: 'Parte do recebido que é quitação de fiado (RN-07.02).',
  }),
  onCreditCents: z.int().meta({
    description:
      'Pendurado: saldo das comandas penduradas no período, no momento em que foram penduradas (RN-07.03).',
  }),
  discountsCents: z.int().meta({ description: 'Descontos das comandas que contam na venda.' }),
  wasteCents: z.int().meta({
    description:
      'Perdas: itens cancelados marcados como perda, pelo dia do cancelamento (RN-07.04).',
  }),
  wasteQuantity: z.int().meta({ description: 'Unidades perdidas (RN-07.04).' }),
  cashDifferenceCents: z.int().meta({
    description:
      'Diferença de caixa: soma de informado − esperado das aberturas fechadas (RN-07.08, CA-07.04).',
  }),
  tabCount: z.int().meta({ description: 'Comandas que contam na venda.' }),
};

export const ReportTotalsSchema = z
  .object(TotalsShape)
  .meta({ id: 'ReportTotals', description: 'Totais de um período, de um caixa ou de um evento.' });

export type ReportTotalsDto = z.infer<typeof ReportTotalsSchema>;

const PeriodSchema = z.object({
  from: z.iso.date(),
  to: z.iso.date().meta({ description: 'Inclusive.' }),
  timeZone: z.literal('America/Sao_Paulo'),
});

// ------------------------------------------------------------------------------------------------
// Sections shared by the reports
// ------------------------------------------------------------------------------------------------

export const ProductModifierLineSchema = z
  .object({
    groupName: z.string(),
    modifierName: z.string(),
    priceDeltaCents: z.int(),
    quantity: z.int(),
    valueCents: z.int().meta({ description: 'Acréscimo × quantidade.' }),
  })
  .meta({ id: 'ReportProductModifier' });

export const ProductPriceListLineSchema = z
  .object({
    priceListId: z.uuid().nullable().meta({ description: '`null` = preço normal.' }),
    priceListName: z.string().meta({ description: 'Nome da tabela, ou "Normal".' }),
    quantity: z.int(),
    valueCents: z.int(),
  })
  .meta({ id: 'ReportProductPriceList' });

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
    priceLists: z.array(ProductPriceListLineSchema).meta({
      description:
        'Quantidade e valor vendidos em cada tabela (`order_items.price_list_id`); só aparece quando houve venda com tabela de preço.',
    }),
  })
  .meta({ id: 'ReportProductLine' });

export const PaymentMethodLineSchema = z
  .object({
    method: PaymentMethodSchema,
    salesCents: z.int().meta({ description: 'Pagamentos de comandas.' }),
    settlementsCents: z.int().meta({ description: 'Quitações de fiado.' }),
    totalCents: z.int(),
  })
  .meta({ id: 'ReportPaymentMethodLine' });

export const StaffLineSchema = z
  .object({
    actor: ReportActorSchema,
    tabsOpened: z.int(),
    ordersSent: z.int().meta({ description: 'Pedidos lançados.' }),
    receivedCents: z.int().meta({ description: 'Pagamentos não estornados recebidos.' }),
    itemsCanceled: z.int().meta({ description: 'Unidades de itens canceladas.' }),
    tabsCanceled: z.int(),
    discountCount: z.int().meta({ description: 'Descontos em vigor dados por quem.' }),
    discountsCents: z.int(),
  })
  .meta({ id: 'ReportStaffLine', description: 'Linha "Por colaborador" (o dono também aparece).' });

export const ReportSessionLineSchema = z
  .object({
    sessionId: z.uuid(),
    cashRegisterId: z.uuid(),
    name: z.string(),
    unitId: z.uuid(),
    unitName: z.string(),
    businessDate: z.iso.date(),
    status: CashRegisterSessionStatusSchema,
    responsible: ReportActorSchema,
    openedAt: z.iso.datetime(),
    closedAt: z.iso.datetime().nullable(),
    receivedCents: z.int(),
    differenceCents: z.int().meta({ description: '0 enquanto aberta (RN-07.08).' }),
    pendingTabsCount: z.int().nullable(),
    pendingTabsTotalCents: z.int().nullable(),
  })
  .meta({
    id: 'ReportCashSessionLine',
    description: 'Uma abertura de caixa; tocar abre o relatório do caixa.',
  });

export type ReportSessionLineDto = z.infer<typeof ReportSessionLineSchema>;

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
    tabBusinessDate: z.iso.date().meta({ description: 'Dia da comanda quitada (pode ser outro).' }),
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

const CreditSectionSchema = z.object({
  onCreditCents: z.int(),
  settlementsCents: z.int(),
  tabs: z.array(CreditTabLineSchema).meta({
    description: 'Comandas penduradas (hoje `on_credit` ou já `settled`).',
  }),
  settlements: z.array(SettlementLineSchema).meta({
    description: 'Quitações não estornadas recebidas.',
  }),
});

const CancellationsSectionSchema = z.object({
  wasteCents: z.int(),
  wasteQuantity: z.int(),
  items: z.array(CanceledItemLineSchema),
  tabs: z.array(CanceledTabLineSchema),
});

const SummarySchema = z
  .object({
    ...TotalsShape,
    canceledTabCount: z.int(),
    averageTicketCents: z.int().meta({
      description: 'Venda ÷ comandas, arredondado para baixo; 0 sem comandas.',
    }),
  })
  .meta({ id: 'ReportSummary' });

// ------------------------------------------------------------------------------------------------
// Day or period report (spec 07, section 4)
// ------------------------------------------------------------------------------------------------

/** Unnamed: query schemas never carry `.meta({ id })`. */
export const PeriodQuerySchema = z.object({
  unitId: z.uuid().optional().meta({ description: 'Unidade; sem ela, todas da organização.' }),
  from: PlainDateSchema.optional().meta({
    description: 'Primeiro dia de operação (AAAA-MM-DD). Padrão: 29 dias antes de `to`.',
  }),
  to: PlainDateSchema.optional().meta({
    description: 'Último dia de operação, inclusive (AAAA-MM-DD). Padrão: hoje.',
  }),
});

export type PeriodQuery = z.infer<typeof PeriodQuerySchema>;

export const SummaryReportSchema = z
  .object({
    unit: z
      .object({ id: z.uuid(), name: z.string() })
      .nullable()
      .meta({ description: '`null` = todas as unidades.' }),
    period: PeriodSchema,
    partial: z.boolean().meta({
      description:
        'Inclui o dia de operação atual de uma unidade com caixa aberto: faixa "Em andamento — valores parciais" (RN-07.06).',
    }),
    summary: SummarySchema,
    openTabsNow: z
      .object({ count: z.int(), totalCents: z.int() })
      .nullable()
      .meta({ description: 'Quando parcial: comandas em aberto agora (quantidade e valor).' }),
    products: z
      .array(ProductLineSchema)
      .meta({ description: 'Por produto, maior valor primeiro.' }),
    paymentMethods: z.array(PaymentMethodLineSchema).meta({
      description: 'Sempre as quatro formas, na ordem `cash`, `pix`, `credit_card`, `debit_card`.',
    }),
    staff: z
      .array(StaffLineSchema)
      .meta({ description: 'Por colaborador, maior recebido primeiro.' }),
    cashSessions: z.array(ReportSessionLineSchema).meta({
      description: 'Uma linha por abertura de caixa do período, mais recente primeiro.',
    }),
    credit: CreditSectionSchema,
    cancellations: CancellationsSectionSchema,
    events: z
      .array(
        z.object({
          eventId: z.uuid(),
          contractorName: z.string(),
          status: ContractedEventStatusSchema,
          salesCents: z.int().meta({ description: 'Venda das comandas do evento no período.' }),
        }),
      )
      .meta({
        description: 'Eventos com comandas no período; vazio quando não houve (a seção some).',
      }),
  })
  .meta({ id: 'SummaryReport', description: 'Relatório do dia ou do período (spec 07, seção 4).' });

export type SummaryReportDto = z.infer<typeof SummaryReportSchema>;

// ------------------------------------------------------------------------------------------------
// Cash register session report (spec 07, section 5)
// ------------------------------------------------------------------------------------------------

export const SessionReportSchema = z
  .object({
    session: CashRegisterSessionSchema,
    unitName: z.string(),
    responsible: ReportActorSchema,
    closedByActor: ReportActorSchema.nullable(),
    partial: z.boolean().meta({ description: 'Abertura em andamento (RN-07.06).' }),
    timeZone: z.literal('America/Sao_Paulo'),
    totals: ReportTotalsSchema.meta({
      description:
        'Recebido (vendas e quitações) e diferença desta abertura; sem venda, porque uma comanda pode ser paga em mais de um caixa (RN-07.09).',
    }),
    byMethod: z
      .array(
        z.object({
          method: PaymentMethodSchema,
          expectedCents: z.int(),
          informedCents: z.int().nullable(),
          differenceCents: z.int().nullable(),
          salesCents: z.int(),
          settlementsCents: z.int(),
        }),
      )
      .meta({ description: 'Esperado, informado e diferença de cada forma; vendas e quitações.' }),
    movements: z.array(
      z.object({
        id: z.uuid(),
        type: CashMovementTypeSchema,
        amountCents: z.int(),
        reason: z.string(),
        createdBy: ReportActorSchema,
        createdAt: z.iso.datetime(),
      }),
    ),
    payments: z
      .array(
        z.object({
          paymentId: z.uuid(),
          tabId: z.uuid(),
          tabNumber: z.int(),
          customerName: z.string(),
          method: PaymentMethodSchema,
          amountCents: z.int(),
          changeCents: z.int().nullable(),
          isCreditSettlement: z.boolean(),
          receivedBy: ReportActorSchema,
          receivedAt: z.iso.datetime(),
          reversedAt: z.iso.datetime().nullable(),
          reversalReason: z.string().nullable(),
        }),
      )
      .meta({ description: 'Pagamentos da abertura, com os estornos marcados.' }),
    pending: z
      .object({ count: z.int(), totalCents: z.int() })
      .nullable()
      .meta({ description: 'Comandas que seguiram abertas no fechamento (RN-05.28).' }),
  })
  .meta({ id: 'CashSessionReport', description: 'Relatório do caixa (spec 07, seção 5).' });

export type SessionReportDto = z.infer<typeof SessionReportSchema>;

// ------------------------------------------------------------------------------------------------
// Event report (spec 07, section 6)
// ------------------------------------------------------------------------------------------------

export const EventReportSchema = z
  .object({
    event: ContractedEventSchema,
    unitName: z.string(),
    partial: z.boolean().meta({ description: 'Evento em andamento (RN-07.06).' }),
    timeZone: z.literal('America/Sao_Paulo'),
    summary: SummarySchema,
    agreement: z.object({
      consumedQuantity: z.int().meta({
        description: 'Unidades não canceladas das comandas do evento que contam na venda.',
      }),
      consumedCents: z.int().meta({ description: 'Valor consumido (= venda do evento).' }),
      quantityDifference: z.int().nullable().meta({
        description:
          'Quantidade combinada − consumida (CA-07.03); negativa se passou do combinado; `null` sem quantidade combinada.',
      }),
    }),
    products: z.array(ProductLineSchema),
    tabs: z.array(
      z.object({
        tabId: z.uuid(),
        number: z.int(),
        customerName: z.string(),
        status: TabStatusSchema,
        businessDate: z.iso.date(),
        totalCents: z.int(),
        paidCents: z.int(),
        balanceCents: z.int().meta({ description: 'Saldo atual (as penduradas, a receber).' }),
      }),
    ),
    credit: CreditSectionSchema,
    cancellations: CancellationsSectionSchema,
  })
  .meta({ id: 'EventReport', description: 'Relatório do evento (spec 07, seção 6).' });

export type EventReportDto = z.infer<typeof EventReportSchema>;

// ------------------------------------------------------------------------------------------------
// Histories (spec 07, section 7)
// ------------------------------------------------------------------------------------------------

export const HistoryQuerySchema = KeysetPaginationQuerySchema.extend(PeriodQuerySchema.shape);

export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;

export const DayHistoryRowSchema = z
  .object({
    unitId: z.uuid(),
    unitName: z.string(),
    businessDate: z.iso.date(),
    partial: z.boolean().meta({ description: 'Dia atual com caixa aberto (RN-07.06).' }),
    ...TotalsShape,
  })
  .meta({ id: 'DayHistoryRow' });

export type DayHistoryRowDto = z.infer<typeof DayHistoryRowSchema>;

export const DayHistorySchema = pageSchema('DayHistory', DayHistoryRowSchema)
  .extend({ period: PeriodSchema, totals: ReportTotalsSchema })
  .meta({
    id: 'DayHistory',
    description:
      'Dias de operação do período, um por unidade, mais recentes primeiro, com os totais do período inteiro (spec 07, seção 7).',
  });

export type DayHistoryDto = z.infer<typeof DayHistorySchema>;

export const SessionHistoryQuerySchema = HistoryQuerySchema.extend({
  cashRegisterId: z.uuid().optional().meta({ description: 'Só as aberturas deste caixa.' }),
});

export type SessionHistoryQuery = z.infer<typeof SessionHistoryQuerySchema>;

export const SessionHistorySchema = pageSchema('CashSessionHistory', ReportSessionLineSchema)
  .extend({ period: PeriodSchema, totals: ReportTotalsSchema })
  .meta({
    id: 'CashSessionHistory',
    description:
      'Aberturas de caixa do período, mais recentes primeiro, com os totais do período inteiro.',
  });

export type SessionHistoryDto = z.infer<typeof SessionHistorySchema>;

export const EventHistoryQuerySchema = HistoryQuerySchema.extend({
  status: ContractedEventStatusSchema.optional(),
});

export type EventHistoryQuery = z.infer<typeof EventHistoryQuerySchema>;

export const EventHistoryRowSchema = z
  .object({
    eventId: z.uuid(),
    unitId: z.uuid(),
    unitName: z.string(),
    contractorName: z.string(),
    startsOn: z.iso.date(),
    endsOn: z.iso.date().nullable(),
    status: ContractedEventStatusSchema,
    salesCents: z.int(),
    consumedQuantity: z.int(),
    agreedQuantity: z.int().nullable(),
    quantityDifference: z.int().nullable(),
  })
  .meta({ id: 'EventHistoryRow' });

export const EventHistorySchema = pageSchema('EventHistory', EventHistoryRowSchema)
  .extend({ period: PeriodSchema, totals: ReportTotalsSchema })
  .meta({
    id: 'EventHistory',
    description:
      'Eventos que começam no período, mais recentes primeiro; os totais são os do período inteiro (dias de operação).',
  });

export type EventHistoryDto = z.infer<typeof EventHistorySchema>;
