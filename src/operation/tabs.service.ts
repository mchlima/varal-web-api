import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { updateWithVersion } from '../common/versioned-update.js';
import { requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import type { Shift, Tab } from '../generated/prisma/client.js';
import type { TabStatus } from '../generated/prisma/enums.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { resolvePrepStationId, stationForStage } from '../units/routing.js';
import { assertCounter, OperationAccessService } from './operation-access.js';
import { operationError } from './operation-errors.js';
import { OperationEvents, TabCreated, TabUpdated } from './operation-events.js';
import {
  loadOrders,
  loadTab,
  loadTabSummaries,
  loadTabSummary,
  loadUnitFlow,
} from './operation-reader.js';
import type { CreateOrderRequest, OrderDto, TabDto, TabSummaryDto } from './operation.schemas.js';
import {
  checkOrderItems,
  copyModifiers,
  type MenuProductForOrder,
  unitPriceFor,
} from './order-rules.js';
import { lockRow } from './row-lock.js';

/** RN-04.28: a tab that left `open`/`closing` accepts no change. */
const CLOSED_STATUSES: readonly TabStatus[] = ['paid', 'on_credit', 'settled', 'canceled'];

/**
 * Tabs and orders (spec 04, sections 4 and 5). Operated from the counter: the owner and staff with
 * a `counter` station of the unit. Reads: any member of the unit.
 */
@Injectable()
export class TabsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: OperationAccessService,
    private readonly events: OperationEvents,
  ) {}

  /** `GET /shifts/{id}/tabs?status=open,closing`: the varal of the counter, by number. */
  async list(shiftId: string, statuses: readonly TabStatus[]): Promise<TabSummaryDto[]> {
    const db = this.prisma.db;
    const shift = await requireShift(db, shiftId);
    await this.access.forUnit(db, shift.unitId);
    const tabs = await db.tab.findMany({
      where: { shiftId, status: { in: [...statuses] } },
      orderBy: { number: 'asc' },
    });
    return loadTabSummaries(db, tabs);
  }

  async get(tabId: string): Promise<TabDto> {
    const db = this.prisma.db;
    const tab = await requireTab(db, tabId);
    await this.access.forUnit(db, tab.unitId);
    return loadTab(db, tabId);
  }

  /** RN-04.09, RN-04.10, CA-04.02: an `open_tab` tab with the next number of the shift. */
  async create(shiftId: string, customerName: string): Promise<TabDto> {
    return this.prisma.transaction(async (db) => {
      const shift = await requireShift(db, shiftId);
      const access = await this.access.forUnit(db, shift.unitId);
      assertCounter(access);
      // The increment locks the shift row: two counters never get the same number, and a shift
      // closed meanwhile matches nothing (the WHERE is checked again after the lock).
      const [numbered] = await db.shift.updateManyAndReturn({
        where: { id: shiftId, status: 'open' },
        data: { nextTabNumber: { increment: 1 } },
      });
      if (!numbered) {
        throw operationError('SHIFT_CLOSED');
      }
      const tab = await db.tab.create({
        data: {
          organizationId: requireOrganizationId(),
          shiftId,
          unitId: shift.unitId,
          number: numbered.nextTabNumber - 1,
          customerName,
          mode: 'open_tab',
          status: 'open',
          openedByType: access.actor.type,
          openedById: access.actor.id,
        },
      });
      await this.audit.record(db, {
        action: 'tab.opened',
        entityType: 'tab',
        entityId: tab.id,
        after: { number: tab.number, customerName, mode: tab.mode, status: tab.status },
        metadata: { shiftId, unitId: shift.unitId },
      });
      const dto = await loadTab(db, tab.id);
      this.events.tab(TabCreated, dto);
      return dto;
    });
  }

  /** RN-04.12: `open` → `closing` (pedir a conta). */
  async requestBill(tabId: string, version: number | undefined): Promise<TabDto> {
    return this.transition(tabId, version, {
      from: 'open',
      to: 'closing',
      wrongStatus: 'TAB_NOT_OPEN',
      action: 'tab.bill_requested',
    });
  }

  /** RN-04.12: `closing` → `open` (o cliente pediu mais). */
  async reopen(tabId: string, version: number | undefined): Promise<TabDto> {
    return this.transition(tabId, version, {
      from: 'closing',
      to: 'open',
      wrongStatus: 'TAB_NOT_CLOSING',
      action: 'tab.reopened',
    });
  }

  /**
   * RN-04.12: `open`/`closing` → `canceled` when every item is canceled and no payment was
   * registered. Payments arrive with spec 05: check them here then.
   */
  async cancel(
    tabId: string,
    input: { version?: number | undefined; reason?: string | undefined },
  ): Promise<TabDto> {
    return this.prisma.transaction(async (db) => {
      const tab = await requireTab(db, tabId);
      assertCounter(await this.access.forUnit(db, tab.unitId));
      await assertShiftOpen(db, tab.shiftId);
      if (CLOSED_STATUSES.includes(tab.status)) {
        throw operationError('TAB_CLOSED');
      }
      const active = await db.orderItem.findMany({
        where: { tabId, canceledAt: null },
        select: { id: true },
      });
      if (active.length > 0) {
        throw operationError('TAB_HAS_ACTIVE_ITEMS', { itemIds: active.map((item) => item.id) });
      }
      await updateWithVersion<Tab>(db.tab, {
        where: { id: tabId },
        expectedVersion: input.version ?? tab.version,
        data: { status: 'canceled', closedAt: new Date() },
        onConflict: (currentVersion) => operationError('TAB_CHANGED', { currentVersion }),
      });
      await this.audit.record(db, {
        action: 'tab.canceled',
        entityType: 'tab',
        entityId: tabId,
        before: { status: tab.status },
        after: { status: 'canceled' },
        metadata: { unitId: tab.unitId, reason: input.reason ?? null },
      });
      const dto = await loadTab(db, tabId);
      this.events.tab(TabUpdated, dto);
      return dto;
    });
  }

  /**
   * `POST /tabs/{id}/orders` (spec 04, section 5): validates every item against the menu
   * (RN-04.16, RN-04.17; CA-03.06, CA-04.06), copies what was sold (RN-04.18) and puts each item in
   * the first stage, at the station the stage gives (RN-04.19). Each station gets only its items
   * (CA-04.03).
   */
  async createOrder(tabId: string, input: CreateOrderRequest): Promise<OrderDto> {
    return this.prisma.transaction(async (db) => {
      const found = await requireTab(db, tabId);
      const access = await this.access.forUnit(db, found.unitId);
      assertCounter(access);
      // Orders of the same tab run one at a time (number in the tab, totals).
      await lockRow(db, 'tabs', tabId);
      const tab = await requireTab(db, tabId);
      await assertShiftOpen(db, tab.shiftId);
      if (CLOSED_STATUSES.includes(tab.status)) {
        throw operationError('TAB_CLOSED');
      }
      if (tab.status !== 'open') {
        // RN-04.13: `closing` refuses new orders until reopened.
        throw operationError('TAB_NOT_OPEN');
      }

      const items = input.items.map((item) => ({
        ...item,
        productId: item.productId.toLowerCase(),
        modifierIds: item.modifierIds.map((id) => id.toLowerCase()),
      }));
      const products = await this.menuProducts(
        db,
        tab.unitId,
        items.map((item) => item.productId),
      );
      const rejections = checkOrderItems(tab.unitId, items, products);
      if (rejections.length > 0) {
        throw operationError('ORDER_REJECTED', { items: rejections });
      }

      const flow = await loadUnitFlow(db, tab.unitId);
      const shiftPrices = new Map(
        (await db.shiftPrice.findMany({ where: { shiftId: tab.shiftId } })).map((price) => [
          price.productId,
          price.priceCents,
        ]),
      );
      const numberInTab = (await db.order.count({ where: { tabId } })) + 1;
      const now = new Date();
      const organizationId = requireOrganizationId();
      const order = await db.order.create({
        data: {
          organizationId,
          tabId,
          shiftId: tab.shiftId,
          numberInTab,
          status: 'sent',
          createdByType: access.actor.type,
          createdById: access.actor.id,
          sentAt: now,
        },
      });
      for (const [position, item] of items.entries()) {
        const product = products.get(item.productId);
        if (!product) {
          throw AppError.of('INTERNAL_ERROR');
        }
        const prepStationId = resolvePrepStationId(product, product.category);
        const line = await db.orderItem.create({
          data: {
            organizationId,
            orderId: order.id,
            tabId,
            unitId: tab.unitId,
            productId: product.id,
            productName: product.name,
            unitPriceCents: unitPriceFor(product, shiftPrices),
            quantity: item.quantity,
            note: item.note === '' ? null : (item.note ?? null),
            position,
            prepStationId,
            stageId: flow.first.id,
            stationId: stationForStage(flow.first, prepStationId),
            stageEnteredAt: now,
          },
        });
        const modifiers = copyModifiers(product, item.modifierIds);
        if (modifiers.length > 0) {
          await db.orderItemModifier.createMany({
            data: modifiers.map((modifier, index) => ({
              organizationId,
              orderItemId: line.id,
              position: index,
              ...modifier,
            })),
          });
        }
      }
      await db.tab.update({ where: { id: tabId }, data: { version: { increment: 1 } } });

      const [dto] = await loadOrders(db, { id: order.id }, flow.lateAfterMinutes, now);
      if (!dto) {
        throw AppError.of('INTERNAL_ERROR');
      }
      await this.audit.record(db, {
        action: 'order.created',
        entityType: 'order',
        entityId: order.id,
        after: {
          tabId,
          numberInTab,
          items: dto.items.map((item) => ({
            id: item.id,
            productId: item.productId,
            productName: item.productName,
            unitPriceCents: item.unitPriceCents,
            quantity: item.quantity,
            modifiers: item.modifiers.map((modifier) => modifier.modifierName),
          })),
        },
        metadata: { unitId: tab.unitId, shiftId: tab.shiftId },
      });
      this.events.orderCreated(dto);
      this.events.tab(TabUpdated, await loadTabSummary(db, tabId, now));
      return dto;
    });
  }

  private async transition(
    tabId: string,
    version: number | undefined,
    rule: {
      from: TabStatus;
      to: TabStatus;
      wrongStatus: 'TAB_NOT_OPEN' | 'TAB_NOT_CLOSING';
      action: string;
    },
  ): Promise<TabDto> {
    return this.prisma.transaction(async (db) => {
      const tab = await requireTab(db, tabId);
      assertCounter(await this.access.forUnit(db, tab.unitId));
      await assertShiftOpen(db, tab.shiftId);
      if (CLOSED_STATUSES.includes(tab.status)) {
        throw operationError('TAB_CLOSED');
      }
      if (tab.status !== rule.from) {
        throw operationError(rule.wrongStatus);
      }
      await updateWithVersion<Tab>(db.tab, {
        where: { id: tabId },
        expectedVersion: version ?? tab.version,
        data: { status: rule.to },
        onConflict: (currentVersion) => operationError('TAB_CHANGED', { currentVersion }),
      });
      await this.audit.record(db, {
        action: rule.action,
        entityType: 'tab',
        entityId: tabId,
        before: { status: rule.from },
        after: { status: rule.to },
        metadata: { unitId: tab.unitId },
      });
      const dto = await loadTab(db, tabId);
      this.events.tab(TabUpdated, dto);
      return dto;
    });
  }

  /** Products of the order with what the rules need: category, groups and options. */
  private async menuProducts(
    db: TenantDb,
    unitId: string,
    productIds: readonly string[],
  ): Promise<
    Map<
      string,
      MenuProductForOrder & { stationId: string | null; category: { defaultStationId: string } }
    >
  > {
    const products = await db.product.findMany({
      where: { id: { in: [...new Set(productIds)] }, unitId },
      include: {
        category: { select: { active: true, defaultStationId: true } },
        modifierGroups: { include: { modifiers: true } },
      },
    });
    return new Map(
      products.map((product) => [
        product.id,
        {
          id: product.id,
          unitId: product.unitId,
          name: product.name,
          priceCents: product.priceCents,
          active: product.active,
          soldOut: product.soldOut,
          categoryActive: product.category.active,
          stationId: product.stationId,
          category: { defaultStationId: product.category.defaultStationId },
          groups: product.modifierGroups.map((group) => ({
            id: group.id,
            name: group.name,
            minChoices: group.minChoices,
            maxChoices: group.maxChoices,
            sortOrder: group.sortOrder,
            modifiers: group.modifiers.map((modifier) => ({
              id: modifier.id,
              name: modifier.name,
              priceDeltaCents: modifier.priceDeltaCents,
              sortOrder: modifier.sortOrder,
              active: modifier.active,
            })),
          })),
        },
      ]),
    );
  }
}

export async function requireShift(db: TenantDb, shiftId: string): Promise<Shift> {
  const shift = await db.shift.findUnique({ where: { id: shiftId } });
  if (!shift) {
    throw AppError.of('NOT_FOUND');
  }
  return shift;
}

export async function requireTab(db: TenantDb, tabId: string): Promise<Tab> {
  const tab = await db.tab.findUnique({ where: { id: tabId } });
  if (!tab) {
    throw AppError.of('NOT_FOUND');
  }
  return tab;
}

/** RN-04.08: nothing changes in a closed shift. */
export async function assertShiftOpen(db: TenantDb, shiftId: string): Promise<void> {
  const shift = await db.shift.findUniqueOrThrow({
    where: { id: shiftId },
    select: { status: true },
  });
  if (shift.status !== 'open') {
    throw operationError('SHIFT_CLOSED');
  }
}
