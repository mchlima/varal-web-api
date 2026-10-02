import { Injectable } from '@nestjs/common';

import { decodeKeysetCursor, encodeKeysetCursor } from '../common/pagination.js';
import { startOfDayInSaoPaulo, TIME_ZONE, todayInSaoPaulo, toSaoPaulo } from '../common/time.js';
import { requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import type { ActorType, PaymentMethod } from '../generated/prisma/enums.js';
import { loadCashRegister } from '../operation/cash-registers.service.js';
import { lineTotalCents, tabTotals } from '../operation/order-rules.js';
import { PAYMENT_METHODS } from '../operation/payment-rules.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import {
  type ShiftFilter,
  type ShiftTotals,
  totalsOfPeriod,
  totalsOfShifts,
} from './report-queries.js';
import type {
  ReportActorDto,
  ShiftHistoryDto,
  ShiftHistoryQuery,
  ShiftHistoryRowDto,
  ShiftReportDto,
} from './reports.schemas.js';

/** Default period of the history: the last 30 days, today included (spec 07, section 5). */
export const DEFAULT_HISTORY_DAYS = 30;
const MAX_HISTORY_DAYS = 366;

/** Statuses whose total is a sale (RN-07.01). */
const SALE_STATUSES = new Set(['paid', 'on_credit', 'settled']);

export interface HistoryPeriod {
  from: Temporal.PlainDate;
  /** Inclusive. */
  to: Temporal.PlainDate;
  start: Date;
  end: Date;
}

/** `?from=&to=` as São Paulo days (default: the last 30 days); `[start, end)` as instants. */
export function resolveHistoryPeriod(
  input: { from?: string | undefined; to?: string | undefined },
  today = todayInSaoPaulo(),
): HistoryPeriod {
  const to = input.to === undefined ? today : Temporal.PlainDate.from(input.to);
  const from =
    input.from === undefined
      ? to.subtract({ days: DEFAULT_HISTORY_DAYS - 1 })
      : Temporal.PlainDate.from(input.from);
  const days = from.until(to, { largestUnit: 'days' }).days + 1;
  if (days < 1 || days > MAX_HISTORY_DAYS) {
    throw AppError.of('VALIDATION_FAILED', {
      details: {
        fields: [
          {
            path: 'from',
            message: `O período precisa ter de 1 a ${MAX_HISTORY_DAYS} dias, com o início antes do fim.`,
          },
        ],
      },
    });
  }
  return {
    from,
    to,
    start: startOfDayInSaoPaulo(from),
    end: startOfDayInSaoPaulo(to.add({ days: 1 })),
  };
}

/** São Paulo day of an instant (the "date" of a shift). */
function dayOf(date: Date): string {
  return toSaoPaulo(date).toPlainDate().toString();
}

function actorKey(type: ActorType, id: string | null): string {
  return `${type}:${id ?? ''}`;
}

/** Names of owners and staff members, to show who did what. */
class ActorNames {
  private readonly names = new Map<string, string>();

  static async load(
    db: TenantDb,
    actors: readonly { type: ActorType; id: string | null }[],
  ): Promise<ActorNames> {
    const result = new ActorNames();
    const ids = (type: ActorType) => [
      ...new Set(actors.flatMap((actor) => (actor.type === type && actor.id ? [actor.id] : []))),
    ];
    const owners = ids('owner');
    const staff = ids('staff');
    const [users, members] = await Promise.all([
      owners.length === 0
        ? []
        : db.user.findMany({ where: { id: { in: owners } }, select: { id: true, name: true } }),
      staff.length === 0
        ? []
        : db.staffMember.findMany({
            where: { id: { in: staff } },
            select: { id: true, name: true },
          }),
    ]);
    for (const user of users) {
      result.names.set(actorKey('owner', user.id), user.name);
    }
    for (const member of members) {
      result.names.set(actorKey('staff', member.id), member.name);
    }
    return result;
  }

  of(type: ActorType, id: string | null): ReportActorDto {
    return { type, id, name: this.names.get(actorKey(type, id)) ?? null };
  }
}

interface StaffTally {
  actor: { type: ActorType; id: string | null };
  tabsOpened: number;
  ordersSent: number;
  receivedCents: number;
  itemsCanceled: number;
  tabsCanceled: number;
  discountCount: number;
  discountsCents: number;
}

