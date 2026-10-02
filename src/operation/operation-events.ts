import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { defineRealtimeEvent } from '../realtime/realtime.contracts.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { type CashRegisterDto, CashRegisterSchema } from './cash.schemas.js';
import { type ContractedEventDto, ContractedEventSchema } from './events.schemas.js';
import {
  type OrderDto,
  type OrderItemDto,
  OrderItemSchema,
  OrderSchema,
  type TabSummaryDto,
  TabSummarySchema,
} from './operation.schemas.js';
import { type UnitOperationDto, UnitOperationSchema } from './unit-operation.schemas.js';

/*
 * Real-time events of the operation (spec 04, section 7.1). Envelope of spec 01, section 10, sent
 * after the commit to `unit:{unitId}` and, for items, to `station:{stationId}`.
 */

export const UnitOperationUpdated = defineRealtimeEvent(
  'EventUnitOperationUpdated',
  'unit.operation_updated',
  UnitOperationSchema,
  'Situação da operação da unidade (mesmo formato do `GET /units/{id}/operation`), sala `unit`. Sai ao abrir ou fechar caixa, trocar a tabela vigente, iniciar ou encerrar evento e mudar o dia de operação: os balcões recarregam os preços (spec 04, seção 7.1). `version` é a versão da operação.',
);

export const ContractedEventUpdated = defineRealtimeEvent(
  'EventContractedEventUpdated',
  'event.updated',
  ContractedEventSchema,
  'Evento contratado criado, alterado, iniciado, encerrado ou cancelado (sala `unit`). `version` é a do evento.',
);

export const TabCreated = defineRealtimeEvent(
  'EventTabCreated',
  'tab.created',
  TabSummarySchema,
  'Comanda criada, com totais (sala `unit`).',
);

export const TabUpdated = defineRealtimeEvent(
  'EventTabUpdated',
  'tab.updated',
  TabSummarySchema,
  'Comanda com situação, totais, saldo, contadores e `version` novos (sala `unit`): pedido novo, item cancelado, pedir a conta, reabrir, cancelar, desconto, pagamento e estorno (spec 05), e mudança de etapa que altere `readyItemCount` ou `lateItemCount`.',
);

export const OrderCreated = defineRealtimeEvent(
  'EventOrderCreated',
  'order.created',
  OrderSchema,
  'Pedido enviado. Na sala `unit` vai completo; na sala de cada `station`, só com os itens daquela estação (CA-04.03).',
);

export const OrderItemStageChanged = defineRealtimeEvent(
  'EventOrderItemStageChanged',
  'order_item.stage_changed',
  z.object({
    item: OrderItemSchema.meta({
      description:
        'A linha que mudou de etapa (a linha nova, quando avançou só parte da quantidade).',
    }),
    previousStageId: z.uuid(),
    previousStationId: z.uuid().nullable().meta({
      description:
        'Estação em que a linha estava: sai da fila dela se for diferente de `item.stationId`.',
    }),
    remaining: OrderItemSchema.nullable().meta({
      description:
        'Avanço de parte da quantidade (RN-04.24): a linha original, com o restante, na etapa em que estava.',
    }),
  }),
  'Item mudou de etapa (avançar ou voltar). Vai à sala `unit` e às salas `station` de origem e de destino (CA-04.04). `version` é a do item.',
);

export const OrderItemCanceled = defineRealtimeEvent(
  'EventOrderItemCanceled',
  'order_item.canceled',
  z.object({
    item: OrderItemSchema.meta({ description: 'A linha cancelada.' }),
    previousStationId: z.uuid().nullable().meta({
      description: 'Estação em que a linha estava antes do cancelamento.',
    }),
    remaining: OrderItemSchema.nullable().meta({
      description: 'Cancelamento parcial (RN-04.26): a linha original, com o restante, ativa.',
    }),
  }),
  'Item cancelado (sala `unit` e sala `station` em que estava). `version` é a do item.',
);

export const OrderCompleted = defineRealtimeEvent(
  'EventOrderCompleted',
  'order.completed',
  z.object({ orderId: z.uuid(), tabId: z.uuid() }),
  'Todos os itens do pedido estão na etapa final ou cancelados (sala `unit`). `version` é a do pedido.',
);

