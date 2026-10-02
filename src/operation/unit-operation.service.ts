import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { dateColumn, isoDateOf, plainDateOf, todayInSaoPaulo } from '../common/time.js';
import { AppError } from '../errors/app-error.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { loadUnitPricing } from '../units/effective-price-list.js';
import { OPEN_TAB_STATUSES } from '../units/operation-guard.js';
import { SetupEvents } from '../units/setup-events.js';
import { isStaleTab } from './business-day.js';
import { loadRegisters } from './cash-reader.js';
import { eventInclude, toEventDto } from './events-reader.js';
import { assertCanOperateCash, OperationAccessService } from './operation-access.js';
import { operationError } from './operation-errors.js';
import { OperationEvents } from './operation-events.js';
import { loadTabSummaries } from './operation-reader.js';
import { lockRow } from './row-lock.js';
import type { UnitOperationDto } from './unit-operation.schemas.js';

/**
 * The operation of a unit (spec 04, section 3): the snapshot of `GET /units/{id}/operation` used by
 * the start of the panel (spec 01, RN-01.24 and RN-01.28) and by the counter, the change of the
 * current price list (RN-04.31, RN-04.32) and the `unit.operation_updated` event.
 */
@Injectable()
export class UnitOperationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: OperationAccessService,
    private readonly events: OperationEvents,
    private readonly setupEvents: SetupEvents,
  ) {}

  /** `GET /units/{id}/operation`: any member of the unit. */
  async get(unitId: string): Promise<UnitOperationDto> {
    const db = this.prisma.db;
    await this.access.forUnit(db, unitId);
    return loadOperation(db, unitId);
  }

  /**
   * RN-04.31 (CA-04.07, CA-04.14): the owner and staff who operate cash change the current list,
   * with or without an open register; refused during an event (`EVENT_IN_PROGRESS`, RN-04.32).
   * Audited, and every counter reloads the prices (`unit.operation_updated`, `menu.updated`).
   */
  async setCurrentPriceList(
    unitId: string,
    input: { priceListId: string | null; version?: number | undefined },
  ): Promise<UnitOperationDto> {
    return this.prisma.transaction(async (db) => {
      assertCanOperateCash(
        await this.access.forUnit(db, unitId),
        'Só o dono ou quem opera o caixa nesta unidade troca a tabela de preço.',
      );
      await lockRow(db, 'units', unitId);
      const unit = await db.unit.findUniqueOrThrow({ where: { id: unitId } });
      if (input.version !== undefined && input.version !== unit.operationVersion) {
        throw AppError.of('VERSION_CONFLICT', {
          details: { currentVersion: unit.operationVersion },
        });
      }
      const event = await db.contractedEvent.findFirst({
        where: { unitId, status: 'in_progress' },
        select: { id: true },
      });
      if (event) {
        throw operationError('EVENT_IN_PROGRESS', { eventId: event.id });
      }
      const priceListId = input.priceListId?.toLowerCase() ?? null;
      if (priceListId !== null) {
        const list = await db.priceList.findFirst({ where: { id: priceListId, unitId } });
        if (!list?.active) {
          throw operationError('INVALID_PRICE_LIST');
        }
      }
      if (priceListId !== unit.currentPriceListId) {
        await db.unit.update({ where: { id: unitId }, data: { currentPriceListId: priceListId } });
        await this.audit.record(db, {
          action: 'unit.price_list_changed',
          entityType: 'unit',
          entityId: unitId,
          before: { currentPriceListId: unit.currentPriceListId },
          after: { currentPriceListId: priceListId },
        });
        await this.setupEvents.menuChanged(db, unitId);
      }
      return this.changed(db, unitId);
    });
  }

  /**
   * After a change of the operation (register opened or closed, current list, event, day of
   * operation): new `operation_version` and `unit.operation_updated` after the commit.
   */
  async changed(db: TenantDb, unitId: string): Promise<UnitOperationDto> {
    await db.unit.update({ where: { id: unitId }, data: { operationVersion: { increment: 1 } } });
    const operation = await loadOperation(db, unitId);
    this.events.operation(operation);
    return operation;
  }
}

/** The snapshot of the operation (spec 04, section 7). */
export async function loadOperation(db: TenantDb, unitId: string): Promise<UnitOperationDto> {
  const unit = await db.unit.findUnique({ where: { id: unitId } });
  if (!unit) {
    throw AppError.of('NOT_FOUND');
  }
  const today = todayInSaoPaulo();
  const [registers, pricing, scheduled, openTabs, itemsInProgress] = await Promise.all([
    loadRegisters(db, { unitId, active: true }),
    loadUnitPricing(db, unitId),
    db.contractedEvent.findMany({
      where: {
        unitId,
        status: 'scheduled',
        startsOn: { lte: dateColumn(today) },
        OR: [{ endsOn: { gte: dateColumn(today) } }, { endsOn: null, startsOn: dateColumn(today) }],
      },
      include: eventInclude,
      orderBy: [{ startsOn: 'asc' }, { id: 'asc' }],
    }),
    db.tab.findMany({
      where: { unitId, status: { in: [...OPEN_TAB_STATUSES] } },
      orderBy: [{ businessDate: 'asc' }, { number: 'asc' }],
    }),
    db.orderItem.aggregate({
      where: { unitId, canceledAt: null, stage: { isFinal: false } },
      _sum: { quantity: true },
    }),
  ]);
  const summaries = await loadTabSummaries(db, openTabs);
  const current = unit.businessDate === null ? null : plainDateOf(unit.businessDate);
  const eventInProgress =
    pricing.eventInProgress === null
      ? null
      : await db.contractedEvent.findUniqueOrThrow({
          where: { id: pricing.eventInProgress.id },
          include: eventInclude,
        });
  const stale =
    current === null
      ? []
      : summaries.filter((tab) => isStaleTab(Temporal.PlainDate.from(tab.businessDate), current));
  return {
    unitId,
    businessDate: unit.businessDate === null ? null : isoDateOf(unit.businessDate),
    inOperation: registers.some((register) => register.session?.status === 'open'),
    cashRegisters: registers,
    currentPriceList: pricing.current,
    effectivePriceList: pricing.effective,
    eventInProgress: eventInProgress === null ? null : toEventDto(eventInProgress),
    eventsToday: scheduled.map(toEventDto),
    openTabs: {
      count: summaries.length,
      totalCents: summaries.reduce((sum, tab) => sum + tab.totalCents, 0),
      fromEarlierDaysCount:
        current === null
          ? 0
          : summaries.filter((tab) => tab.businessDate < current.toString()).length,
    },
    staleTabs: stale.map((tab) => ({
      id: tab.id,
      number: tab.number,
      customerName: tab.customerName,
      totalCents: tab.totalCents,
      businessDate: tab.businessDate,
      openedAt: tab.openedAt,
    })),
    itemsInProgress: itemsInProgress._sum.quantity ?? 0,
    version: unit.operationVersion,
  };
}
