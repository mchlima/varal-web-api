import { z } from 'zod';

import { ExpectedVersionSchema } from '../units/units.schemas.js';
import { CashRegisterSchema } from './cash.schemas.js';
import { ContractedEventSchema } from './events.schemas.js';
import { PlainDateSchema } from './operation.schemas.js';

/*
 * Contracts of the operation of a unit (spec 04, section 3; spec 01, section 14.2): day of
 * operation, cash registers, price lists, events and what the start of the panel needs.
 */

const PriceListRefSchema = z
  .object({ id: z.uuid(), name: z.string() })
  .meta({ id: 'PriceListRef' });

export const StaleTabSchema = z
  .object({
    id: z.uuid(),
    number: z.int(),
    customerName: z.string(),
    totalCents: z.int(),
    businessDate: PlainDateSchema.meta({ description: 'Desde quando (dia de operação).' }),
    openedAt: z.iso.datetime(),
  })
  .meta({
    id: 'StaleTab',
    description:
      'Comanda aberta há mais de 2 dias: aviso no início do painel com link para `/balcao/comandas/{numero}` (RN-01.28).',
  });

export const UnitOperationSchema = z
  .object({
    unitId: z.uuid(),
    businessDate: PlainDateSchema.nullable().meta({
      description: 'Dia de operação atual (RN-04.29); `null` antes do primeiro caixa aberto.',
    }),
    inOperation: z.boolean().meta({
      description:
        'Há pelo menos um caixa aberto (RN-04.01): libera abrir comanda e lançar pedido (RN-04.02).',
    }),
    cashRegisters: z.array(CashRegisterSchema).meta({
      description:
        'Caixas ativos da unidade, cada um com a abertura em andamento (responsável, desde quando, `openSinceEarlierDay`) ou a última fechada.',
    }),
    currentPriceList: PriceListRefSchema.nullable().meta({
      description: 'Tabela vigente (RN-04.06); `null` = "Normal".',
    }),
    effectivePriceList: PriceListRefSchema.nullable().meta({
      description:
        'Tabela efetiva: a do evento em andamento ou a vigente (RN-04.32); `null` = "Normal".',
    }),
    eventInProgress: ContractedEventSchema.nullable(),
    eventsToday: z.array(ContractedEventSchema).meta({
      description:
        'Eventos agendados que incluem hoje: a abertura do caixa oferece iniciar (RN-04.35).',
    }),
    openTabs: z.object({
      count: z
        .int()
        .meta({ description: 'Comandas `open` e `closing` da unidade, de qualquer dia.' }),
      totalCents: z.int(),
      fromEarlierDaysCount: z.int().meta({
        description: 'Delas, as abertas antes do dia de operação atual ("3 comandas em aberto").',
      }),
    }),
    staleTabs: z.array(StaleTabSchema).meta({
      description:
        'Comandas `open`/`closing` com dia de operação anterior ao atual menos 2 (RN-01.28), mais antigas primeiro.',
    }),
    itemsInProgress: z.int().meta({ description: 'Unidades de itens em etapas não finais.' }),
    version: z.int().meta({ description: 'Versão da operação (`unit.operation_updated`).' }),
  })
  .meta({
    id: 'UnitOperation',
    description:
      'Situação da operação da unidade (spec 04, seção 7): usada pelo início do painel (RN-01.24) e pelo balcão.',
  });

export type UnitOperationDto = z.infer<typeof UnitOperationSchema>;

export const PutCurrentPriceListRequestSchema = z
  .object({
    priceListId: z.uuid().nullable().meta({
      description: 'Tabela de preço ativa da unidade, ou `null` para "Normal" (RN-04.31).',
    }),
    version: ExpectedVersionSchema.optional().meta({
      description: 'Versão da operação que o aparelho tem (`UnitOperation.version`). Opcional.',
    }),
  })
  .meta({ id: 'PutCurrentPriceListRequest' });
