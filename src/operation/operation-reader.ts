import type {
  OrderItem,
  OrderItemModifier,
  Prisma,
  Shift,
  ShiftAgreement,
  ShiftPrice,
  Tab,
  WorkflowStage,
} from '../generated/prisma/client.js';
import type { ActorType } from '../generated/prisma/enums.js';
import { AppError } from '../errors/app-error.js';
import type { TenantDb } from '../prisma/prisma.service.js';
import { isLate, lateAtOf, lineTotalCents, tabTotals } from './order-rules.js';
import { paidCents } from './payment-rules.js';
import type {
  OrderDto,
  OrderItemDto,
  PaymentDto,
  ShiftDto,
  TabDto,
  TabSummaryDto,
} from './operation.schemas.js';

/*
 * Reads of the operation, shared by the services: rows → DTOs, with the values computed on the
 * server (totals, lateness, stage names).
 */

export const itemInclude = {
  modifiers: { orderBy: { position: 'asc' } },
  stage: { select: { name: true, isFinal: true, sortOrder: true } },
  order: { select: { numberInTab: true, sentAt: true } },
  tab: { select: { number: true, customerName: true } },
} satisfies Prisma.OrderItemInclude;

export type ItemRow = Prisma.OrderItemGetPayload<{ include: typeof itemInclude }>;

/** Lines in the order they were sent; a split line comes right after its original (UUID v7). */
export const itemOrder = [{ position: 'asc' as const }, { id: 'asc' as const }];

/** Workflow of a unit, as the operation needs it. */
export interface UnitFlow {
  unitId: string;
  lateAfterMinutes: number;
  /** Active stages in order. */
  stages: WorkflowStage[];
  first: WorkflowStage;
  final: WorkflowStage;
  /** The stage right before the final one ("Pronto" in the template; RN-04.21). */
  beforeFinal: WorkflowStage | null;
}

