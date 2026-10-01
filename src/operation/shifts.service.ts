import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { assertCanOpenShift } from '../common/subscription.js';
import { updateWithVersion } from '../common/versioned-update.js';
import { requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import { Prisma, type Shift } from '../generated/prisma/client.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { assertCanOperateCash, OperationAccessService } from './operation-access.js';
import { operationError } from './operation-errors.js';
import { OperationEvents, ShiftClosed, ShiftOpened, ShiftUpdated } from './operation-events.js';
import { loadShift, loadUnitFlow, shiftInclude, toShiftDto } from './operation-reader.js';
import type { OpenShiftRequest, ShiftDto, ShiftPendingItems } from './operation.schemas.js';
import { lockRow } from './row-lock.js';

/**
 * Shifts (spec 04, section 3): open with type, agreement and prices; one open shift per unit
 * (RN-04.01); close only without pending tabs (RN-04.07). Open and close: the owner and staff who
 * operate cash in the unit (RN-04.02).
 */
@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: OperationAccessService,
    private readonly events: OperationEvents,
  ) {}

  /** RN-04.01 to RN-04.06; CA-04.01, CA-02.05. */
  async open(unitId: string, input: OpenShiftRequest): Promise<ShiftDto> {
    return this.prisma.transaction(async (db) => {
      const access = await this.access.forUnit(db, unitId);
      assertCanOperateCash(access);
      // Serializes with other openings and with the setup of the unit (RN-03.07), which checks for
      // an open shift under the same lock.
      await lockRow(db, 'units', unitId);
      const organization = await db.organization.findUniqueOrThrow({
        where: { id: requireOrganizationId() },
        select: { subscriptionStatus: true },
      });
      // RN-04.03, RN-01.01, RN-02.12 (CA-02.05).
      assertCanOpenShift(organization.subscriptionStatus);
      const unit = await db.unit.findUniqueOrThrow({ where: { id: unitId } });
      if (!unit.active) {
        throw operationError('UNIT_INACTIVE');
      }
      const existing = await db.shift.findFirst({ where: { unitId, status: 'open' } });
      if (existing) {
        throw operationError('SHIFT_ALREADY_OPEN', { shiftId: existing.id });
      }
      await this.assertPriceProducts(db, unitId, input.prices);
      // The workflow must exist before items can be routed (RN-04.19).
      await loadUnitFlow(db, unitId);

      let shift: Shift;
      try {
        shift = await db.shift.create({
          data: {
            organizationId: requireOrganizationId(),
            unitId,
            type: input.type,
            status: 'open',
            openedByType: access.actor.type,
            openedById: access.actor.id,
            openedAt: new Date(),
          },
        });
      } catch (error) {
        // Partial unique index `shifts_unit_id_open_key` (CA-04.01), if a race got past the lock.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw operationError('SHIFT_ALREADY_OPEN');
        }
        throw error;
      }
      if (input.agreement) {
        const agreement = input.agreement;
        await db.shiftAgreement.create({
          data: {
            organizationId: requireOrganizationId(),
            shiftId: shift.id,
            contractorName: agreement.contractorName,
            modality: agreement.modality,
            agreedAmountCents: agreement.agreedAmountCents ?? null,
            agreedQuantity: agreement.agreedQuantity ?? null,
            limits: emptyToNull(agreement.limits),
            notes: emptyToNull(agreement.notes),
          },
        });
      }
      await this.writePrices(db, shift.id, input.prices);
      const dto = await loadShift(db, shift.id);
      await this.audit.record(db, {
        action: 'shift.opened',
        entityType: 'shift',
        entityId: shift.id,
        after: { type: dto.type, agreement: dto.agreement, prices: dto.prices },
        metadata: { unitId },
      });
      this.events.shift(ShiftOpened, dto);
      return dto;
    });
  }

  /** `GET /units/{id}/shifts/current`: any member of the unit. */
  async current(unitId: string): Promise<ShiftDto | null> {
    const db = this.prisma.db;
    await this.access.forUnit(db, unitId);
    const shift = await db.shift.findFirst({
      where: { unitId, status: 'open' },
      include: shiftInclude,
    });
    return shift ? toShiftDto(shift) : null;
  }

  /** RN-04.06: replaces the price table while the shift is open. */
  async updatePrices(
    shiftId: string,
    input: { prices: { productId: string; priceCents: number }[]; version?: number | undefined },
  ): Promise<ShiftDto> {
    return this.prisma.transaction(async (db) => {
      const current = await this.requireShift(db, shiftId);
      assertCanOperateCash(await this.access.forUnit(db, current.unitId));
      if (current.status !== 'open') {
        throw operationError('SHIFT_CLOSED');
      }
      await this.assertPriceProducts(db, current.unitId, input.prices);
      const before = await loadShift(db, shiftId);
      await updateWithVersion<Shift>(db.shift, {
        where: { id: shiftId },
        expectedVersion: input.version ?? current.version,
        data: {},
      });
      await db.shiftPrice.deleteMany({ where: { shiftId } });
      await this.writePrices(db, shiftId, input.prices);
      const dto = await loadShift(db, shiftId);
      await this.audit.record(db, {
        action: 'shift.prices_updated',
        entityType: 'shift',
        entityId: shiftId,
        before: { prices: before.prices },
        after: { prices: dto.prices },
        metadata: { unitId: dto.unitId },
      });
      this.events.shift(ShiftUpdated, dto);
      return dto;
    });
  }

  /**
   * RN-04.07, CA-04.09: refused with the list of pending tabs and open cash registers. RN-04.08: items still in non-final stages go to the final stage, audited.
   * RN-01.01: a suspended organization can still close its open shifts.
   */
  async close(shiftId: string): Promise<ShiftDto> {
    return this.prisma.transaction(async (db) => {
      const found = await this.requireShift(db, shiftId);
      const access = await this.access.forUnit(db, found.unitId);
      assertCanOperateCash(access);
      // Serializes with new tabs (they increment `next_tab_number` on this row).
      await lockRow(db, 'shifts', shiftId);
      const shift = await this.requireShift(db, shiftId);
      if (shift.status !== 'open') {
        throw operationError('SHIFT_CLOSED');
      }
      const pending = await this.pendingItems(db, shiftId);
      if (pending.tabs.length > 0 || pending.cashRegisters.length > 0) {
        throw operationError('SHIFT_HAS_PENDING_ITEMS', { ...pending });
      }

      const now = new Date();
      const flow = await loadUnitFlow(db, shift.unitId);
      const leftovers = await db.orderItem.findMany({
        where: { tab: { shiftId }, canceledAt: null, stage: { isFinal: false } },
        select: { id: true, stageId: true },
      });
      if (leftovers.length > 0) {
        await db.orderItem.updateMany({
          where: { id: { in: leftovers.map((item) => item.id) } },
          data: {
            stageId: flow.final.id,
            stationId: null,
            stageEnteredAt: now,
            version: { increment: 1 },
          },
        });
        await db.order.updateMany({
          where: { shiftId, status: 'sent' },
          data: { status: 'completed', completedAt: now, version: { increment: 1 } },
        });
        await this.audit.record(db, {
          action: 'shift.items_finalized',
          entityType: 'shift',
          entityId: shiftId,
          metadata: {
            unitId: shift.unitId,
            finalStageId: flow.final.id,
            items: leftovers.map((item) => ({ id: item.id, fromStageId: item.stageId })),
          },
        });
      }

      await db.shift.update({
        where: { id: shiftId },
        data: {
          status: 'closed',
          closedAt: now,
          closedByType: access.actor.type,
          closedById: access.actor.id,
          version: { increment: 1 },
        },
      });
      const dto = await loadShift(db, shiftId);
      await this.audit.record(db, {
        action: 'shift.closed',
        entityType: 'shift',
        entityId: shiftId,
        before: { status: 'open' },
        after: { status: 'closed', closedAt: dto.closedAt },
        metadata: { unitId: shift.unitId },
      });
      this.events.shift(ShiftClosed, dto);
      return dto;
    });
  }

  /**
   * What keeps the shift open (RN-04.07): tabs in `open` or `closing` and cash registers still
   * open (spec 05). Registers open under the same shift lock, so none slips in meanwhile.
   */
  async pendingItems(db: TenantDb, shiftId: string): Promise<ShiftPendingItems> {
    const tabs = await db.tab.findMany({
      where: { shiftId, status: { in: ['open', 'closing'] } },
      orderBy: { number: 'asc' },
      select: { id: true, number: true, customerName: true, status: true },
    });
    const cashRegisters = await db.cashRegister.findMany({
      where: { shiftId, status: 'open' },
      orderBy: { id: 'asc' },
      select: { id: true, name: true },
    });
    return { tabs, cashRegisters };
  }

  private async requireShift(db: TenantDb, shiftId: string): Promise<Shift> {
    const shift = await db.shift.findUnique({ where: { id: shiftId } });
    if (!shift) {
      throw AppError.of('NOT_FOUND');
    }
    return shift;
  }

  /** RN-04.06: products of the price table are products of the unit of the shift. */
  private async assertPriceProducts(
    db: TenantDb,
    unitId: string,
    prices: readonly { productId: string }[],
  ): Promise<void> {
    const ids = [...new Set(prices.map((price) => price.productId.toLowerCase()))];
    if (ids.length === 0) {
      return;
    }
    const found = await db.product.findMany({
      where: { id: { in: ids }, unitId },
      select: { id: true },
    });
    const known = new Set(found.map((product) => product.id));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw operationError('INVALID_SHIFT_PRICE', { productIds: missing });
    }
  }

  private async writePrices(
    db: TenantDb,
    shiftId: string,
    prices: readonly { productId: string; priceCents: number }[],
  ): Promise<void> {
    if (prices.length === 0) {
      return;
    }
    const organizationId = requireOrganizationId();
    await db.shiftPrice.createMany({
      data: prices.map((price) => ({
        organizationId,
        shiftId,
        productId: price.productId.toLowerCase(),
        priceCents: price.priceCents,
      })),
    });
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}
