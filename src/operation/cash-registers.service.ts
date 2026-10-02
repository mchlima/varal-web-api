import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { assertCanOpenCashRegister } from '../common/subscription.js';
import { dateColumn, plainDateOf, todayInSaoPaulo } from '../common/time.js';
import { updateWithVersion } from '../common/versioned-update.js';
import { requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import { type CashRegister, type CashRegisterSession, Prisma } from '../generated/prisma/client.js';
import type { CashMovementType, PaymentMethod } from '../generated/prisma/enums.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { OPEN_TAB_STATUSES } from '../units/operation-guard.js';
import { setupError } from '../units/setup-errors.js';
import { businessDateOnOpen } from './business-day.js';
import { loadRegister, loadRegisters, loadSession, loadSessionDetail } from './cash-reader.js';
import type {
  CashRegisterDto,
  CashRegisterSessionDetailDto,
  ClosePreviewDto,
  CloseCashRegisterRequest,
} from './cash.schemas.js';
import { finishEvent, startEvent } from './events.service.js';
import {
  assertCanOperateCash,
  canOperateCash,
  hasCounter,
  isOwner,
  OperationAccessService,
  type OperatorAccess,
} from './operation-access.js';
import { operationError } from './operation-errors.js';
import {
  CashRegisterClosed,
  CashRegisterOpened,
  CashRegisterUpdated,
  OperationEvents,
  TabUpdated,
} from './operation-events.js';
import {
  itemInclude,
  loadTabSummaries,
  loadTabSummary,
  loadUnitFlow,
  toOrderItemDto,
} from './operation-reader.js';
import { countsOf } from './payment-rules.js';
import { lockRow } from './row-lock.js';
import { UnitOperationService } from './unit-operation.service.js';

const CASH_FORBIDDEN = 'Só o dono ou quem opera o caixa nesta unidade pode mexer nos caixas.';

/**
 * Cash registers of a unit and their sessions (spec 05, section 5). A register is registered once
 * in the unit ("Caixa 1", RN-05.17) and opened and closed many times; each opening until the
 * closing is a session (abertura de caixa). Open, move and close: the owner and staff with
 * `can_operate_cash` (RN-05.16); the register list is also open to the counter, to choose where a
 * payment goes (RN-05.05); registering registers: the owner (RN-05.27).
 *
 * Opening the first register of a new day changes the day of operation of the unit and restarts
 * the tab numbers (RN-04.29, RN-05.25). Closing never waits for open tabs (RN-05.28); closing the
 * last register may finish the items in preparation and the event in progress (RN-05.29).
 *
 * Lock order: unit → session (open and close), tab → session (payments), session alone
 * (movements), so a session never closes in the middle of a payment.
 */
@Injectable()
export class CashRegistersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: OperationAccessService,
    private readonly events: OperationEvents,
    private readonly operation: UnitOperationService,
  ) {}

  /** `GET /units/{id}/cash-registers`: cash operators and the counter; inactive ones only for the owner. */
  async list(unitId: string): Promise<CashRegisterDto[]> {
    const db = this.prisma.db;
    const access = await this.access.forUnit(db, unitId);
    if (!canOperateCash(access) && !hasCounter(access)) {
      throw AppError.of('FORBIDDEN', {
        message: 'Só o balcão e quem opera o caixa veem os caixas da unidade.',
      });
    }
    return loadRegisters(db, { unitId, ...(isOwner(access) ? {} : { active: true }) });
  }

  /** RN-05.17, RN-05.27: the owner registers a register with a name unique in the unit. */
  async create(
    unitId: string,
    input: { name: string; sortOrder?: number | undefined },
  ): Promise<CashRegisterDto> {
    return this.prisma.transaction(async (db) => {
      assertOwner(await this.access.forUnit(db, unitId));
      await assertNameFree(db, unitId, input.name, null);
      const last = await db.cashRegister.aggregate({
        where: { unitId },
        _max: { sortOrder: true },
      });
      const register = await uniqueName(() =>
        db.cashRegister.create({
          data: {
            organizationId: requireOrganizationId(),
            unitId,
            name: input.name,
            sortOrder: input.sortOrder ?? (last._max.sortOrder ?? 0) + 1,
          },
        }),
      );
      await this.audit.record(db, {
        action: 'cash_register.created',
        entityType: 'cash_register',
        entityId: register.id,
        after: { name: register.name, sortOrder: register.sortOrder },
        metadata: { unitId },
      });
      const dto = await loadRegister(db, register.id);
      this.events.cashRegister(CashRegisterUpdated, dto);
      await this.operation.changed(db, unitId);
      return dto;
    });
  }

  /**
   * RN-05.27, CA-05.14: renames, reorders and (de)activates. An open register is not deactivated
   * (`CASH_REGISTER_OPEN`), nor the last active one (`LAST_ACTIVE_CASH_REGISTER`, RN-05.17).
   */
  async update(
    id: string,
    input: {
      name?: string | undefined;
      sortOrder?: number | undefined;
      active?: boolean | undefined;
      version?: number | undefined;
    },
  ): Promise<CashRegisterDto> {
    return this.prisma.transaction(async (db) => {
      const found = await requireRegister(db, id);
      assertOwner(await this.access.forUnit(db, found.unitId));
      await lockRow(db, 'units', found.unitId);
      const current = await requireRegister(db, id);
      if (input.name !== undefined && input.name.toLowerCase() !== current.name.toLowerCase()) {
        await assertNameFree(db, current.unitId, input.name, id);
      }
      if (input.active === false && current.active) {
        const open = await db.cashRegisterSession.count({
          where: { cashRegisterId: id, status: 'open' },
        });
        if (open > 0) {
          throw setupError('CASH_REGISTER_OPEN');
        }
        const others = await db.cashRegister.count({
          where: { unitId: current.unitId, active: true, id: { not: id } },
        });
        if (others === 0) {
          throw setupError('LAST_ACTIVE_CASH_REGISTER');
        }
      }
      const updated = await uniqueName(() =>
        updateWithVersion<CashRegister>(db.cashRegister, {
          where: { id },
          expectedVersion: input.version ?? current.version,
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
            ...(input.active === undefined ? {} : { active: input.active }),
          },
        }),
      );
      await this.audit.record(db, {
        action: 'cash_register.updated',
        entityType: 'cash_register',
        entityId: id,
        before: { name: current.name, sortOrder: current.sortOrder, active: current.active },
        after: { name: updated.name, sortOrder: updated.sortOrder, active: updated.active },
        metadata: { unitId: current.unitId },
      });
      const dto = await loadRegister(db, id);
      this.events.cashRegister(CashRegisterUpdated, dto);
      await this.operation.changed(db, current.unitId);
      return dto;
    });
  }

  /**
   * RN-05.23 to RN-05.25 (CA-05.10, CA-05.12, CA-02.05, CA-04.16): opens a session of the register
   * with the float. At most one session in progress per register; a suspended organization, an
   * inactive unit or an inactive register do not open. The first register of a new day changes the
   * day of operation and restarts the numbering (RN-04.29). `startEventId` starts the scheduled
   * event of the unit in the same operation (RN-04.35).
   */
  async open(
    registerId: string,
    input: { openingFloatCents: number; startEventId?: string | undefined },
  ): Promise<CashRegisterDto> {
    return this.prisma.transaction(async (db) => {
      const found = await requireRegister(db, registerId);
      const access = await this.access.forUnit(db, found.unitId);
      assertCanOperateCash(access, CASH_FORBIDDEN);
      const unitId = found.unitId;
      // Serializes the openings of the unit (the day of operation) and the setup (RN-03.07).
      await lockRow(db, 'units', unitId);
      const organization = await db.organization.findUniqueOrThrow({
        where: { id: requireOrganizationId() },
        select: { subscriptionStatus: true },
      });
      // RN-05.24, RN-01.01, RN-02.12 (CA-02.05).
      assertCanOpenCashRegister(organization.subscriptionStatus);
      const unit = await db.unit.findUniqueOrThrow({ where: { id: unitId } });
      if (!unit.active) {
        throw operationError('UNIT_INACTIVE');
      }
      const register = await requireRegister(db, registerId);
      if (!register.active) {
        throw operationError('CASH_REGISTER_INACTIVE');
      }
      const existing = await db.cashRegisterSession.findFirst({
        where: { cashRegisterId: registerId, status: 'open' },
        select: { id: true },
      });
      if (existing) {
        throw operationError('CASH_REGISTER_ALREADY_OPEN', { sessionId: existing.id });
      }
      // The workflow must exist before items can be routed (RN-04.19).
      await loadUnitFlow(db, unitId);

      const anotherOpen =
        (await db.cashRegisterSession.count({ where: { unitId, status: 'open' } })) > 0;
      const day = businessDateOnOpen(
        unit.businessDate === null ? null : plainDateOf(unit.businessDate),
        todayInSaoPaulo(),
        anotherOpen,
      );
      if (day.newDay) {
        // RN-04.29: a new day of operation; the tab numbers start again at 1.
        await db.unit.update({
          where: { id: unitId },
          data: { businessDate: dateColumn(day.businessDate), nextTabNumber: 1 },
        });
      }
      let session: CashRegisterSession;
      try {
        session = await db.cashRegisterSession.create({
          data: {
            organizationId: requireOrganizationId(),
            cashRegisterId: registerId,
            unitId,
            businessDate: dateColumn(day.businessDate),
            status: 'open',
            openingFloatCents: input.openingFloatCents,
            openedByType: access.actor.type,
            openedById: access.actor.id,
            openedAt: new Date(),
          },
        });
      } catch (error) {
        // Partial unique index of the open session of a register (CA-05.10).
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw operationError('CASH_REGISTER_ALREADY_OPEN');
        }
        throw error;
      }
      await db.cashRegister.update({
        where: { id: registerId },
        data: { version: { increment: 1 } },
      });
      await this.audit.record(db, {
        action: 'cash_register.opened',
        entityType: 'cash_register_session',
        entityId: session.id,
        after: {
          openingFloatCents: input.openingFloatCents,
          businessDate: day.businessDate.toString(),
        },
        metadata: { unitId, cashRegisterId: registerId, newBusinessDate: day.newDay },
      });
      if (input.startEventId !== undefined) {
        const event = await db.contractedEvent.findFirst({
          where: { id: input.startEventId.toLowerCase(), unitId },
        });
        if (!event) {
          throw AppError.of('NOT_FOUND', { message: 'Evento não encontrado nesta unidade.' });
        }
        this.events.contractedEvent(await startEvent(db, this.audit, event, access.actor));
      }
      const dto = await loadRegister(db, registerId);
      this.events.cashRegister(CashRegisterOpened, dto);
      await this.operation.changed(db, unitId);
      return dto;
    });
  }

  /** `GET /cash-register-sessions/{id}`: movements, payments and expected (cash operators). */
  async detail(sessionId: string): Promise<CashRegisterSessionDetailDto> {
    const db = this.prisma.db;
    const session = await requireSession(db, sessionId);
    assertCanOperateCash(await this.access.forUnit(db, session.unitId), CASH_FORBIDDEN);
    return loadSessionDetail(db, sessionId);
  }

  /** RN-05.18: withdrawal (sangria) or deposit (suprimento), with a reason, in an open session. */
  async move(
    sessionId: string,
    input: {
      type: CashMovementType;
      amountCents: number;
      reason: string;
      version?: number | undefined;
    },
  ): Promise<CashRegisterSessionDetailDto> {
    return this.prisma.transaction(async (db) => {
      const { session, access } = await this.lockOpen(db, sessionId);
      const before = await loadSession(db, sessionId);
      const cashExpected = before.expected.find((row) => row.method === 'cash')?.expectedCents ?? 0;
      if (input.type === 'withdrawal' && input.amountCents > cashExpected) {
        throw operationError('WITHDRAWAL_EXCEEDS_CASH', {
          expectedCashCents: cashExpected,
          amountCents: input.amountCents,
        });
      }
      await updateWithVersion<CashRegisterSession>(db.cashRegisterSession, {
        where: { id: sessionId },
        expectedVersion: input.version ?? session.version,
        data: {},
      });
      const movement = await db.cashMovement.create({
        data: {
          organizationId: requireOrganizationId(),
          cashRegisterSessionId: sessionId,
          type: input.type,
          amountCents: input.amountCents,
          reason: input.reason,
          createdByType: access.actor.type,
          createdById: access.actor.id,
        },
      });
      await this.audit.record(db, {
        action: input.type === 'withdrawal' ? 'cash_register.withdrawal' : 'cash_register.deposit',
        entityType: 'cash_movement',
        entityId: movement.id,
        after: { type: input.type, amountCents: input.amountCents, reason: input.reason },
        metadata: {
          cashRegisterSessionId: sessionId,
          cashRegisterId: session.cashRegisterId,
          unitId: session.unitId,
        },
      });
      await this.registerTouched(db, session.cashRegisterId);
      return loadSessionDetail(db, sessionId);
    });
  }

  /**
   * `GET /cash-register-sessions/{id}/close-preview` (RN-05.28, RN-05.29): expected per method, the
   * tabs that stay open and, for the last open register, the items in preparation and the event.
   */
  async closePreview(sessionId: string): Promise<ClosePreviewDto> {
    const db = this.prisma.db;
    const found = await requireSession(db, sessionId);
    assertCanOperateCash(await this.access.forUnit(db, found.unitId), CASH_FORBIDDEN);
    return this.preview(db, found);
  }

  /**
   * RN-05.20, RN-05.21, RN-05.28, RN-05.29 (CA-05.07, CA-05.11, CA-04.09, CA-04.19): closes the
   * session with the informed value of each method; any difference needs a note. Open tabs stay
   * open and are recorded as pending. Closing the last open register of the unit takes the items
   * still in preparation to the final stage (`finishPendingItems`, default true; one audit row per
   * item) and may finish the event in progress (`finishEvent`).
   * RN-01.01: a suspended organization can still close its open registers.
   */
  async close(sessionId: string, input: CloseCashRegisterRequest): Promise<CashRegisterDto> {
    return this.prisma.transaction(async (db) => {
      const found = await requireSession(db, sessionId);
      const access = await this.access.forUnit(db, found.unitId);
      assertCanOperateCash(access, CASH_FORBIDDEN);
      // The unit first: two registers closing at once agree on which one is the last.
      await lockRow(db, 'units', found.unitId);
      const { session } = await this.lockOpen(db, sessionId);
      const unitId = session.unitId;
      const current = await loadSession(db, sessionId);
      const expected = Object.fromEntries(
        current.expected.map((row) => [row.method, row.expectedCents]),
      ) as Record<PaymentMethod, number>;
      const counts = countsOf(
        expected,
        new Map(input.counts.map((count) => [count.method, count.informedCents])),
      );
      const note = input.note === undefined || input.note === '' ? null : input.note;
      if (note === null && counts.some((count) => count.differenceCents !== 0)) {
        throw operationError('CLOSING_NOTE_REQUIRED', { counts });
      }
      const preview = await this.preview(db, session);
      const now = new Date();
      if (preview.lastOpenRegister && input.finishPendingItems) {
        await this.finishItems(db, unitId, now);
      }
      if (preview.lastOpenRegister && input.finishEvent && preview.eventInProgress) {
        const event = await db.contractedEvent.findUniqueOrThrow({
          where: { id: preview.eventInProgress.id },
        });
        this.events.contractedEvent(await finishEvent(db, this.audit, event, access.actor));
      }
      await updateWithVersion<CashRegisterSession>(db.cashRegisterSession, {
        where: { id: sessionId },
        expectedVersion: input.version ?? session.version,
        data: {
          status: 'closed',
          closedAt: now,
          closedByType: access.actor.type,
          closedById: access.actor.id,
          closingNote: note,
          pendingTabsCount: preview.pendingTabs.length,
          pendingTabsTotalCents: preview.pendingTabsTotalCents,
        },
      });
      const organizationId = requireOrganizationId();
      await db.cashRegisterCount.createMany({
        data: counts.map((count) => ({
          organizationId,
          cashRegisterSessionId: sessionId,
          ...count,
        })),
      });
      await db.cashRegister.update({
        where: { id: session.cashRegisterId },
        data: { version: { increment: 1 } },
      });
      await this.audit.record(db, {
        action: 'cash_register.closed',
        entityType: 'cash_register_session',
        entityId: sessionId,
        before: { status: 'open' },
        after: {
          status: 'closed',
          counts,
          closingNote: note,
          pendingTabsCount: preview.pendingTabs.length,
          pendingTabsTotalCents: preview.pendingTabsTotalCents,
        },
        metadata: { cashRegisterId: session.cashRegisterId, unitId },
      });
      const dto = await loadRegister(db, session.cashRegisterId);
      this.events.cashRegister(CashRegisterClosed, dto);
      await this.operation.changed(db, unitId);
      return dto;
    });
  }

  /**
   * RN-05.05, RN-05.06 (CA-05.08): the session that receives a payment in `unitId`, locked. With a
   * register id, the open session of that register of the unit; without one, the only open session
   * of the unit (`CASH_REGISTER_REQUIRED` with more than one).
   */
  async forPayment(
    db: TenantDb,
    unitId: string,
    cashRegisterId: string | undefined,
  ): Promise<CashRegisterSession> {
    const open = await db.cashRegisterSession.findMany({
      where: { unitId, status: 'open' },
      include: { cashRegister: { select: { name: true, sortOrder: true } } },
      orderBy: [{ cashRegister: { sortOrder: 'asc' } }, { id: 'asc' }],
    });
    let sessionId: string;
    if (cashRegisterId === undefined) {
      const [only] = open;
      if (!only) {
        throw operationError('NO_CASH_REGISTER_OPEN');
      }
      if (open.length > 1) {
        throw operationError('CASH_REGISTER_REQUIRED', {
          cashRegisters: open.map((row) => ({
            id: row.cashRegisterId,
            name: row.cashRegister.name,
          })),
        });
      }
      sessionId = only.id;
    } else {
      const id = cashRegisterId.toLowerCase();
      const register = await db.cashRegister.findFirst({ where: { id, unitId } });
      if (!register) {
        throw operationError('INVALID_CASH_REGISTER');
      }
      const session = open.find((row) => row.cashRegisterId === id);
      if (!session) {
        throw open.length === 0
          ? operationError('NO_CASH_REGISTER_OPEN')
          : operationError('CASH_REGISTER_CLOSED');
      }
      sessionId = session.id;
    }
    await lockRow(db, 'cash_register_sessions', sessionId);
    const session = await db.cashRegisterSession.findUniqueOrThrow({ where: { id: sessionId } });
    if (session.status !== 'open') {
      throw operationError('CASH_REGISTER_CLOSED');
    }
    return session;
  }

  /** After a payment or reversal: new versions and `cash_register.updated` (after the commit). */
  async touched(db: TenantDb, sessionId: string): Promise<void> {
    const session = await db.cashRegisterSession.update({
      where: { id: sessionId },
      data: { version: { increment: 1 } },
      select: { cashRegisterId: true },
    });
    await this.registerTouched(db, session.cashRegisterId);
  }

  private async registerTouched(db: TenantDb, registerId: string): Promise<void> {
    await db.cashRegister.update({
      where: { id: registerId },
      data: { version: { increment: 1 } },
    });
    this.events.cashRegister(CashRegisterUpdated, await loadRegister(db, registerId));
  }

  private async preview(db: TenantDb, session: CashRegisterSession): Promise<ClosePreviewDto> {
    const unitId = session.unitId;
    const tabs = await db.tab.findMany({
      where: { unitId, status: { in: [...OPEN_TAB_STATUSES] } },
      orderBy: [{ businessDate: 'asc' }, { number: 'asc' }],
    });
    const summaries = await loadTabSummaries(db, tabs);
    const othersOpen = await db.cashRegisterSession.count({
      where: { unitId, status: 'open', id: { not: session.id } },
    });
    const lastOpenRegister = session.status === 'open' && othersOpen === 0;
    const items = lastOpenRegister
      ? await db.orderItem.aggregate({
          where: { unitId, canceledAt: null, stage: { isFinal: false } },
          _sum: { quantity: true },
        })
      : null;
    const event = lastOpenRegister
      ? await db.contractedEvent.findFirst({
          where: { unitId, status: 'in_progress' },
          select: { id: true, contractorName: true },
        })
      : null;
    return {
      session: await loadSession(db, session.id),
      pendingTabs: summaries.map((tab) => ({
        id: tab.id,
        number: tab.number,
        customerName: tab.customerName,
        status: tab.status,
        totalCents: tab.totalCents,
        businessDate: tab.businessDate,
        openedAt: tab.openedAt,
      })),
      pendingTabsTotalCents: summaries.reduce((sum, tab) => sum + tab.totalCents, 0),
      lastOpenRegister,
      itemsInProgress: items?._sum.quantity ?? 0,
      eventInProgress: event,
    };
  }

  /**
   * RN-04.08 (CA-04.19): items still in non-final stages go to the final stage and leave the
   * stations, one audit row per item; their orders complete and their tabs are updated.
   */
  private async finishItems(db: TenantDb, unitId: string, now: Date): Promise<void> {
    const flow = await loadUnitFlow(db, unitId);
    const leftovers = await db.orderItem.findMany({
      where: { unitId, canceledAt: null, stage: { isFinal: false } },
      include: itemInclude,
      orderBy: { id: 'asc' },
    });
    if (leftovers.length === 0) {
      return;
    }
    for (const item of leftovers) {
      await lockRow(db, 'order_items', item.id);
    }
    await db.orderItem.updateMany({
      where: { id: { in: leftovers.map((item) => item.id) } },
      data: {
        stageId: flow.final.id,
        stationId: null,
        stageEnteredAt: now,
        version: { increment: 1 },
      },
    });
    const changed = await db.orderItem.findMany({
      where: { id: { in: leftovers.map((item) => item.id) } },
      include: itemInclude,
    });
    for (const item of leftovers) {
      const after = changed.find((row) => row.id === item.id);
      if (!after) {
        continue;
      }
      await this.audit.record(db, {
        action: 'order_item.stage_changed',
        entityType: 'order_item',
        entityId: item.id,
        before: { stageId: item.stageId, stationId: item.stationId },
        after: { stageId: flow.final.id, stationId: null },
        metadata: {
          unitId,
          direction: 'forward',
          quantity: item.quantity,
          reason: 'cash_register_closed',
        },
      });
      this.events.stageChanged(
        toOrderItemDto(after, flow, now),
        { stageId: item.stageId, stationId: item.stationId },
        null,
      );
    }
    const orderIds = [...new Set(leftovers.map((item) => item.orderId))];
    const completed = await db.order.updateManyAndReturn({
      where: { id: { in: orderIds }, status: 'sent' },
      data: { status: 'completed', completedAt: now, version: { increment: 1 } },
    });
    for (const order of completed) {
      await this.audit.record(db, {
        action: 'order.completed',
        entityType: 'order',
        entityId: order.id,
        before: { status: 'sent' },
        after: { status: 'completed' },
        metadata: { unitId, tabId: order.tabId, reason: 'cash_register_closed' },
      });
      this.events.orderCompleted(order, unitId);
    }
    for (const tabId of [...new Set(leftovers.map((item) => item.tabId))]) {
      await lockRow(db, 'tabs', tabId);
      await db.tab.update({ where: { id: tabId }, data: { version: { increment: 1 } } });
      this.events.tab(TabUpdated, await loadTabSummary(db, tabId, now));
    }
  }

  /** The session locked and open, and a cash operator acting on it (RN-05.16, RN-05.21). */
  private async lockOpen(
    db: TenantDb,
    sessionId: string,
  ): Promise<{ session: CashRegisterSession; access: OperatorAccess }> {
    const found = await requireSession(db, sessionId);
    const access = await this.access.forUnit(db, found.unitId);
    assertCanOperateCash(access, CASH_FORBIDDEN);
    await lockRow(db, 'cash_register_sessions', sessionId);
    const session = await requireSession(db, sessionId);
    if (session.status !== 'open') {
      throw operationError('CASH_REGISTER_CLOSED');
    }
    return { session, access };
  }
}

function assertOwner(access: OperatorAccess): void {
  if (!isOwner(access)) {
    throw AppError.of('FORBIDDEN', { message: 'Só o dono cadastra e altera os caixas.' });
  }
}

async function requireRegister(db: TenantDb, id: string): Promise<CashRegister> {
  const register = await db.cashRegister.findUnique({ where: { id } });
  if (!register) {
    throw AppError.of('NOT_FOUND');
  }
  return register;
}

export async function requireSession(db: TenantDb, id: string): Promise<CashRegisterSession> {
  const session = await db.cashRegisterSession.findUnique({ where: { id } });
  if (!session) {
    throw AppError.of('NOT_FOUND');
  }
  return session;
}

async function assertNameFree(
  db: TenantDb,
  unitId: string,
  name: string,
  exceptId: string | null,
): Promise<void> {
  const taken = await db.cashRegister.count({
    where: {
      unitId,
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId === null ? {} : { id: { not: exceptId } }),
    },
  });
  if (taken > 0) {
    throw setupError('CASH_REGISTER_NAME_TAKEN');
  }
}

async function uniqueName<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw setupError('CASH_REGISTER_NAME_TAKEN');
    }
    throw error;
  }
}
