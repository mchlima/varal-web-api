import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { updateWithVersion } from '../common/versioned-update.js';
import { AppError } from '../errors/app-error.js';
import type { OrderItem } from '../generated/prisma/client.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { stationForStage } from '../units/routing.js';
import {
  hasCounter,
  hasStation,
  OperationAccessService,
  type OperatorAccess,
} from './operation-access.js';
import { operationError } from './operation-errors.js';
import { OperationEvents, TabUpdated } from './operation-events.js';
import {
  itemInclude,
  itemOrder,
  type ItemRow,
  loadTabSummary,
  loadUnitFlow,
  neighbours,
  splitCopy,
  toOrderItemDto,
  type UnitFlow,
} from './operation-reader.js';
import type {
  AdvanceOrderResultDto,
  ItemChangeDto,
  OrderItemDto,
  StationOrderDto,
  StationQueueDto,
} from './operation.schemas.js';
import { afterSent, isLate, isWaste, lateAtOf } from './order-rules.js';
import { settleIfCovered } from './payments.service.js';
import { lockRow } from './row-lock.js';
import { activePaymentIds, currentBusinessDate } from './tabs.service.js';

/** The item, locked, with the context of its unit. */
interface LockedItem {
  row: ItemRow;
  flow: UnitFlow;
  access: OperatorAccess;
  now: Date;
}

/**
 * Items of the orders (spec 04, sections 5.1 and 5.2): advance and go back a stage, advance or
 * cancel part of the quantity, and the queue of a station. Every change locks the item and checks
 * the `version` the device saw: a device that lost the race gets 409 `ITEM_CHANGED` with the current
 * state (CA-04.05).
 */