/**
 * Reports (spec 07): the shift report (section 4) and the history with totals (section 5). Only
 * the owner of the organization (and an admin in "entrar como", who acts as the owner); staff get
 * 403 (RN-07.07, CA-07.06), checked by the route guard.
 *
 * The totals come from one aggregated SQL ({@link totalsOfShifts}) shared by both reports; the
 * sections of the shift report read the copied values of the items, tabs and payments of that one
 * shift (RN-07.05).
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** `GET /shifts/{id}/report` (spec 07, section 4; CA-07.01 to CA-07.05). */
  async shiftReport(shiftId: string): Promise<ShiftReportDto> {
    const db = this.prisma.db;
    const organizationId = requireOrganizationId();
    const shift = await db.shift.findUnique({
      where: { id: shiftId },
      include: { agreement: true, unit: { select: { name: true } } },
    });
    if (!shift) {
      throw AppError.of('NOT_FOUND');
    }
    const [totalsById, tabs, items, orders, payments, registerRows] = await Promise.all([
      totalsOfShifts(db, organizationId, [shiftId]),
      db.tab.findMany({ where: { shiftId }, orderBy: { number: 'asc' } }),
      db.orderItem.findMany({
        where: { tab: { shiftId } },
        select: {
          id: true,
          tabId: true,
          productId: true,
          productName: true,
          unitPriceCents: true,
          quantity: true,
          canceledAt: true,
          canceledByType: true,
          canceledById: true,
          cancelReason: true,
          wasted: true,
          modifiers: {
            select: { groupName: true, modifierName: true, priceDeltaCents: true },
            orderBy: { position: 'asc' },
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      db.order.findMany({ where: { shiftId }, select: { createdByType: true, createdById: true } }),
      db.payment.findMany({
        where: { shiftId, reversedAt: null },
        include: {
          tab: { select: { number: true, customerName: true, shiftId: true, customerId: true } },
        },
        orderBy: { id: 'asc' },
      }),
      db.cashRegister.findMany({
        where: { shiftId },
        select: { id: true },
        orderBy: { id: 'asc' },
      }),
    ]);
    const totals = totalsById.get(shiftId) ?? emptyTotals(shiftId);
    const tabIds = tabs.map((tab) => tab.id);
    const tabById = new Map(tabs.map((tab) => [tab.id, tab]));
    const hung = tabs.filter((tab) => tab.creditAt !== null);
    const [tabPayments, audits, registers] = await Promise.all([
      hung.length === 0
        ? []
        : db.payment.findMany({
            where: { tabId: { in: hung.map((tab) => tab.id) }, reversedAt: null },
            select: { tabId: true, amountCents: true, isCreditSettlement: true },
          }),
      tabIds.length === 0
        ? []
        : db.auditLog.findMany({
            where: {
              organizationId,
              entityType: 'tab',
              entityId: { in: tabIds },
              action: { in: ['tab.discount_applied', 'tab.canceled'] },
            },
            select: { action: true, entityId: true, actorType: true, actorId: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          }),
      Promise.all(registerRows.map((row) => loadCashRegister(db, row.id))),
    ]);
    const customerIds = [
      ...new Set(
        [...hung.map((tab) => tab.customerId), ...payments.map((row) => row.tab.customerId)].filter(
          (id): id is string => id !== null,
        ),
      ),
    ];
    const customers = new Map(
      (customerIds.length === 0
        ? []
        : await db.customer.findMany({
            where: { id: { in: customerIds } },
            select: { id: true, name: true, reference: true, anonymizedAt: true },
          })
      ).map((row) => [
        row.id,
        {
          id: row.id,
          name: row.name,
          reference: row.reference,
          removed: row.anonymizedAt !== null,
        },
      ]),
    );
    const customerOf = (id: string | null) => (id === null ? null : (customers.get(id) ?? null));

    // Who gave the discount in effect (the last one applied) and who canceled each tab: audit.
    const discountBy = new Map<string, { type: ActorType; id: string | null }>();
    const canceledBy = new Map<string, { type: ActorType; id: string | null }>();
    for (const log of audits) {
      if (log.entityId === null) {
        continue;
      }
      const actor = { type: log.actorType, id: log.actorId };
      (log.action === 'tab.canceled' ? canceledBy : discountBy).set(log.entityId, actor);
    }

    const names = await ActorNames.load(db, [
      { type: shift.openedByType, id: shift.openedById },
      ...(shift.closedByType === null ? [] : [{ type: shift.closedByType, id: shift.closedById }]),
      ...tabs.map((tab) => ({ type: tab.openedByType, id: tab.openedById })),
      ...orders.map((order) => ({ type: order.createdByType, id: order.createdById })),
      ...payments.map((row) => ({ type: row.receivedByType, id: row.receivedById })),
      ...items.flatMap((item) =>
        item.canceledByType === null ? [] : [{ type: item.canceledByType, id: item.canceledById }],
      ),
      ...discountBy.values(),
      ...canceledBy.values(),
      ...registers.flatMap((register) => [
        register.openedBy,
        ...(register.closedBy === null ? [] : [register.closedBy]),
      ]),
    ]);

    // Totals of each tab from the copied values (RN-04.14, RN-07.05).
    const linesByTab = new Map<string, typeof items>();
    for (const item of items) {
      linesByTab.set(item.tabId, [...(linesByTab.get(item.tabId) ?? []), item]);
    }
    const totalOf = (tabId: string) => {
      const tab = tabById.get(tabId);
      return tabTotals(linesByTab.get(tabId) ?? [], {
        type: tab?.discountType ?? null,
        value: tab?.discountValue ?? null,
      });
    };

    // Per product (RN-07.04): lines not canceled of the tabs that count as a sale.
    const products = new Map<string, ShiftReportDto['products'][number]>();
    for (const item of items) {
      const tab = tabById.get(item.tabId);
      if (item.canceledAt !== null || !tab || !SALE_STATUSES.has(tab.status)) {
        continue;
      }
      const key = `${item.productId}\u0000${item.productName}`;
      const line = products.get(key) ?? {
        productId: item.productId,
        productName: item.productName,
        quantity: 0,
        valueCents: 0,
        modifiers: [],
      };
      line.quantity += item.quantity;
      line.valueCents += lineTotalCents(item);
      for (const modifier of item.modifiers.filter((row) => row.priceDeltaCents > 0)) {
        let row = line.modifiers.find(
          (existing) =>
            existing.groupName === modifier.groupName &&
            existing.modifierName === modifier.modifierName &&
            existing.priceDeltaCents === modifier.priceDeltaCents,
        );
        if (!row) {
          row = { ...modifier, quantity: 0, valueCents: 0 };
          line.modifiers.push(row);
        }
        row.quantity += item.quantity;
        row.valueCents += modifier.priceDeltaCents * item.quantity;
      }
      products.set(key, line);
    }
    const productLines = [...products.values()]
      .map((line) => ({
        ...line,
        modifiers: [...line.modifiers].sort((a, b) => b.valueCents - a.valueCents),
      }))
      .sort(
        (a, b) =>
          b.valueCents - a.valueCents || a.productName.localeCompare(b.productName, 'pt-BR'),
      );

    // Per payment method (RN-07.02): sales and settlements apart.
    const byMethod = new Map<PaymentMethod, { sales: number; settlements: number }>(
      PAYMENT_METHODS.map((method) => [method, { sales: 0, settlements: 0 }]),
    );
    for (const payment of payments) {
      const row = byMethod.get(payment.method);
      if (row) {
        if (payment.isCreditSettlement) {
          row.settlements += payment.amountCents;
        } else {
          row.sales += payment.amountCents;
        }
      }
    }

    // Per staff member (the owner too).
    const tallies = new Map<string, StaffTally>();
    const tally = (type: ActorType, id: string | null): StaffTally => {
      const key = actorKey(type, id);
      let row = tallies.get(key);
      if (!row) {
        row = {
          actor: { type, id },
          tabsOpened: 0,
          ordersSent: 0,
          receivedCents: 0,
          itemsCanceled: 0,
          tabsCanceled: 0,
          discountCount: 0,
          discountsCents: 0,
        };
        tallies.set(key, row);
      }
      return row;
    };
    for (const tab of tabs) {
      tally(tab.openedByType, tab.openedById).tabsOpened += 1;
    }
    for (const order of orders) {
      tally(order.createdByType, order.createdById).ordersSent += 1;
    }
    for (const payment of payments) {
      tally(payment.receivedByType, payment.receivedById).receivedCents += payment.amountCents;
    }
    for (const item of items) {
      if (item.canceledAt !== null && item.canceledByType !== null) {
        tally(item.canceledByType, item.canceledById).itemsCanceled += item.quantity;
      }
    }
    for (const [tabId, actor] of canceledBy) {
      if (tabById.get(tabId)?.status === 'canceled') {
        tally(actor.type, actor.id).tabsCanceled += 1;
      }
    }
    for (const tab of tabs) {
      const actor = discountBy.get(tab.id);
      if (!actor || tab.discountType === null || !SALE_STATUSES.has(tab.status)) {
        continue;
      }
      const discount = totalOf(tab.id).discountCents;
      const row = tally(actor.type, actor.id);
      row.discountCount += 1;
      row.discountsCents += discount;
    }
    const staffLines = [...tallies.values()]
      .map((row) => ({ ...row, actor: names.of(row.actor.type, row.actor.id) }))
      .sort(
        (a, b) =>
          b.receivedCents - a.receivedCents ||
          (a.actor.name ?? '').localeCompare(b.actor.name ?? '', 'pt-BR'),
      );

    // Fiado (RN-07.03): tabs of the shift put on credit and settlements received in the shift.
    const creditTabs = hung
      .filter((tab) => tab.status === 'on_credit' || tab.status === 'settled')
      .map((tab) => {
        const own = tabPayments.filter((row) => row.tabId === tab.id);
        const before = own
          .filter((row) => !row.isCreditSettlement)
          .reduce((sum, row) => sum + row.amountCents, 0);
        const paid = own.reduce((sum, row) => sum + row.amountCents, 0);
        const total = totalOf(tab.id).totalCents;
        return {
          tabId: tab.id,
          number: tab.number,
          customerName: tab.customerName,
          customer: customerOf(tab.customerId),
          status: tab.status,
          creditAt: (tab.creditAt ?? tab.createdAt).toISOString(),
          amountCents: total - before,
          balanceCents: total - paid,
        };
      });
    const settlements = payments
      .filter((row) => row.isCreditSettlement)
      .map((row) => ({
        paymentId: row.id,
        tabId: row.tabId,
        tabNumber: row.tab.number,
        tabShiftId: row.tab.shiftId,
        customerName: row.tab.customerName,
        customer: customerOf(row.tab.customerId),
        method: row.method,
        amountCents: row.amountCents,
        receivedAt: row.createdAt.toISOString(),
        receivedBy: names.of(row.receivedByType, row.receivedById),
      }));

    const canceledItems = items
      .filter((item) => item.canceledAt !== null)
      .map((item) => ({
        itemId: item.id,
        tabId: item.tabId,
        tabNumber: tabById.get(item.tabId)?.number ?? 0,
        productName: item.productName,
        quantity: item.quantity,
        valueCents: lineTotalCents(item),
        reason: item.cancelReason,
        canceledAt: (item.canceledAt ?? new Date(0)).toISOString(),
        canceledBy:
          item.canceledByType === null ? null : names.of(item.canceledByType, item.canceledById),
        wasted: item.wasted,
      }));
    const canceledTabs = tabs
      .filter((tab) => tab.status === 'canceled')
      .map((tab) => {
        const actor = canceledBy.get(tab.id);
        return {
          tabId: tab.id,
          number: tab.number,
          customerName: tab.customerName,
          canceledAt: tab.closedAt?.toISOString() ?? null,
          canceledBy: actor ? names.of(actor.type, actor.id) : null,
        };
      });

    const agreement = shift.agreement;
    return {
      shift: {
        id: shift.id,
        unitId: shift.unitId,
        unitName: shift.unit.name,
        type: shift.type,
        status: shift.status,
        date: dayOf(shift.openedAt),
        openedAt: shift.openedAt.toISOString(),
        openedBy: names.of(shift.openedByType, shift.openedById),
        closedAt: shift.closedAt?.toISOString() ?? null,
        closedBy:
          shift.closedByType === null ? null : names.of(shift.closedByType, shift.closedById),
      },
      partial: shift.status === 'open',
      timeZone: TIME_ZONE,
      summary: {
        ...totalsDto(totals),
        tabCount: totals.tabCount,
        canceledTabCount: totals.canceledTabCount,
        averageTicketCents:
          totals.tabCount === 0 ? 0 : Math.floor(totals.salesCents / totals.tabCount),
      },
      products: productLines,
      paymentMethods: PAYMENT_METHODS.map((method) => {
        const row = byMethod.get(method) ?? { sales: 0, settlements: 0 };
        return {
          method,
          salesCents: row.sales,
          settlementsCents: row.settlements,
          totalCents: row.sales + row.settlements,
        };
      }),
      staff: staffLines,
      cashRegisters: registers.map((register) => ({
        ...register,
        responsible: names.of(register.openedBy.type, register.openedBy.id),
        closedByActor:
          register.closedBy === null
            ? null
            : names.of(register.closedBy.type, register.closedBy.id),
        differenceCents: register.counts.reduce((sum, count) => sum + count.differenceCents, 0),
      })),
      credit: {
        onCreditCents: totals.onCreditCents,
        settlementsCents: totals.receivedSettlementsCents,
        tabs: creditTabs,
        settlements,
      },
      cancellations: {
        wasteCents: totals.wasteCents,
        wasteQuantity: totals.wasteQuantity,
        items: canceledItems,
        tabs: canceledTabs,
      },
      agreement:
        agreement === null
          ? null
          : {
              contractorName: agreement.contractorName,
              modality: agreement.modality,
              agreedAmountCents: agreement.agreedAmountCents,
              agreedQuantity: agreement.agreedQuantity,
              limits: agreement.limits,
              notes: agreement.notes,
              consumedQuantity: totals.consumedQuantity,
              consumedCents: totals.salesCents,
              quantityDifference:
                agreement.agreedQuantity === null
                  ? null
                  : agreement.agreedQuantity - totals.consumedQuantity,
            },
    };
  }

  /** `GET /reports/shifts?unitId=&from=&to=&type=` (spec 07, section 5; CA-07.04). */
  async history(query: ShiftHistoryQuery): Promise<ShiftHistoryDto> {
    const db = this.prisma.db;
    const organizationId = requireOrganizationId();
    const period = resolveHistoryPeriod(query);
    const unitId = query.unitId?.toLowerCase() ?? null;
    if (unitId !== null && !(await db.unit.findUnique({ where: { id: unitId } }))) {
      throw AppError.of('NOT_FOUND');
    }
    const filter: ShiftFilter = {
      unitId,
      type: query.type ?? null,
      start: period.start,
      end: period.end,
    };
    const after = query.cursor === undefined ? null : decodeKeysetCursor(query.cursor);
    const afterDate = after === null ? null : new Date(after.key);
    if (afterDate !== null && Number.isNaN(afterDate.getTime())) {
      throw AppError.of('VALIDATION_FAILED', {
        details: { fields: [{ path: 'cursor', message: 'Cursor inválido.' }] },
      });
    }
    const [rows, totals] = await Promise.all([
      db.shift.findMany({
        where: {
          openedAt: { gte: period.start, lt: period.end },
          ...(unitId === null ? {} : { unitId }),
          ...(filter.type === null ? {} : { type: filter.type }),
          ...(after === null || afterDate === null
            ? {}
            : {
                OR: [
                  { openedAt: { lt: afterDate } },
                  { openedAt: afterDate, id: { lt: after.id } },
                ],
              }),
        },
        include: { unit: { select: { name: true } } },
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
      totalsOfPeriod(db, organizationId, filter),
    ]);
    const page = rows.slice(0, query.limit);
    const byShift = await totalsOfShifts(
      db,
      organizationId,
      page.map((shift) => shift.id),
    );
    const data: ShiftHistoryRowDto[] = page.map((shift) => {
      const row = byShift.get(shift.id) ?? emptyTotals(shift.id);
      return {
        shiftId: shift.id,
        unitId: shift.unitId,
        unitName: shift.unit.name,
        type: shift.type,
        status: shift.status,
        date: dayOf(shift.openedAt),
        openedAt: shift.openedAt.toISOString(),
        closedAt: shift.closedAt?.toISOString() ?? null,
        tabCount: row.tabCount,
        ...totalsDto(row),
      };
    });
    const last = page.at(-1);
    return {
      period: { from: period.from.toString(), to: period.to.toString(), timeZone: TIME_ZONE },
      totals,
      data,
      nextCursor:
        rows.length > query.limit && last
          ? encodeKeysetCursor(last.openedAt.toISOString(), last.id)
          : null,
    };
  }
}

function emptyTotals(shiftId: string): ShiftTotals {
  return {
    shiftId,
    tabCount: 0,
    canceledTabCount: 0,
    salesCents: 0,
    discountsCents: 0,
    onCreditCents: 0,
    wasteCents: 0,
    wasteQuantity: 0,
    consumedQuantity: 0,
    receivedSalesCents: 0,
    receivedSettlementsCents: 0,
    receivedCents: 0,
    cashDifferenceCents: 0,
  };
}

function totalsDto(totals: ShiftTotals) {
  return {
    salesCents: totals.salesCents,
    receivedCents: totals.receivedCents,
    receivedSalesCents: totals.receivedSalesCents,
    receivedSettlementsCents: totals.receivedSettlementsCents,
    onCreditCents: totals.onCreditCents,
    discountsCents: totals.discountsCents,
    wasteCents: totals.wasteCents,
    wasteQuantity: totals.wasteQuantity,
    cashDifferenceCents: totals.cashDifferenceCents,
  };
}
