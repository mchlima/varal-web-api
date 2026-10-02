import { Injectable } from '@nestjs/common';

import { decodeKeysetCursor, encodeKeysetCursor } from '../common/pagination.js';
import { dateColumn, isoDateOf, TIME_ZONE, todayInSaoPaulo } from '../common/time.js';
import { requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { ActorType, PaymentMethod } from '../generated/prisma/enums.js';
import { ActorNames } from '../operation/actor-names.js';
import { loadSession, sessionInclude } from '../operation/cash-reader.js';
import { eventInclude, toEventDto } from '../operation/events-reader.js';
import { lineTotalCents, tabTotals } from '../operation/order-rules.js';
import { PAYMENT_METHODS } from '../operation/payment-rules.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { NORMAL_PRICE_LIST_NAME } from '../units/effective-price-list.js';
import {
  dayTotals,
  EMPTY_TOTALS,
  eventTotals,
  type ReportTotals,
  sessionTotals,
  sumTotals,
} from './report-queries.js';
import type {
  DayHistoryDto,
  EventHistoryDto,
  EventHistoryQuery,
  EventReportDto,
  HistoryQuery,
  PeriodQuery,
  ReportSessionLineDto,
  ReportTotalsDto,
  SessionHistoryDto,
  SessionHistoryQuery,
  SessionReportDto,
  SummaryReportDto,
} from './reports.schemas.js';

/** Default period of the reports: the last 30 days, today included (spec 07, decisions). */
export const DEFAULT_HISTORY_DAYS = 30;
const MAX_HISTORY_DAYS = 366;

/** Statuses whose total is a sale (RN-07.01). */
const SALE_STATUSES = new Set(['paid', 'on_credit', 'settled']);

export interface ReportPeriod {
  from: Temporal.PlainDate;
  /** Inclusive. */
  to: Temporal.PlainDate;
}

/** `?from=&to=` as days of operation (default: the last 30 days); from 1 to 366 days. */
export function resolveHistoryPeriod(
  input: { from?: string | undefined; to?: string | undefined },
  today = todayInSaoPaulo(),
): ReportPeriod {
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
  return { from, to };
}

function periodOut(period: ReportPeriod) {
  return {
    from: period.from.toString(),
    to: period.to.toString(),
    timeZone: TIME_ZONE as 'America/Sao_Paulo',
  };
}

function totalsDto(totals: ReportTotals): ReportTotalsDto {
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
    tabCount: totals.tabCount,
  };
}

function summaryDto(totals: ReportTotals) {
  return {
    ...totalsDto(totals),
    canceledTabCount: totals.canceledTabCount,
    averageTicketCents: totals.tabCount === 0 ? 0 : Math.floor(totals.salesCents / totals.tabCount),
  };
}

const itemSelect = {
  id: true,
  tabId: true,
  productId: true,
  productName: true,
  unitPriceCents: true,
  priceListId: true,
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
} satisfies Prisma.OrderItemSelect;

type ItemRow = Prisma.OrderItemGetPayload<{ select: typeof itemSelect }>;

type TabRow = Prisma.TabGetPayload<object>;

type PaymentRow = Prisma.PaymentGetPayload<{
  include: {
    tab: { select: { number: true; customerName: true; businessDate: true; customerId: true } };
  };
}>;

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

/** What the sections of a report are built from (spec 07, sections 4 and 6). */
interface SectionData {
  /** Tabs that count for sale, credit and canceled tabs (closed in the scope). */
  closedTabs: TabRow[];
  /** Lines of `closedTabs`. */
  lines: ItemRow[];
  /** Canceled lines of the scope (waste and cancellations). */
  canceledItems: ItemRow[];
  /** Payments not reversed of the scope. */
  payments: PaymentRow[];
  /** Tabs opened in the scope, with their orders (per staff member). */
  openedTabs: TabRow[];
  orders: { createdByType: ActorType; createdById: string | null }[];
}