@Injectable()
export class OrderItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: OperationAccessService,
    private readonly events: OperationEvents,
  ) {}

  /**
   * RN-04.20, RN-04.21, RN-04.24 (CA-04.13): moves the line, or `quantity` of it, to the next stage.
   * Who may: the owner, staff with the station where the item is, and the counter when the next
   * stage is the final one (registering the delivery).
   */
  async advance(
    itemId: string,
    input: { version: number; quantity?: number | undefined },
  ): Promise<ItemChangeDto> {
    return this.prisma.transaction(async (db) => {
      const { row, flow, access, now } = await this.lockItem(db, itemId, input.version);
      if (row.canceledAt !== null) {
        throw operationError('ITEM_CANCELED');
      }
      const { current, next } = neighbours(flow, row.stageId);
      if (!current || current.isFinal || !next) {
        throw operationError('ITEM_IN_FINAL_STAGE');
      }
      const allowed = hasStation(access, row.stationId) || (next.isFinal && hasCounter(access));
      if (!allowed) {
        throw forbiddenItem();
      }
      const quantity = this.quantityOf(row, input.quantity);
      const target = {
        stageId: next.id,
        stationId: stationForStage(next, row.prepStationId),
        stageEnteredAt: now,
      };
      const { changedId, remainingId } = await this.moveOrSplit(db, row, quantity, target);
      const result = await this.result(db, flow, now, changedId, remainingId);
      await this.audit.record(db, {
        action: 'order_item.stage_changed',
        entityType: 'order_item',
        entityId: changedId,
        before: { stageId: row.stageId, stationId: row.stationId },
        after: { stageId: next.id, stationId: target.stationId },
        metadata: {
          unitId: row.unitId,
          direction: 'forward',
          quantity,
          ...(remainingId === null ? {} : { splitFromId: row.id }),
        },
      });
      this.events.stageChanged(
        result.changed,
        { stageId: row.stageId, stationId: row.stationId },
        result.remaining,
      );
      const wasLate = isLate(
        lateAtOf(
          { canceledAt: null, inFinalStage: false, sentAt: row.order.sentAt },
          flow.limitsOf(row.prepStationId).lateAfterMinutes,
        ),
        now,
      );
      await this.tabCountersChanged(
        db,
        row.tabId,
        isReadyStage(flow, row.stageId) || isReadyStage(flow, next.id) || (next.isFinal && wasLate),
        now,
      );
      await this.completeOrderIfDone(db, row.orderId, row.unitId, now);
      return result;
    });
  }

  /**
   * RN-04.22: back to the previous stage, audited. Never from the final stage. Who may: whoever
   * may advance the item in its stage or in the stage it returns to (so the one who advanced by
   * mistake can undo it).
   */
  async back(itemId: string, input: { version: number }): Promise<ItemChangeDto> {
    return this.prisma.transaction(async (db) => {
      const { row, flow, access, now } = await this.lockItem(db, itemId, input.version);
      if (row.canceledAt !== null) {
        throw operationError('ITEM_CANCELED');
      }
      const { current, next, previous } = neighbours(flow, row.stageId);
      if (!current || current.isFinal) {
        throw operationError('ITEM_IN_FINAL_STAGE');
      }
      if (!previous) {
        throw operationError('NO_PREVIOUS_STAGE');
      }
      const previousStationId = stationForStage(previous, row.prepStationId);
      const allowed =
        hasStation(access, row.stationId) ||
        hasStation(access, previousStationId) ||
        (next?.isFinal === true && hasCounter(access));
      if (!allowed) {
        throw forbiddenItem();
      }
      await updateWithVersion<OrderItem>(db.orderItem, {
        where: { id: row.id },
        expectedVersion: row.version,
        data: { stageId: previous.id, stationId: previousStationId, stageEnteredAt: now },
      });
      const result = await this.result(db, flow, now, row.id, null);
      await this.audit.record(db, {
        action: 'order_item.stage_reverted',
        entityType: 'order_item',
        entityId: row.id,
        before: { stageId: row.stageId, stationId: row.stationId },
        after: { stageId: previous.id, stationId: previousStationId },
        metadata: { unitId: row.unitId, direction: 'back', quantity: row.quantity },
      });
      this.events.stageChanged(
        result.changed,
        { stageId: row.stageId, stationId: row.stationId },
        null,
      );
      await this.tabCountersChanged(
        db,
        row.tabId,
        isReadyStage(flow, row.stageId) || isReadyStage(flow, previous.id),
        now,
      );
      return result;
    });
  }

  /**
   * RN-04.25 to RN-04.28 (CA-04.08): cancels the line, or `quantity` of it, with a reason. Waste
   * after the first stage. Who may: the counter and the station where the item is. Not in a tab
   * already paid, on credit, settled or canceled.
   */
  async cancel(
    itemId: string,
    input: { version: number; quantity?: number | undefined; reason: string },
  ): Promise<ItemChangeDto> {
    return this.prisma.transaction(async (db) => {
      const { row, flow, access, now } = await this.lockItem(db, itemId, input.version);
      if (row.canceledAt !== null) {
        throw operationError('ITEM_CANCELED');
      }
      if (!hasCounter(access) && !hasStation(access, row.stationId)) {
        throw forbiddenItem();
      }
      // The tab after the item (same lock order as every item change): its totals change.
      await lockRow(db, 'tabs', row.tabId);
      const tab = await db.tab.findUniqueOrThrow({ where: { id: row.tabId } });
      if (tab.status === 'paid') {
        // RN-04.28, RN-05.14: reverse the payment first (the tab goes back to `closing`), then
        // cancel the item and receive again, or cancel the tab.
        throw operationError('TAB_PAID', { paymentIds: await activePaymentIds(db, tab.id) });
      }
      if (tab.status !== 'open' && tab.status !== 'closing') {
        throw operationError('TAB_CLOSED');
      }
      const quantity = this.quantityOf(row, input.quantity);
      const wasted = isWaste(row.stage.sortOrder, flow.first.sortOrder);
      const actor = access.actor;
      const canceled = {
        canceledAt: now,
        // RN-04.27, RN-04.30: waste counts by the day of operation of the cancellation.
        canceledBusinessDate: await currentBusinessDate(db, row.unitId),
        canceledByType: actor.type,
        canceledById: actor.id,
        cancelReason: input.reason,
        wasted,
        stationId: null,
      };
      let changedId = row.id;
      let remainingId: string | null = null;
      if (quantity === row.quantity) {
        await updateWithVersion<OrderItem>(db.orderItem, {
          where: { id: row.id },
          expectedVersion: row.version,
          data: canceled,
        });
      } else {
        // RN-04.26: a canceled line with the canceled quantity; the original keeps the rest.
        changedId = await this.split(db, row, quantity, {
          ...canceled,
          stageId: row.stageId,
          stageEnteredAt: row.stageEnteredAt,
        });
        remainingId = row.id;
      }
      await db.tab.update({ where: { id: tab.id }, data: { version: { increment: 1 } } });
      const totals = await loadTabSummary(db, tab.id, now);
      if (totals.balanceCents < 0) {
        // RN-05.07: what was already paid never goes past the total; reverse a payment first.
        throw operationError('TAB_PAYMENTS_EXCEED_TOTAL', {
          paidCents: totals.paidCents,
          totalCents: totals.totalCents,
        });
      }
      const result = await this.result(db, flow, now, changedId, remainingId);
      await this.audit.record(db, {
        action: 'order_item.canceled',
        entityType: 'order_item',
        entityId: changedId,
        before: { canceledAt: null },
        after: { canceledAt: now.toISOString(), wasted },
        metadata: {
          unitId: row.unitId,
          reason: input.reason,
          quantity,
          stageId: row.stageId,
          ...(remainingId === null ? {} : { splitFromId: row.id }),
        },
      });
      this.events.canceled(result.changed, row.stationId, result.remaining);
      // RN-05.10: the cancel may leave the tab fully paid.
      await settleIfCovered(db, this.audit, tab.id);
      this.events.tab(TabUpdated, await loadTabSummary(db, tab.id, now));
      await this.completeOrderIfDone(db, row.orderId, row.unitId, now);
      return result;
    });
  }

  /**
   * `GET /stations/{id}/queue` (RN-04.40 to RN-04.45; CA-04.20 to CA-04.22): one card per order
   * with at least one line pending at the station, oldest first. Each card has the lines of the
   * order that are of this station (pending, done here, canceled here), "+ N itens em outra
   * estação" and the times of the station (RN-04.46). The owner and staff with the station.
   */
  async queue(stationId: string): Promise<StationQueueDto> {
    const db = this.prisma.db;
    const station = await db.station.findUnique({ where: { id: stationId } });
    if (!station) {
      throw AppError.of('NOT_FOUND');
    }
    const access = await this.access.forUnit(db, station.unitId);
    if (!hasStation(access, stationId)) {
      throw AppError.of('FORBIDDEN', { message: 'Você não tem acesso a esta estação.' });
    }
    const flow = await loadUnitFlow(db, station.unitId);
    const limits = flow.limitsOf(stationId);
    const now = new Date();
    const orders = await db.order.findMany({
      where: { items: { some: { stationId, canceledAt: null } } },
      include: { tab: { select: { mode: true } } },
      orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
    });
    const rows = await db.orderItem.findMany({
      where: { orderId: { in: orders.map((order) => order.id) } },
      include: itemInclude,
      orderBy: itemOrder,
    });
    return {
      stationId,
      unitId: station.unitId,
      attentionAfterMinutes: limits.attentionAfterMinutes,
      lateAfterMinutes: limits.lateAfterMinutes,
      stages: flow.stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        sortOrder: stage.sortOrder,
        target: stage.target,
        stationId: stage.stationId,
        isFinal: stage.isFinal,
      })),
      orders: orders.map((order): StationOrderDto => {
        const own = rows.filter((row) => row.orderId === order.id);
        const lines = own.flatMap((row) => {
          const state = lineState(flow, row, stationId);
          return state === null ? [] : [{ ...toOrderItemDto(row, flow, now), state }];
        });
        const others = own.filter(
          (row) =>
            row.canceledAt === null &&
            row.stationId !== null &&
            lineState(flow, row, stationId) === null,
        );
        const first = own[0];
        return {
          orderId: order.id,
          tabId: order.tabId,
          tabNumber: first?.tab.number ?? 0,
          customerName: first?.tab.customerName ?? '',
          tabMode: order.tab.mode,
          numberInTab: order.numberInTab,
          isAdditional: order.numberInTab > 1,
          sentAt: order.sentAt.toISOString(),
          attentionAt: afterSent(order.sentAt, limits.attentionAfterMinutes).toISOString(),
          lateAt: afterSent(order.sentAt, limits.lateAfterMinutes).toISOString(),
          lines,
          otherStationsQuantity: others.reduce((sum, row) => sum + row.quantity, 0),
        };
      }),
    };
  }

  /**
   * `POST /orders/{id}/advance` (RN-04.39, CA-04.17): advances at once every line of the order that
   * is at the station (and stage, with the filter), each to the next stage of its own. All or none:
   * the lines sent must be exactly those, with the versions the device saw; otherwise 409
   * `ITEM_CHANGED` with the current lines and nothing is applied.
   */
  async advanceOrder(
    orderId: string,
    input: {
      stationId: string;
      stageId?: string | undefined;
      items: { id: string; version: number }[];
    },
  ): Promise<AdvanceOrderResultDto> {
    return this.prisma.transaction(async (db) => {
      const order = await db.order.findUnique({ where: { id: orderId } });
      if (!order) {
        throw AppError.of('NOT_FOUND');
      }
      const stationId = input.stationId.toLowerCase();
      const stageId = input.stageId?.toLowerCase();
      const ids = [...new Set(input.items.map((item) => item.id.toLowerCase()))].sort();
      // Same lock order as single changes: items (by id), then the tab.
      for (const id of ids) {
        await lockRow(db, 'order_items', id);
      }
      const atStation = await db.orderItem.findMany({
        where: {
          orderId,
          stationId,
          canceledAt: null,
          ...(stageId === undefined ? {} : { stageId }),
        },
        include: itemInclude,
        orderBy: itemOrder,
      });
      if (atStation.length === 0) {
        throw operationError('ITEM_NOT_AT_STATION');
      }
      const unitId = atStation[0]?.unitId ?? '';
      const access = await this.access.forUnit(db, unitId);
      const flow = await loadUnitFlow(db, unitId);
      const now = new Date();
      const sent = new Map(input.items.map((item) => [item.id.toLowerCase(), item.version]));
      const same =
        atStation.length === sent.size &&
        atStation.every((row) => sent.get(row.id) === row.version);
      if (!same) {
        throw operationError('ITEM_CHANGED', {
          items: atStation.map((row) => toOrderItemDto(row, flow, now)),
        });
      }
      const moves = atStation.map((row) => {
        const { current, next } = neighbours(flow, row.stageId);
        if (!current || current.isFinal || !next) {
          throw operationError('ITEM_IN_FINAL_STAGE');
        }
        return { row, next };
      });
      const allowed =
        hasStation(access, stationId) ||
        (moves.every((move) => move.next.isFinal) && hasCounter(access));
      if (!allowed) {
        throw forbiddenItem();
      }
      let countersChanged = false;
      for (const { row, next } of moves) {
        const target = {
          stageId: next.id,
          stationId: stationForStage(next, row.prepStationId),
          stageEnteredAt: now,
        };
        await updateWithVersion<OrderItem>(db.orderItem, {
          where: { id: row.id },
          expectedVersion: row.version,
          data: target,
        });
        await this.audit.record(db, {
          action: 'order_item.stage_changed',
          entityType: 'order_item',
          entityId: row.id,
          before: { stageId: row.stageId, stationId: row.stationId },
          after: { stageId: next.id, stationId: target.stationId },
          metadata: { unitId, direction: 'forward', quantity: row.quantity, wholeOrder: true },
        });
        countersChanged ||=
          isReadyStage(flow, row.stageId) || isReadyStage(flow, next.id) || next.isFinal;
      }
      const changed = await db.orderItem.findMany({
        where: { id: { in: atStation.map((row) => row.id) } },
        include: itemInclude,
        orderBy: itemOrder,
      });
      const dtos = changed.map((row) => toOrderItemDto(row, flow, now));
      for (const dto of dtos) {
        const before = atStation.find((row) => row.id === dto.id);
        if (before) {
          this.events.stageChanged(
            dto,
            { stageId: before.stageId, stationId: before.stationId },
            null,
          );
        }
      }
      await this.tabCountersChanged(db, order.tabId, countersChanged, now);
      await this.completeOrderIfDone(db, orderId, unitId, now);
      return { orderId, items: dtos };
    });
  }

  /**
   * Ajuste da fase 5: the varal counts items ready to deliver and late per tab (`readyItemCount`,
   * `lateItemCount`). A stage change that moves them bumps the tab version and emits `tab.updated`
   * with totals and counters; other stage changes emit nothing more. Same lock order as the
   * cancel: item, then tab.
   */
  private async tabCountersChanged(
    db: TenantDb,
    tabId: string,
    changed: boolean,
    now: Date,
  ): Promise<void> {
    if (!changed) {
      return;
    }
    await lockRow(db, 'tabs', tabId);
    await db.tab.update({ where: { id: tabId }, data: { version: { increment: 1 } } });
    this.events.tab(TabUpdated, await loadTabSummary(db, tabId, now));
  }

  /**
   * Locks the line and checks the version the device saw (CA-04.05): a stale version is a 409
   * `ITEM_CHANGED` with the current state, so the device refreshes the card without acting.
   */
  private async lockItem(
    db: TenantDb,
    itemId: string,
    expectedVersion: number,
  ): Promise<LockedItem> {
    if (!(await lockRow(db, 'order_items', itemId))) {
      throw AppError.of('NOT_FOUND');
    }
    const row = await db.orderItem.findUniqueOrThrow({
      where: { id: itemId },
      include: itemInclude,
    });
    const access = await this.access.forUnit(db, row.unitId);
    const flow = await loadUnitFlow(db, row.unitId);
    const now = new Date();
    if (row.version !== expectedVersion) {
      throw operationError('ITEM_CHANGED', {
        currentVersion: row.version,
        item: toOrderItemDto(row, flow, now),
      });
    }
    return { row, flow, access, now };
  }

  /** RN-04.24, RN-04.26: from 1 to the quantity of the line; default: all of it. */
  private quantityOf(row: ItemRow, requested: number | undefined): number {
    const quantity = requested ?? row.quantity;
    if (quantity < 1 || quantity > row.quantity) {
      throw operationError('INVALID_QUANTITY', { quantity: row.quantity });
    }
    return quantity;
  }

  /**
   * Moves the whole line to `target`, or (RN-04.24) splits it: a new line with `quantity` goes to
   * `target` pointing to the original (`split_from_id`); the original keeps the rest, its stage
   * and `stage_entered_at`.
   */
  private async moveOrSplit(
    db: TenantDb,
    row: ItemRow,
    quantity: number,
    target: { stageId: string; stationId: string | null; stageEnteredAt: Date },
  ): Promise<{ changedId: string; remainingId: string | null }> {
    if (quantity === row.quantity) {
      await updateWithVersion<OrderItem>(db.orderItem, {
        where: { id: row.id },
        expectedVersion: row.version,
        data: target,
      });
      return { changedId: row.id, remainingId: null };
    }
    const changedId = await this.split(db, row, quantity, target);
    return { changedId, remainingId: row.id };
  }

  /**
   * Splits `quantity` of the line into a new line with the same copy of what was sold (modifiers
   * included) and the given state; the original keeps the rest (and gets a new version). The
   * total of the tab does not change.
   */
  private async split(
    db: TenantDb,
    row: ItemRow,
    quantity: number,
    state: {
      stageId: string;
      stationId: string | null;
      stageEnteredAt: Date;
    } & Partial<
      Pick<
        OrderItem,
        | 'canceledAt'
        | 'canceledBusinessDate'
        | 'canceledByType'
        | 'canceledById'
        | 'cancelReason'
        | 'wasted'
      >
    >,
  ): Promise<string> {
    await updateWithVersion<OrderItem>(db.orderItem, {
      where: { id: row.id },
      expectedVersion: row.version,
      data: { quantity: row.quantity - quantity },
    });
    const line = await db.orderItem.create({
      data: { ...splitCopy(row), ...state, quantity },
    });
    if (row.modifiers.length > 0) {
      await db.orderItemModifier.createMany({
        data: row.modifiers.map((modifier) => ({
          organizationId: modifier.organizationId,
          orderItemId: line.id,
          modifierId: modifier.modifierId,
          groupName: modifier.groupName,
          modifierName: modifier.modifierName,
          priceDeltaCents: modifier.priceDeltaCents,
          position: modifier.position,
        })),
      });
    }
    return line.id;
  }

  private async result(
    db: TenantDb,
    flow: UnitFlow,
    now: Date,
    changedId: string,
    remainingId: string | null,
  ): Promise<{ changed: OrderItemDto; remaining: OrderItemDto | null }> {
    const ids = remainingId === null ? [changedId] : [changedId, remainingId];
    const rows = await db.orderItem.findMany({ where: { id: { in: ids } }, include: itemInclude });
    const dto = (id: string) => {
      const row = rows.find((item) => item.id === id);
      if (!row) {
        throw AppError.of('INTERNAL_ERROR');
      }
      return toOrderItemDto(row, flow, now);
    };
    return { changed: dto(changedId), remaining: remainingId === null ? null : dto(remainingId) };
  }

  /** `completed` once every line is in the final stage or canceled; emits `order.completed`. */
  private async completeOrderIfDone(
    db: TenantDb,
    orderId: string,
    unitId: string,
    now: Date,
  ): Promise<void> {
    const pending = await db.orderItem.count({
      where: { orderId, canceledAt: null, stage: { isFinal: false } },
    });
    if (pending > 0) {
      return;
    }
    const [order] = await db.order.updateManyAndReturn({
      where: { id: orderId, status: 'sent' },
      data: { status: 'completed', completedAt: now, version: { increment: 1 } },
    });
    if (order) {
      await this.audit.record(db, {
        action: 'order.completed',
        entityType: 'order',
        entityId: order.id,
        before: { status: 'sent' },
        after: { status: 'completed' },
        metadata: { unitId, tabId: order.tabId },
      });
      this.events.orderCompleted(order, unitId);
    }
  }
}