export async function loadUnitFlow(db: TenantDb, unitId: string): Promise<UnitFlow> {
  const [unit, stages] = await Promise.all([
    db.unit.findUniqueOrThrow({ where: { id: unitId }, select: { lateAfterMinutes: true } }),
    db.workflowStage.findMany({
      where: { unitId, archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    }),
  ]);
  const first = stages[0];
  const final = stages.at(-1);
  if (!first || !final?.isFinal) {
    // The workflow always has 2 to 8 stages, the last one final (RN-03.05).
    throw AppError.of('CONFLICT', {
      message: 'O fluxo de etapas da unidade não está configurado.',
    });
  }
  return {
    unitId,
    lateAfterMinutes: unit.lateAfterMinutes,
    stages,
    first,
    final,
    beforeFinal: stages.at(-2) ?? null,
  };
}

/** The next and the previous active stage of `stageId` (null at the ends). */
export function neighbours(
  flow: UnitFlow,
  stageId: string,
): { current: WorkflowStage | null; next: WorkflowStage | null; previous: WorkflowStage | null } {
  const index = flow.stages.findIndex((stage) => stage.id === stageId);
  if (index === -1) {
    return { current: null, next: null, previous: null };
  }
  return {
    current: flow.stages[index] ?? null,
    next: flow.stages[index + 1] ?? null,
    previous: flow.stages[index - 1] ?? null,
  };
}

function actorRef(type: ActorType, id: string | null): { type: ActorType; id: string | null } {
  return { type, id };
}

export function toOrderItemDto(row: ItemRow, lateAfterMinutes: number, now: Date): OrderItemDto {
  const lateAt = lateAtOf(
    { canceledAt: row.canceledAt, inFinalStage: row.stage.isFinal, sentAt: row.order.sentAt },
    lateAfterMinutes,
  );
  return {
    id: row.id,
    orderId: row.orderId,
    tabId: row.tabId,
    unitId: row.unitId,
    tabNumber: row.tab.number,
    customerName: row.tab.customerName,
    orderNumberInTab: row.order.numberInTab,
    productId: row.productId,
    productName: row.productName,
    unitPriceCents: row.unitPriceCents,
    quantity: row.quantity,
    note: row.note,
    modifiers: row.modifiers.map(toModifierDto),
    totalCents: lineTotalCents(row),
    prepStationId: row.prepStationId,
    stationId: row.stationId,
    stageId: row.stageId,
    stageName: row.stage.name,
    stageIsFinal: row.stage.isFinal,
    stageEnteredAt: row.stageEnteredAt.toISOString(),
    sentAt: row.order.sentAt.toISOString(),
    lateAt: lateAt?.toISOString() ?? null,
    isLate: isLate(lateAt, now),
    canceledAt: row.canceledAt?.toISOString() ?? null,
    canceledBy: row.canceledByType === null ? null : actorRef(row.canceledByType, row.canceledById),
    cancelReason: row.cancelReason,
    wasted: row.wasted,
    splitFromId: row.splitFromId,
    version: row.version,
  };
}

function toModifierDto(modifier: OrderItemModifier): OrderItemDto['modifiers'][number] {
  return {
    modifierId: modifier.modifierId,
    groupName: modifier.groupName,
    modifierName: modifier.modifierName,
    priceDeltaCents: modifier.priceDeltaCents,
  };
}

export async function loadItem(
  db: TenantDb,
  itemId: string,
  now = new Date(),
): Promise<OrderItemDto> {
  const row = await db.orderItem.findUnique({ where: { id: itemId }, include: itemInclude });
  if (!row) {
    throw AppError.of('NOT_FOUND');
  }
  const unit = await db.unit.findUniqueOrThrow({
    where: { id: row.unitId },
    select: { lateAfterMinutes: true },
  });
  return toOrderItemDto(row, unit.lateAfterMinutes, now);
}

export async function loadOrders(
  db: TenantDb,
  where: Prisma.OrderWhereInput,
  lateAfterMinutes: number,
  now = new Date(),
): Promise<OrderDto[]> {
  const orders = await db.order.findMany({
    where,
    include: { tab: { select: { number: true, customerName: true, unitId: true } } },
    orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
  });
  const items = await db.orderItem.findMany({
    where: { orderId: { in: orders.map((order) => order.id) } },
    include: itemInclude,
    orderBy: itemOrder,
  });
  return orders.map((order) => ({
    id: order.id,
    tabId: order.tabId,
    shiftId: order.shiftId,
    unitId: order.tab.unitId,
    tabNumber: order.tab.number,
    customerName: order.tab.customerName,
    numberInTab: order.numberInTab,
    status: order.status,
    createdBy: actorRef(order.createdByType, order.createdById),
    sentAt: order.sentAt.toISOString(),
    completedAt: order.completedAt?.toISOString() ?? null,
    items: items
      .filter((item) => item.orderId === order.id)
      .map((item) => toOrderItemDto(item, lateAfterMinutes, now)),
    version: order.version,
  }));
}

/** Varal cards (spec 04, section 8.1): totals and a summary of the items of each tab. */
export async function loadTabSummaries(
  db: TenantDb,
  tabs: readonly Tab[],
  now = new Date(),
): Promise<TabSummaryDto[]> {
  if (tabs.length === 0) {
    return [];
  }
  const items = await db.orderItem.findMany({
    where: { tabId: { in: tabs.map((tab) => tab.id) } },
    include: itemInclude,
  });
  const payments = await db.payment.findMany({
    where: { tabId: { in: tabs.map((tab) => tab.id) }, reversedAt: null },
    select: { tabId: true, amountCents: true, reversedAt: true },
  });
  const flows = new Map<string, UnitFlow>();
  for (const unitId of new Set(tabs.map((tab) => tab.unitId))) {
    flows.set(unitId, await loadUnitFlow(db, unitId));
  }
  return tabs.map((tab) => {
    const flow = flows.get(tab.unitId);
    const lines = items.filter((item) => item.tabId === tab.id);
    const paid = paidCents(payments.filter((payment) => payment.tabId === tab.id));
    return toTabSummary(tab, lines, flow, paid, now);
  });
}

function toTabSummary(
  tab: Tab,
  lines: readonly ItemRow[],
  flow: UnitFlow | undefined,
  paid: number,
  now: Date,
): TabSummaryDto {
  const totals = tabTotals(lines, { type: tab.discountType, value: tab.discountValue });
  const active = lines.filter((line) => line.canceledAt === null);
  const units = (rows: readonly ItemRow[]) => rows.reduce((sum, row) => sum + row.quantity, 0);
  const lateAfterMinutes = flow?.lateAfterMinutes ?? 0;
  return {
    id: tab.id,
    shiftId: tab.shiftId,
    unitId: tab.unitId,
    number: tab.number,
    customerName: tab.customerName,
    mode: tab.mode,
    status: tab.status,
    subtotalCents: totals.subtotalCents,
    discountType: tab.discountType,
    discountValue: tab.discountValue,
    discountCents: totals.discountCents,
    totalCents: totals.totalCents,
    itemCount: units(active),
    readyItemCount: units(active.filter((line) => line.stageId === flow?.beforeFinal?.id)),
    lateItemCount: units(
      active.filter((line) =>
        isLate(
          lateAtOf(
            { canceledAt: null, inFinalStage: line.stage.isFinal, sentAt: line.order.sentAt },
            lateAfterMinutes,
          ),
          now,
        ),
      ),
    ),
    discountReason: tab.discountReason,
    paidCents: paid,
    balanceCents: totals.totalCents - paid,
    openedAt: tab.createdAt.toISOString(),
    openedBy: actorRef(tab.openedByType, tab.openedById),
    closedAt: tab.closedAt?.toISOString() ?? null,
    version: tab.version,
  };
}

export async function loadTabSummary(
  db: TenantDb,
  tabId: string,
  now = new Date(),
): Promise<TabSummaryDto> {
  const tab = await db.tab.findUnique({ where: { id: tabId } });
  if (!tab) {
    throw AppError.of('NOT_FOUND');
  }
  const [summary] = await loadTabSummaries(db, [tab], now);
  if (!summary) {
    throw AppError.of('NOT_FOUND');
  }
  return summary;
}

/** `GET /tabs/{id}`: summary, orders and items. */
export async function loadTab(db: TenantDb, tabId: string, now = new Date()): Promise<TabDto> {
  const summary = await loadTabSummary(db, tabId, now);
  const flow = await loadUnitFlow(db, summary.unitId);
  const orders = await loadOrders(db, { tabId }, flow.lateAfterMinutes, now);
  const payments = await loadPayments(db, { tabId });
  return { ...summary, orders, payments };
}

export const paymentInclude = {
  tab: { select: { number: true, customerName: true } },
} satisfies Prisma.PaymentInclude;

export type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>;

export function toPaymentDto(row: PaymentRow): PaymentDto {
  return {
    id: row.id,
    tabId: row.tabId,
    tabNumber: row.tab.number,
    customerName: row.tab.customerName,
    shiftId: row.shiftId,
    cashRegisterId: row.cashRegisterId,
    method: row.method,
    amountCents: row.amountCents,
    tenderedCents: row.tenderedCents,
    changeCents: row.changeCents,
    isCreditSettlement: row.isCreditSettlement,
    receivedBy: actorRef(row.receivedByType, row.receivedById),
    createdAt: row.createdAt.toISOString(),
    reversedAt: row.reversedAt?.toISOString() ?? null,
    reversedBy: row.reversedByType === null ? null : actorRef(row.reversedByType, row.reversedById),
    reversalReason: row.reversalReason,
  };
}

/** Payments in the order they were registered (UUID v7), reversed ones included. */
export async function loadPayments(
  db: TenantDb,
  where: Prisma.PaymentWhereInput,
): Promise<PaymentDto[]> {
  const rows = await db.payment.findMany({
    where,
    include: paymentInclude,
    orderBy: { id: 'asc' },
  });
  return rows.map(toPaymentDto);
}

type ShiftRow = Shift & { agreement: ShiftAgreement | null; prices: ShiftPrice[] };

export const shiftInclude = {
  agreement: true,
  prices: { orderBy: { productId: 'asc' } },
} satisfies Prisma.ShiftInclude;

export function toShiftDto(shift: ShiftRow): ShiftDto {
  const agreement = shift.agreement;
  return {
    id: shift.id,
    unitId: shift.unitId,
    type: shift.type,
    status: shift.status,
    openedAt: shift.openedAt.toISOString(),
    openedBy: actorRef(shift.openedByType, shift.openedById),
    closedAt: shift.closedAt?.toISOString() ?? null,
    closedBy: shift.closedByType === null ? null : actorRef(shift.closedByType, shift.closedById),
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
          },
    prices: shift.prices.map((price) => ({
      productId: price.productId,
      priceCents: price.priceCents,
    })),
    version: shift.version,
  };
}

export async function loadShift(db: TenantDb, shiftId: string): Promise<ShiftDto> {
  const shift = await db.shift.findUnique({ where: { id: shiftId }, include: shiftInclude });
  if (!shift) {
    throw AppError.of('NOT_FOUND');
  }
  return toShiftDto(shift);
}

/** Fields of a line copied by a split (RN-04.24, RN-04.26): the same copy of what was sold. */
export function splitCopy(
  item: OrderItem,
): Omit<
  Prisma.OrderItemUncheckedCreateInput,
  'quantity' | 'stageId' | 'stationId' | 'stageEnteredAt'
> {
  return {
    organizationId: item.organizationId,
    orderId: item.orderId,
    tabId: item.tabId,
    unitId: item.unitId,
    productId: item.productId,
    productName: item.productName,
    unitPriceCents: item.unitPriceCents,
    note: item.note,
    position: item.position,
    prepStationId: item.prepStationId,
    splitFromId: item.id,
  };
}
