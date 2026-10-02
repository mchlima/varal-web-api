import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { dateColumn, isoDateOf, todayInSaoPaulo } from '../common/time.js';
import { updateWithVersion } from '../common/versioned-update.js';
import { requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import type { Tab, Unit } from '../generated/prisma/client.js';
import type { TabMode, TabStatus } from '../generated/prisma/enums.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { listPrices, loadUnitPricing } from '../units/effective-price-list.js';
import { OPEN_TAB_STATUSES } from '../units/operation-guard.js';
import { resolvePrepStationId, stationForStage } from '../units/routing.js';
import { nextTabNumber } from './business-day.js';
import { assertCounter, OperationAccessService, type OperatorAccess } from './operation-access.js';
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
  pricedLine,
} from './order-rules.js';
import { lockRow } from './row-lock.js';

/** RN-04.28: a tab that left `open`/`closing` accepts no change. */
export const CLOSED_STATUSES: readonly TabStatus[] = ['paid', 'on_credit', 'settled', 'canceled'];

/**
 * RN-04.02 (CA-04.01): opening a tab and sending an order need the unit in operation, that is, a
 * cash register open (`NO_CASH_REGISTER_OPEN`).
 */
export async function assertInOperation(db: TenantDb, unitId: string): Promise<void> {
  const open = await db.cashRegisterSession.count({ where: { unitId, status: 'open' } });
  if (open === 0) {
    throw operationError('NO_CASH_REGISTER_OPEN');
  }
}

/**
 * RN-04.09, RN-04.29, RN-04.36 (CA-04.02): writes a tab with the next number of the day of
 * operation, skipping the numbers of tabs of earlier days still open, tied to the event in progress.
 * Locks the unit row: two counters never get the same number. The caller checked the operation.
 */
export async function insertTab(
  db: TenantDb,
  unitId: string,
  access: OperatorAccess,
  input: { customerName: string; mode: TabMode; status: TabStatus; closedAt?: Date | undefined },
): Promise<Tab> {
  await lockRow(db, 'units', unitId);
  const unit: Unit = await db.unit.findUniqueOrThrow({ where: { id: unitId } });
  if (unit.businessDate === null) {
    // A register was opened, so the unit has a day of operation (RN-05.25).
    throw operationError('NO_CASH_REGISTER_OPEN');
  }
  const open = await db.tab.findMany({
    where: { unitId, status: { in: [...OPEN_TAB_STATUSES] }, number: { gte: unit.nextTabNumber } },
    select: { number: true },
  });
  const number = nextTabNumber(unit.nextTabNumber, new Set(open.map((tab) => tab.number)));
  await db.unit.update({ where: { id: unitId }, data: { nextTabNumber: number + 1 } });
  const event = await db.contractedEvent.findFirst({
    where: { unitId, status: 'in_progress' },
    select: { id: true },
  });
  const closed = input.status !== 'open' && input.status !== 'closing';
  return db.tab.create({
    data: {
      organizationId: requireOrganizationId(),
      unitId,
      number,
      businessDate: unit.businessDate,
      closedBusinessDate: closed ? unit.businessDate : null,
      eventId: event?.id ?? null,
      customerName: input.customerName,
      mode: input.mode,
      status: input.status,
      openedByType: access.actor.type,
      openedById: access.actor.id,
      closedAt: input.closedAt ?? null,
    },
  });
}