/**
 * RN-04.40, RN-04.41, RN-04.45: how a line shows on the card of `stationId`, or `null` when it is
 * not of this station. A line belongs to the station when its stage now, or an earlier stage of its
 * path, puts it there (stations come from the stages, spec 03 section 4.2).
 */
function lineState(
  flow: UnitFlow,
  row: ItemRow,
  stationId: string,
): 'pending' | 'done' | 'canceled' | null {
  if (row.canceledAt === null && row.stationId === stationId) {
    return 'pending';
  }
  const index = flow.stages.findIndex((stage) => stage.id === row.stageId);
  const path = index === -1 ? [] : flow.stages.slice(0, index + 1);
  const passed = path.some((stage) => stationForStage(stage, row.prepStationId) === stationId);
  if (!passed) {
    return null;
  }
  if (row.canceledAt !== null) {
    return 'canceled';
  }
  return 'done';
}

/** The stage counted as "pronto para entregar" (`readyItemCount`). */
function isReadyStage(flow: UnitFlow, stageId: string): boolean {
  return flow.beforeFinal !== null && flow.beforeFinal.id === stageId;
}

function forbiddenItem(): AppError {
  return AppError.of('FORBIDDEN', {
    message: 'Você não tem acesso à estação em que este item está.',
  });
}