export const CashRegisterOpened = defineRealtimeEvent(
  'EventCashRegisterOpened',
  'cash_register.opened',
  CashRegisterSchema,
  'Caixa aberto: `session` é a abertura nova (sala `unit`, spec 05). `version` é a do caixa.',
);

export const CashRegisterUpdated = defineRealtimeEvent(
  'EventCashRegisterUpdated',
  'cash_register.updated',
  CashRegisterSchema,
  'Caixa alterado: pagamento, estorno, sangria ou suprimento na abertura em andamento, ou o cadastro do caixa (sala `unit`, spec 05).',
);

export const CashRegisterClosed = defineRealtimeEvent(
  'EventCashRegisterClosed',
  'cash_register.closed',
  CashRegisterSchema,
  'Caixa fechado: `session` é a abertura fechada, com a conferência em `counts` e os pendentes (sala `unit`, spec 05).',
);

export const operationEventSchemas: readonly z.ZodType[] = [
  CashRegisterOpened.schema,
  CashRegisterUpdated.schema,
  CashRegisterClosed.schema,
  UnitOperationUpdated.schema,
  ContractedEventUpdated.schema,
  TabCreated.schema,
  TabUpdated.schema,
  OrderCreated.schema,
  OrderItemStageChanged.schema,
  OrderItemCanceled.schema,
  OrderCompleted.schema,
];

function distinctStations(...ids: (string | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

/** Emits the events of spec 04, section 7.1, after the commit of the current transaction. */
@Injectable()
export class OperationEvents {
  constructor(private readonly realtime: RealtimeService) {}

  operation(operation: UnitOperationDto): void {
    this.realtime.emitToUnit(UnitOperationUpdated, {
      unitId: operation.unitId,
      version: operation.version,
      data: operation,
    });
  }

  contractedEvent(event: ContractedEventDto): void {
    this.realtime.emitToUnit(ContractedEventUpdated, {
      unitId: event.unitId,
      version: event.version,
      data: event,
    });
  }

  tab(event: typeof TabCreated | typeof TabUpdated, tab: TabSummaryDto): void {
    this.realtime.emitToUnit(event, { unitId: tab.unitId, version: tab.version, data: tab });
  }

  cashRegister(
    event: typeof CashRegisterOpened | typeof CashRegisterUpdated | typeof CashRegisterClosed,
    register: CashRegisterDto,
  ): void {
    this.realtime.emitToUnit(event, {
      unitId: register.unitId,
      version: register.version,
      data: register,
    });
  }

  /** The whole order to the unit; each station gets only its own items (CA-04.03). */
  orderCreated(order: OrderDto): void {
    const payload = { unitId: order.unitId, version: order.version };
    this.realtime.emitToUnit(OrderCreated, { ...payload, data: order });
    for (const stationId of distinctStations(...order.items.map((item) => item.stationId))) {
      this.realtime.emitToStation(stationId, OrderCreated, {
        ...payload,
        data: { ...order, items: order.items.filter((item) => item.stationId === stationId) },
      });
    }
  }

  /** To the unit and to the stations the line leaves and enters (CA-04.04). */
  stageChanged(
    item: OrderItemDto,
    previous: { stageId: string; stationId: string | null },
    remaining: OrderItemDto | null,
  ): void {
    const payload = {
      unitId: item.unitId,
      version: item.version,
      data: {
        item,
        previousStageId: previous.stageId,
        previousStationId: previous.stationId,
        remaining,
      },
    };
    this.realtime.emitToUnitAndStations(
      distinctStations(previous.stationId, item.stationId),
      OrderItemStageChanged,
      payload,
    );
  }

  canceled(
    item: OrderItemDto,
    previousStationId: string | null,
    remaining: OrderItemDto | null,
  ): void {
    const payload = {
      unitId: item.unitId,
      version: item.version,
      data: { item, previousStationId, remaining },
    };
    this.realtime.emitToUnitAndStations(
      distinctStations(previousStationId),
      OrderItemCanceled,
      payload,
    );
  }

  orderCompleted(order: { id: string; tabId: string; version: number }, unitId: string): void {
    this.realtime.emitToUnit(OrderCompleted, {
      unitId,
      version: order.version,
      data: { orderId: order.id, tabId: order.tabId },
    });
  }
}