/** RN-04.38: the day of operation of the unit, kept by a tab when it leaves `open`/`closing`. */
export async function currentBusinessDate(db: TenantDb, unitId: string): Promise<Date> {
  const unit = await db.unit.findUniqueOrThrow({
    where: { id: unitId },
    select: { businessDate: true },
  });
  return unit.businessDate ?? dateColumn(todayInSaoPaulo());
}

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

  /**
   * `GET /units/{id}/tabs?status=open,closing`: the varal of the counter, every open tab of the
   * unit from any day (RN-04.07), oldest day first, then by number. Tabs already closed (`paid`,
   * `on_credit`, `settled`, `canceled`) come only from the current day of operation, so the list
   * stays the size of a day.
   */
  async list(unitId: string, statuses: readonly TabStatus[]): Promise<TabSummaryDto[]> {
    const db = this.prisma.db;
    const access = await this.access.forUnit(db, unitId);
    const open = statuses.filter((status) => status === 'open' || status === 'closing');
    const closed = statuses.filter((status) => status !== 'open' && status !== 'closing');
    const tabs = await db.tab.findMany({
      where: {
        unitId,
        OR: [
          ...(open.length > 0 ? [{ status: { in: open } }] : []),
          ...(closed.length > 0 && access.unit.businessDate !== null
            ? [{ status: { in: closed }, closedBusinessDate: access.unit.businessDate }]
            : []),
        ],
      },
      orderBy: [{ businessDate: 'asc' }, { number: 'asc' }, { id: 'asc' }],
    });
    return loadTabSummaries(db, tabs);
  }

  async get(tabId: string): Promise<TabDto> {
    const db = this.prisma.db;
    const tab = await requireTab(db, tabId);
    await this.access.forUnit(db, tab.unitId);
    return loadTab(db, tabId);
  }

  /**
   * RN-04.02, RN-04.09, RN-04.10, RN-04.36 (CA-04.01, CA-04.02, CA-04.14): an `open_tab` tab with
   * the next number of the day, tied to the event in progress. Needs a register open.
   */
  async create(unitId: string, customerName: string): Promise<TabDto> {
    return this.prisma.transaction(async (db) => {
      const access = await this.access.forUnit(db, unitId);
      assertCounter(access);
      await assertInOperation(db, unitId);
      const tab = await insertTab(db, unitId, access, {
        customerName,
        mode: 'open_tab',
        status: 'open',
      });
      await this.audit.record(db, {
        action: 'tab.opened',
        entityType: 'tab',
        entityId: tab.id,
        after: { number: tab.number, customerName, mode: tab.mode, status: tab.status },
        metadata: { unitId, eventId: tab.eventId, businessDate: isoDateOf(tab.businessDate) },
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
   * RN-04.12: `open`/`closing` → `canceled` when every item is canceled and no payment is
   * registered (reversed ones do not count, RN-05.14): otherwise `TAB_HAS_PAYMENTS`.
   */
  async cancel(
    tabId: string,
    input: { version?: number | undefined; reason?: string | undefined },
  ): Promise<TabDto> {
    return this.prisma.transaction(async (db) => {
      const found = await requireTab(db, tabId);
      assertCounter(await this.access.forUnit(db, found.unitId));
      // Same lock as payments: a payment never lands on a tab being canceled.
      await lockRow(db, 'tabs', tabId);
      const tab = await requireTab(db, tabId);
      if (tab.status === 'paid') {
        throw operationError('TAB_PAID', { paymentIds: await activePaymentIds(db, tabId) });
      }
      if (CLOSED_STATUSES.includes(tab.status)) {
        throw operationError('TAB_CLOSED');
      }
      const paymentIds = await activePaymentIds(db, tabId);
      if (paymentIds.length > 0) {
        throw operationError('TAB_HAS_PAYMENTS', { paymentIds });
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
        data: {
          status: 'canceled',
          closedAt: new Date(),
          closedBusinessDate: await currentBusinessDate(db, tab.unitId),
        },
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
   * `POST /tabs/{id}/orders` (spec 04, section 5): needs a register open (RN-04.02, CA-04.01);
   * validates every item against the menu (RN-04.16, RN-04.17; CA-03.06, CA-04.06), copies what
   * was sold with the price of the effective list (RN-04.18, RN-04.32) and puts each item in the
   * first stage, at the station the stage gives (RN-04.19). Each station gets only its items
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
      if (CLOSED_STATUSES.includes(tab.status)) {
        throw operationError('TAB_CLOSED');
      }
      await assertInOperation(db, tab.unitId);
      if (tab.status !== 'open') {
        // RN-04.13: `closing` refuses new orders until reopened.
        throw operationError('TAB_NOT_OPEN');
      }
      if (tab.mode === 'pay_first') {
        // RN-04.11: a single order, sent with its payment (spec 05).
        throw operationError('TAB_PAY_FIRST');
      }
      const now = new Date();
      const dto = await this.insertOrder(db, tab, access, input.items, now);
      this.events.orderCreated(dto);
      this.events.tab(TabUpdated, await loadTabSummary(db, tabId, now));
      return dto;
    });
  }

  /**
   * Validates and writes an order of `tab` (RN-04.16 to RN-04.19), audited. No status check and no
   * event: the callers do both (`createOrder`, and "paga antes", which sends the order only with
   * its payment, CA-04.10).
   */
  async insertOrder(
    db: TenantDb,
    tab: Tab,
    access: OperatorAccess,
    requested: CreateOrderRequest['items'],
    now: Date,
  ): Promise<OrderDto> {
    {
      const tabId = tab.id;
      const items = requested.map((item) => ({
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
      // RN-04.32: the list of the event in progress, else the current list of the unit.
      const pricing = await loadUnitPricing(db, tab.unitId);
      const effective =
        pricing.effective === null
          ? null
          : { id: pricing.effective.id, prices: await listPrices(db, pricing.effective.id) };
      const numberInTab = (await db.order.count({ where: { tabId } })) + 1;
      const organizationId = requireOrganizationId();
      const order = await db.order.create({
        data: {
          organizationId,
          tabId,
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
            ...pricedLine(product, effective),
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

      const [dto] = await loadOrders(db, { id: order.id }, flow, now);
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
            priceListId: item.priceListId,
            quantity: item.quantity,
            modifiers: item.modifiers.map((modifier) => modifier.modifierName),
          })),
        },
        metadata: { unitId: tab.unitId, priceListId: pricing.effective?.id ?? null },
      });
      return dto;
    }
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
      if (CLOSED_STATUSES.includes(tab.status)) {
        throw operationError('TAB_CLOSED');
      }
      if (tab.status !== rule.from) {
        throw operationError(rule.wrongStatus);
      }
      if (rule.to === 'open' && tab.mode === 'pay_first') {
        // RN-04.11: a "paga antes" tab never takes another order.
        throw operationError('TAB_PAY_FIRST');
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

export async function requireTab(db: TenantDb, tabId: string): Promise<Tab> {
  const tab = await db.tab.findUnique({ where: { id: tabId } });
  if (!tab) {
    throw AppError.of('NOT_FOUND');
  }
  return tab;
}

/** Payments of the tab not reversed (RN-05.07). */
export async function activePaymentIds(db: TenantDb, tabId: string): Promise<string[]> {
  const rows = await db.payment.findMany({
    where: { tabId, reversedAt: null },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