/**
 * Reports (spec 07): the day or period report (section 4), the cash register session report
 * (section 5), the event report (section 6) and the histories (section 7). Only the owner of the
 * organization (and an admin in "entrar como", who acts as the owner); staff get 403 (RN-07.07,
 * CA-07.06), checked by the route guard.
 *
 * The totals come from one aggregated SQL ({@link dayTotals}, {@link sessionTotals},
 * {@link eventTotals}); the sections read the copied values of the items, tabs and payments of the
 * same scope (RN-07.05).
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** `GET /reports/summary?unitId=&from=&to=` (spec 07, section 4; CA-07.01, CA-07.02, CA-07.07 to CA-07.10). */
  async summary(query: PeriodQuery): Promise<SummaryReportDto> {
    const db = this.prisma.db;
    const organizationId = requireOrganizationId();
    const period = resolveHistoryPeriod(query);
    const unit = await this.requireUnit(db, query.unitId);
    const unitId = unit?.id ?? null;
    const range = { gte: dateColumn(period.from), lte: dateColumn(period.to) };
    const byUnit = unitId === null ? {} : { unitId };
    const [days, closedTabs, canceledItems, payments, openedTabs, sessions] = await Promise.all([
      dayTotals(db, organizationId, { unitId, ...period }),
      db.tab.findMany({
        where: { ...byUnit, closedBusinessDate: range },
        orderBy: [{ closedBusinessDate: 'asc' }, { number: 'asc' }],
      }),
      db.orderItem.findMany({
        where: { ...byUnit, canceledBusinessDate: range },
        select: itemSelect,
        orderBy: [{ canceledAt: 'asc' }, { id: 'asc' }],
      }),
      db.payment.findMany({
        where: { reversedAt: null, session: { ...byUnit, businessDate: range } },
        include: {
          tab: {
            select: { number: true, customerName: true, businessDate: true, customerId: true },
          },
        },
        orderBy: { id: 'asc' },
      }),
      db.tab.findMany({ where: { ...byUnit, businessDate: range } }),
      db.cashRegisterSession.findMany({
        where: { ...byUnit, businessDate: range },
        include: sessionInclude,
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    const lines = await db.orderItem.findMany({
      where: { tabId: { in: closedTabs.map((tab) => tab.id) } },
      select: itemSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const orders = await db.order.findMany({
      where: { tabId: { in: openedTabs.map((tab) => tab.id) } },
      select: { createdByType: true, createdById: true },
    });
    const data: SectionData = { closedTabs, lines, canceledItems, payments, openedTabs, orders };
    const sections = await this.sections(db, data);
    const totals = sumTotals(days);

    // RN-07.06: partial when the period has the current day of a unit with an open register.
    const operating = await db.unit.findMany({
      where: {
        ...(unitId === null ? {} : { id: unitId }),
        businessDate: range,
        cashSessions: { some: { status: 'open' } },
      },
      select: { id: true },
    });
    const partial = operating.length > 0;
    const openTabs = partial
      ? await db.tab.findMany({
          where: { ...byUnit, status: { in: ['open', 'closing'] } },
          select: { id: true },
        })
      : [];
    const openTotals = partial
      ? await this.tabTotalsOf(
          db,
          openTabs.map((tab) => tab.id),
        )
      : null;

    // Events with tabs closed in the period (the section only shows when there is one).
    const eventIds = [
      ...new Set(closedTabs.flatMap((tab) => (tab.eventId === null ? [] : [tab.eventId]))),
    ];
    const eventRows =
      eventIds.length === 0
        ? []
        : await db.contractedEvent.findMany({
            where: { id: { in: eventIds } },
            orderBy: [{ startsOn: 'asc' }, { id: 'asc' }],
          });
    const totalOfTab = this.totalOfTab(closedTabs, lines);
    const unitNames = await this.unitNames(db);
    return {
      unit: unit === null ? null : { id: unit.id, name: unit.name },
      period: periodOut(period),
      partial,
      summary: summaryDto(totals),
      openTabsNow: openTotals === null ? null : { count: openTabs.length, totalCents: openTotals },
      products: sections.products,
      paymentMethods: sections.paymentMethods,
      staff: sections.staff,
      cashSessions: await this.sessionLines(db, sessions, unitNames),
      credit: { ...sections.credit, onCreditCents: totals.onCreditCents },
      cancellations: {
        ...sections.cancellations,
        wasteCents: totals.wasteCents,
        wasteQuantity: totals.wasteQuantity,
      },
      events: eventRows.map((event) => ({
        eventId: event.id,
        contractorName: event.contractorName,
        status: event.status,
        salesCents: closedTabs
          .filter((tab) => tab.eventId === event.id && SALE_STATUSES.has(tab.status))
          .reduce((sum, tab) => sum + totalOfTab(tab.id), 0),
      })),
    };
  }

  /** `GET /cash-register-sessions/{id}/report` (spec 07, section 5; RN-07.09; CA-07.04, CA-07.09). */
  async sessionReport(sessionId: string): Promise<SessionReportDto> {
    const db = this.prisma.db;
    const organizationId = requireOrganizationId();
    const row = await db.cashRegisterSession.findUnique({
      where: { id: sessionId },
      include: { unit: { select: { name: true } } },
    });
    if (!row) {
      throw AppError.of('NOT_FOUND');
    }
    const [session, totalsById, movements, payments] = await Promise.all([
      loadSession(db, sessionId),
      sessionTotals(db, organizationId, [sessionId]),
      db.cashMovement.findMany({
        where: { cashRegisterSessionId: sessionId },
        orderBy: { id: 'asc' },
      }),
      db.payment.findMany({
        where: { cashRegisterSessionId: sessionId },
        include: { tab: { select: { number: true, customerName: true } } },
        orderBy: { id: 'asc' },
      }),
    ]);
    const names = await ActorNames.load(db, [
      session.openedBy,
      ...(session.closedBy === null ? [] : [session.closedBy]),
      ...movements.map((movement) => ({ type: movement.createdByType, id: movement.createdById })),
      ...payments.map((payment) => ({ type: payment.receivedByType, id: payment.receivedById })),
    ]);
    return {
      session,
      unitName: row.unit.name,
      responsible: names.of(session.openedBy.type, session.openedBy.id),
      closedByActor:
        session.closedBy === null ? null : names.of(session.closedBy.type, session.closedBy.id),
      partial: session.status === 'open',
      timeZone: TIME_ZONE,
      totals: totalsDto(totalsById.get(sessionId) ?? EMPTY_TOTALS),
      byMethod: session.expected.map((expected) => {
        const count = session.counts.find((row) => row.method === expected.method);
        return {
          method: expected.method,
          expectedCents: count?.expectedCents ?? expected.expectedCents,
          informedCents: count?.informedCents ?? null,
          differenceCents: count?.differenceCents ?? null,
          salesCents: expected.salesCents,
          settlementsCents: expected.creditSettlementsCents,
        };
      }),
      movements: movements.map((movement) => ({
        id: movement.id,
        type: movement.type,
        amountCents: movement.amountCents,
        reason: movement.reason,
        createdBy: names.of(movement.createdByType, movement.createdById),
        createdAt: movement.createdAt.toISOString(),
      })),
      payments: payments.map((payment) => ({
        paymentId: payment.id,
        tabId: payment.tabId,
        tabNumber: payment.tab.number,
        customerName: payment.tab.customerName,
        method: payment.method,
        amountCents: payment.amountCents,
        changeCents: payment.changeCents,
        isCreditSettlement: payment.isCreditSettlement,
        receivedBy: names.of(payment.receivedByType, payment.receivedById),
        receivedAt: payment.createdAt.toISOString(),
        reversedAt: payment.reversedAt?.toISOString() ?? null,
        reversalReason: payment.reversalReason,
      })),
      pending:
        session.pendingTabsCount === null
          ? null
          : { count: session.pendingTabsCount, totalCents: session.pendingTabsTotalCents ?? 0 },
    };
  }

  /** `GET /events/{id}/report` (spec 07, section 6; RN-07.10; CA-07.03). */
  async eventReport(eventId: string): Promise<EventReportDto> {
    const db = this.prisma.db;
    const organizationId = requireOrganizationId();
    const event = await db.contractedEvent.findUnique({
      where: { id: eventId },
      include: { ...eventInclude, unit: { select: { name: true } } },
    });
    if (!event) {
      throw AppError.of('NOT_FOUND');
    }
    const tabs = await db.tab.findMany({
      where: { eventId },
      orderBy: [{ businessDate: 'asc' }, { number: 'asc' }],
    });
    const tabIds = tabs.map((tab) => tab.id);
    const [totalsById, lines, payments, orders, allPayments] = await Promise.all([
      eventTotals(db, organizationId, [eventId]),
      db.orderItem.findMany({
        where: { tabId: { in: tabIds } },
        select: itemSelect,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      db.payment.findMany({
        where: { tabId: { in: tabIds }, reversedAt: null },
        include: {
          tab: {
            select: { number: true, customerName: true, businessDate: true, customerId: true },
          },
        },
        orderBy: { id: 'asc' },
      }),
      db.order.findMany({
        where: { tabId: { in: tabIds } },
        select: { createdByType: true, createdById: true },
      }),
      db.payment.findMany({
        where: { tabId: { in: tabIds }, reversedAt: null },
        select: { tabId: true, amountCents: true },
      }),
    ]);
    const closedTabs = tabs.filter((tab) => tab.status !== 'open' && tab.status !== 'closing');
    const sections = await this.sections(db, {
      closedTabs,
      lines: lines.filter((line) => closedTabs.some((tab) => tab.id === line.tabId)),
      canceledItems: lines.filter((line) => line.canceledAt !== null),
      payments,
      openedTabs: tabs,
      orders,
    });
    const totals = totalsById.get(eventId) ?? EMPTY_TOTALS;
    const totalOfTab = this.totalOfTab(tabs, lines);
    return {
      event: toEventDto(event),
      unitName: event.unit.name,
      partial: event.status === 'in_progress',
      timeZone: TIME_ZONE,
      summary: summaryDto(totals),
      agreement: {
        consumedQuantity: totals.consumedQuantity,
        consumedCents: totals.salesCents,
        quantityDifference:
          event.agreedQuantity === null ? null : event.agreedQuantity - totals.consumedQuantity,
      },
      products: sections.products,
      tabs: tabs.map((tab) => {
        const paid = allPayments
          .filter((payment) => payment.tabId === tab.id)
          .reduce((sum, payment) => sum + payment.amountCents, 0);
        const total = totalOfTab(tab.id);
        return {
          tabId: tab.id,
          number: tab.number,
          customerName: tab.customerName,
          status: tab.status,
          businessDate: isoDateOf(tab.businessDate),
          totalCents: total,
          paidCents: paid,
          balanceCents: tab.status === 'canceled' ? 0 : total - paid,
        };
      }),
      credit: { ...sections.credit, onCreditCents: totals.onCreditCents },
      cancellations: {
        ...sections.cancellations,
        wasteCents: totals.wasteCents,
        wasteQuantity: totals.wasteQuantity,
      },
    };
  }

  /** `GET /reports/days` (spec 07, section 7; CA-07.04, CA-07.10): one row per unit and day. */
  async days(query: HistoryQuery): Promise<DayHistoryDto> {
    const db = this.prisma.db;
    const organizationId = requireOrganizationId();
    const period = resolveHistoryPeriod(query);
    const unit = await this.requireUnit(db, query.unitId);
    const rows = await dayTotals(db, organizationId, { unitId: unit?.id ?? null, ...period });
    const after = this.cursor(query.cursor);
    const remaining =
      after === null
        ? rows
        : rows.filter(
            (row) =>
              row.businessDate < after.key ||
              (row.businessDate === after.key && row.unitId > after.id),
          );
    const page = remaining.slice(0, query.limit);
    const names = await this.unitNames(db);
    const operating = new Set(
      (
        await db.unit.findMany({
          where: { cashSessions: { some: { status: 'open' } } },
          select: { id: true, businessDate: true },
        })
      ).map((row) => `${row.id}|${row.businessDate === null ? '' : isoDateOf(row.businessDate)}`),
    );
    const last = page.at(-1);
    return {
      period: periodOut(period),
      totals: totalsDto(sumTotals(rows)),
      data: page.map((row) => ({
        unitId: row.unitId,
        unitName: names.get(row.unitId) ?? '',
        businessDate: row.businessDate,
        partial: operating.has(`${row.unitId}|${row.businessDate}`),
        ...totalsDto(row),
      })),
      nextCursor:
        remaining.length > query.limit && last
          ? encodeKeysetCursor(last.businessDate, last.unitId)
          : null,
    };
  }

  /** `GET /reports/cash-sessions` (spec 07, section 7): sessions of the period, newest first. */
  async cashSessions(query: SessionHistoryQuery): Promise<SessionHistoryDto> {
    const db = this.prisma.db;
    const organizationId = requireOrganizationId();
    const period = resolveHistoryPeriod(query);
    const unit = await this.requireUnit(db, query.unitId);
    const after = this.cursor(query.cursor);
    const afterDate = after === null ? null : new Date(after.key);
    if (afterDate !== null && Number.isNaN(afterDate.getTime())) {
      throw invalidCursor();
    }
    const [rows, days] = await Promise.all([
      db.cashRegisterSession.findMany({
        where: {
          businessDate: { gte: dateColumn(period.from), lte: dateColumn(period.to) },
          ...(unit === null ? {} : { unitId: unit.id }),
          ...(query.cashRegisterId === undefined
            ? {}
            : { cashRegisterId: query.cashRegisterId.toLowerCase() }),
          ...(after === null || afterDate === null
            ? {}
            : {
                OR: [
                  { openedAt: { lt: afterDate } },
                  { openedAt: afterDate, id: { lt: after.id } },
                ],
              }),
        },
        include: sessionInclude,
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
      dayTotals(db, organizationId, { unitId: unit?.id ?? null, ...period }),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      period: periodOut(period),
      totals: totalsDto(sumTotals(days)),
      data: await this.sessionLines(db, page, await this.unitNames(db)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeKeysetCursor(last.openedAt.toISOString(), last.id)
          : null,
    };
  }

  /** `GET /reports/events` (spec 07, section 7): events starting in the period, newest first. */
  async events(query: EventHistoryQuery): Promise<EventHistoryDto> {
    const db = this.prisma.db;
    const organizationId = requireOrganizationId();
    const period = resolveHistoryPeriod(query);
    const unit = await this.requireUnit(db, query.unitId);
    const after = this.cursor(query.cursor);
    if (after !== null && !/^\d{4}-\d{2}-\d{2}$/.test(after.key)) {
      throw invalidCursor();
    }
    const [rows, days] = await Promise.all([
      db.contractedEvent.findMany({
        where: {
          startsOn: { gte: dateColumn(period.from), lte: dateColumn(period.to) },
          ...(unit === null ? {} : { unitId: unit.id }),
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(after === null
            ? {}
            : {
                OR: [
                  { startsOn: { lt: dateColumn(after.key) } },
                  { startsOn: dateColumn(after.key), id: { lt: after.id } },
                ],
              }),
        },
        orderBy: [{ startsOn: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
      dayTotals(db, organizationId, { unitId: unit?.id ?? null, ...period }),
    ]);
    const page = rows.slice(0, query.limit);
    const totals = await eventTotals(
      db,
      organizationId,
      page.map((event) => event.id),
    );
    const names = await this.unitNames(db);
    const last = page.at(-1);
    return {
      period: periodOut(period),
      totals: totalsDto(sumTotals(days)),
      data: page.map((event) => {
        const row = totals.get(event.id) ?? EMPTY_TOTALS;
        return {
          eventId: event.id,
          unitId: event.unitId,
          unitName: names.get(event.unitId) ?? '',
          contractorName: event.contractorName,
          startsOn: isoDateOf(event.startsOn),
          endsOn: event.endsOn === null ? null : isoDateOf(event.endsOn),
          status: event.status,
          salesCents: row.salesCents,
          consumedQuantity: row.consumedQuantity,
          agreedQuantity: event.agreedQuantity,
          quantityDifference:
            event.agreedQuantity === null ? null : event.agreedQuantity - row.consumedQuantity,
        };
      }),
      nextCursor:
        rows.length > query.limit && last
          ? encodeKeysetCursor(isoDateOf(last.startsOn), last.id)
          : null,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Sections
  // ---------------------------------------------------------------------------------------------

  private async sections(db: TenantDb, data: SectionData) {
    const organizationId = requireOrganizationId();
    const { closedTabs, lines, canceledItems, payments, openedTabs, orders } = data;
    const tabById = new Map([...openedTabs, ...closedTabs].map((tab) => [tab.id, tab]));
    const canceledTabIds = [
      ...new Set([...closedTabs.map((tab) => tab.id), ...canceledItems.map((item) => item.tabId)]),
    ];
    const missing = canceledTabIds.filter((id) => !tabById.has(id));
    for (const tab of missing.length === 0
      ? []
      : await db.tab.findMany({ where: { id: { in: missing } } })) {
      tabById.set(tab.id, tab);
    }
    const hung = closedTabs.filter(
      (tab) => tab.creditAt !== null && (tab.status === 'on_credit' || tab.status === 'settled'),
    );
    const [tabPayments, audits] = await Promise.all([
      hung.length === 0
        ? []
        : db.payment.findMany({
            where: { tabId: { in: hung.map((tab) => tab.id) }, reversedAt: null },
            select: { tabId: true, amountCents: true, isCreditSettlement: true },
          }),
      closedTabs.length === 0
        ? []
        : db.auditLog.findMany({
            where: {
              organizationId,
              entityType: 'tab',
              entityId: { in: closedTabs.map((tab) => tab.id) },
              action: { in: ['tab.discount_applied', 'tab.canceled'] },
            },
            select: { action: true, entityId: true, actorType: true, actorId: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          }),
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
      ...openedTabs.map((tab) => ({ type: tab.openedByType, id: tab.openedById })),
      ...orders.map((order) => ({ type: order.createdByType, id: order.createdById })),
      ...payments.map((row) => ({ type: row.receivedByType, id: row.receivedById })),
      ...canceledItems.flatMap((item) =>
        item.canceledByType === null ? [] : [{ type: item.canceledByType, id: item.canceledById }],
      ),
      ...discountBy.values(),
      ...canceledBy.values(),
    ]);
    const totalOf = (tabId: string) => {
      const tab = tabById.get(tabId);
      return tabTotals(
        lines.filter((line) => line.tabId === tabId),
        { type: tab?.discountType ?? null, value: tab?.discountValue ?? null },
      );
    };

    // Per product (RN-07.04): lines not canceled of the tabs that count as a sale, and per list.
    const listIds = [
      ...new Set(lines.flatMap((line) => (line.priceListId === null ? [] : [line.priceListId]))),
    ];
    const listNames = new Map(
      (listIds.length === 0
        ? []
        : await db.priceList.findMany({
            where: { id: { in: listIds } },
            select: { id: true, name: true },
          })
      ).map((row) => [row.id, row.name]),
    );
    const products = new Map<string, SummaryReportDto['products'][number]>();
    for (const item of lines) {
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
        priceLists: [],
      };
      const value = lineTotalCents(item);
      line.quantity += item.quantity;
      line.valueCents += value;
      let list = line.priceLists.find((row) => row.priceListId === item.priceListId);
      if (!list) {
        list = {
          priceListId: item.priceListId,
          priceListName:
            item.priceListId === null
              ? NORMAL_PRICE_LIST_NAME
              : (listNames.get(item.priceListId) ?? ''),
          quantity: 0,
          valueCents: 0,
        };
        line.priceLists.push(list);
      }
      list.quantity += item.quantity;
      list.valueCents += value;
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
        // The breakdown by list only shows when a list was used.
        priceLists: line.priceLists.some((row) => row.priceListId !== null)
          ? [...line.priceLists].sort((a, b) => b.valueCents - a.valueCents)
          : [],
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
      const key = `${type}:${id ?? ''}`;
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
    for (const tab of openedTabs) {
      tally(tab.openedByType, tab.openedById).tabsOpened += 1;
    }
    for (const order of orders) {
      tally(order.createdByType, order.createdById).ordersSent += 1;
    }
    for (const payment of payments) {
      tally(payment.receivedByType, payment.receivedById).receivedCents += payment.amountCents;
    }
    for (const item of canceledItems) {
      if (item.canceledByType !== null) {
        tally(item.canceledByType, item.canceledById).itemsCanceled += item.quantity;
      }
    }
    for (const [tabId, actor] of canceledBy) {
      if (tabById.get(tabId)?.status === 'canceled') {
        tally(actor.type, actor.id).tabsCanceled += 1;
      }
    }
    for (const tab of closedTabs) {
      const actor = discountBy.get(tab.id);
      if (!actor || tab.discountType === null || !SALE_STATUSES.has(tab.status)) {
        continue;
      }
      const row = tally(actor.type, actor.id);
      row.discountCount += 1;
      row.discountsCents += totalOf(tab.id).discountCents;
    }
    const staff = [...tallies.values()]
      .map((row) => ({ ...row, actor: names.of(row.actor.type, row.actor.id) }))
      .sort(
        (a, b) =>
          b.receivedCents - a.receivedCents ||
          (a.actor.name ?? '').localeCompare(b.actor.name ?? '', 'pt-BR'),
      );

    // Fiado (RN-07.03): tabs put on credit in the scope and settlements received in it.
    const creditTabs = hung.map((tab) => {
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
        tabBusinessDate: isoDateOf(row.tab.businessDate),
        customerName: row.tab.customerName,
        customer: customerOf(row.tab.customerId),
        method: row.method,
        amountCents: row.amountCents,
        receivedAt: row.createdAt.toISOString(),
        receivedBy: names.of(row.receivedByType, row.receivedById),
      }));
    const canceledLines = canceledItems.map((item) => ({
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
    const canceledTabs = closedTabs
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
    return {
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
      staff,
      credit: {
        onCreditCents: 0,
        settlementsCents: settlements.reduce((sum, row) => sum + row.amountCents, 0),
        tabs: creditTabs,
        settlements,
      },
      cancellations: { wasteCents: 0, wasteQuantity: 0, items: canceledLines, tabs: canceledTabs },
    };
  }

  private totalOfTab(tabs: readonly TabRow[], lines: readonly ItemRow[]) {
    const byId = new Map(tabs.map((tab) => [tab.id, tab]));
    return (tabId: string): number => {
      const tab = byId.get(tabId);
      return tabTotals(
        lines.filter((line) => line.tabId === tabId),
        { type: tab?.discountType ?? null, value: tab?.discountValue ?? null },
      ).totalCents;
    };
  }

  private async tabTotalsOf(db: TenantDb, tabIds: readonly string[]): Promise<number> {
    if (tabIds.length === 0) {
      return 0;
    }
    const [tabs, lines] = await Promise.all([
      db.tab.findMany({ where: { id: { in: [...tabIds] } } }),
      db.orderItem.findMany({ where: { tabId: { in: [...tabIds] } }, select: itemSelect }),
    ]);
    const totalOf = this.totalOfTab(tabs, lines);
    return tabs.reduce((sum, tab) => sum + totalOf(tab.id), 0);
  }

  private async sessionLines(
    db: TenantDb,
    sessions: readonly Prisma.CashRegisterSessionGetPayload<{ include: typeof sessionInclude }>[],
    unitNames: ReadonlyMap<string, string>,
  ): Promise<ReportSessionLineDto[]> {
    const names = await ActorNames.load(
      db,
      sessions.map((session) => ({ type: session.openedByType, id: session.openedById })),
    );
    return sessions.map((session) => ({
      sessionId: session.id,
      cashRegisterId: session.cashRegisterId,
      name: session.cashRegister.name,
      unitId: session.unitId,
      unitName: unitNames.get(session.unitId) ?? '',
      businessDate: isoDateOf(session.businessDate),
      status: session.status,
      responsible: names.of(session.openedByType, session.openedById),
      openedAt: session.openedAt.toISOString(),
      closedAt: session.closedAt?.toISOString() ?? null,
      receivedCents: session.payments
        .filter((payment) => payment.reversedAt === null)
        .reduce((sum, payment) => sum + payment.amountCents, 0),
      differenceCents: session.counts.reduce((sum, count) => sum + count.differenceCents, 0),
      pendingTabsCount: session.pendingTabsCount,
      pendingTabsTotalCents: session.pendingTabsTotalCents,
    }));
  }

  private async unitNames(db: TenantDb): Promise<Map<string, string>> {
    const units = await db.unit.findMany({ select: { id: true, name: true } });
    return new Map(units.map((unit) => [unit.id, unit.name]));
  }

  /** A unit of the organization (404 otherwise), or null for all of them. */
  private async requireUnit(
    db: TenantDb,
    unitId: string | undefined,
  ): Promise<{ id: string; name: string } | null> {
    if (unitId === undefined) {
      return null;
    }
    const unit = await db.unit.findUnique({
      where: { id: unitId.toLowerCase() },
      select: { id: true, name: true },
    });
    if (!unit) {
      throw AppError.of('NOT_FOUND');
    }
    return unit;
  }

  private cursor(cursor: string | undefined): { key: string; id: string } | null {
    if (cursor === undefined) {
      return null;
    }
    const decoded = decodeKeysetCursor(cursor);
    if (decoded === null) {
      throw invalidCursor();
    }
    return decoded;
  }
}

function invalidCursor(): AppError {
  return AppError.of('VALIDATION_FAILED', {
    details: { fields: [{ path: 'cursor', message: 'Cursor inválido.' }] },
  });
}
