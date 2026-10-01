import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { updateWithVersion } from '../common/versioned-update.js';
import { requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import { type CashRegister, Prisma } from '../generated/prisma/client.js';
import type { CashMovementType, PaymentMethod } from '../generated/prisma/enums.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import type {
  CashMovementDto,
  CashRegisterDetailDto,
  CashRegisterDto,
  CloseCashRegisterRequest,
} from './cash.schemas.js';
import {
  assertCanOperateCash,
  canOperateCash,
  hasCounter,
  OperationAccessService,
} from './operation-access.js';
import { operationError } from './operation-errors.js';
import {
  CashRegisterClosed,
  CashRegisterOpened,
  CashRegisterUpdated,
  OperationEvents,
} from './operation-events.js';
import { loadPayments } from './operation-reader.js';
import { countsOf, expectedOf, PAYMENT_METHODS } from './payment-rules.js';
import { lockRow } from './row-lock.js';
import { requireShift } from './tabs.service.js';

function actorRef(type: CashRegister['openedByType'], id: string | null) {
  return { type, id };
}

/** `CashRegister` with the expected values per method (RN-05.19, section 5 table). */
export async function loadCashRegister(db: TenantDb, id: string): Promise<CashRegisterDto> {
  const register = await db.cashRegister.findUnique({
    where: { id },
    include: {
      movements: { select: { type: true, amountCents: true } },
      payments: {
        select: { method: true, amountCents: true, reversedAt: true, isCreditSettlement: true },
      },
      counts: true,
    },
  });
  if (!register) {
    throw AppError.of('NOT_FOUND');
  }
  const { expected, cash, creditSettlements } = expectedOf(
    register,
    register.payments,
    register.movements,
  );
  const sales = expectedOf({ openingFloatCents: 0 }, register.payments, []);
  const order = (method: PaymentMethod) => PAYMENT_METHODS.indexOf(method);
  return {
    id: register.id,
    shiftId: register.shiftId,
    unitId: register.unitId,
    name: register.name,
    status: register.status,
    openingFloatCents: register.openingFloatCents,
    openedBy: actorRef(register.openedByType, register.openedById),
    openedAt: register.openedAt.toISOString(),
    closedBy:
      register.closedByType === null ? null : actorRef(register.closedByType, register.closedById),
    closedAt: register.closedAt?.toISOString() ?? null,
    closingNote: register.closingNote,
    expected: PAYMENT_METHODS.map((method) => ({
      method,
      expectedCents: expected[method],
      salesCents: sales.expected[method] - creditSettlements[method],
      creditSettlementsCents: creditSettlements[method],
    })),
    cash,
    counts: [...register.counts]
      .sort((a, b) => order(a.method) - order(b.method))
      .map((count) => ({
        method: count.method,
        expectedCents: count.expectedCents,
        informedCents: count.informedCents,
        differenceCents: count.differenceCents,
        creditSettlementsCents: creditSettlements[count.method],
      })),
    creditSettlementsCents: PAYMENT_METHODS.reduce(
      (sum, method) => sum + creditSettlements[method],
      0,
    ),
    version: register.version,
  };
}

/**
 * Cash registers of a shift (spec 05, section 5): opened with a float, several at once
 * (RN-05.17), withdrawals and deposits (RN-05.18), closed with the count of each method
 * (RN-05.20) and never reopened (RN-05.21). Open, move and close: the owner and staff with
 * `can_operate_cash` (RN-05.16). The list (needed by the counter to choose the register, RN-05.05)
 * is also open to the counter.
 *
 * Lock order: tab → cash register (payments) and cash register alone (movements, closing), so a
 * register never closes in the middle of a payment.
 */
@Injectable()
export class CashRegistersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: OperationAccessService,
    private readonly events: OperationEvents,
  ) {}

  /** `GET /shifts/{id}/cash-registers`: cash operators and the counter. */
  async list(shiftId: string): Promise<CashRegisterDto[]> {
    const db = this.prisma.db;
    const shift = await requireShift(db, shiftId);
    const access = await this.access.forUnit(db, shift.unitId);
    if (!canOperateCash(access) && !hasCounter(access)) {
      throw AppError.of('FORBIDDEN', {
        message: 'Só o balcão e quem opera o caixa veem os caixas do turno.',
      });
    }
    const rows = await db.cashRegister.findMany({
      where: { shiftId },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    const registers: CashRegisterDto[] = [];
    for (const row of rows) {
      registers.push(await loadCashRegister(db, row.id));
    }
    return registers;
  }

  /** `GET /cash-registers/{id}`: movements, payments and expected (cash operators). */
  async detail(id: string): Promise<CashRegisterDetailDto> {
    const db = this.prisma.db;
    const register = await this.requireRegister(db, id);
    assertCanOperateCash(await this.access.forUnit(db, register.unitId), CASH_FORBIDDEN);
    return this.loadDetail(db, id);
  }

  /** RN-05.16, RN-05.17: opens a register in the open shift, named "Caixa N" by default. */
  async open(
    shiftId: string,
    input: { name?: string | undefined; openingFloatCents: number },
  ): Promise<CashRegisterDto> {
    return this.prisma.transaction(async (db) => {
      const found = await requireShift(db, shiftId);
      const access = await this.access.forUnit(db, found.unitId);
      assertCanOperateCash(access, CASH_FORBIDDEN);
      // Same lock as closing the shift (RN-04.07): a register never opens in a closing shift.
      await lockRow(db, 'shifts', shiftId);
      const shift = await requireShift(db, shiftId);
      if (shift.status !== 'open') {
        throw operationError('SHIFT_CLOSED');
      }
      const existing = await db.cashRegister.findMany({
        where: { shiftId },
        select: { name: true },
      });
      const taken = new Set(existing.map((row) => row.name.toLocaleLowerCase('pt-BR')));
      let name = input.name;
      if (name === undefined) {
        let index = existing.length + 1;
        while (taken.has(`caixa ${index}`)) {
          index++;
        }
        name = `Caixa ${index}`;
      } else if (taken.has(name.toLocaleLowerCase('pt-BR'))) {
        throw operationError('CASH_REGISTER_NAME_TAKEN');
      }
      let register: CashRegister;
      try {
        register = await db.cashRegister.create({
          data: {
            organizationId: requireOrganizationId(),
            shiftId,
            unitId: shift.unitId,
            name,
            status: 'open',
            openingFloatCents: input.openingFloatCents,
            openedByType: access.actor.type,
            openedById: access.actor.id,
            openedAt: new Date(),
          },
        });
      } catch (error) {
        // Unique (shift_id, lower(name)).
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw operationError('CASH_REGISTER_NAME_TAKEN');
        }
        throw error;
      }
      await this.audit.record(db, {
        action: 'cash_register.opened',
        entityType: 'cash_register',
        entityId: register.id,
        after: { name, openingFloatCents: input.openingFloatCents },
        metadata: { shiftId, unitId: shift.unitId },
      });
      const dto = await loadCashRegister(db, register.id);
      this.events.cashRegister(CashRegisterOpened, dto);
      return dto;
    });
  }

  /** RN-05.18: withdrawal (sangria) or deposit (suprimento), with a reason. */
  async move(
    id: string,
    input: {
      type: CashMovementType;
      amountCents: number;
      reason: string;
      version?: number | undefined;
    },
  ): Promise<CashRegisterDetailDto> {
    return this.prisma.transaction(async (db) => {
      const { register, access } = await this.lockOpen(db, id);
      const before = await loadCashRegister(db, id);
      const cashExpected = before.expected.find((row) => row.method === 'cash')?.expectedCents ?? 0;
      if (input.type === 'withdrawal' && input.amountCents > cashExpected) {
        throw operationError('WITHDRAWAL_EXCEEDS_CASH', {
          expectedCashCents: cashExpected,
          amountCents: input.amountCents,
        });
      }
      await updateWithVersion<CashRegister>(db.cashRegister, {
        where: { id },
        expectedVersion: input.version ?? register.version,
        data: {},
      });
      const movement = await db.cashMovement.create({
        data: {
          organizationId: requireOrganizationId(),
          cashRegisterId: id,
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
        metadata: { cashRegisterId: id, shiftId: register.shiftId, unitId: register.unitId },
      });
      const dto = await this.loadDetail(db, id);
      this.events.cashRegister(CashRegisterUpdated, dto);
      return dto;
    });
  }

  /**
   * RN-05.20, CA-05.07: closes with the informed value of each method; differences are stored, and
   * any non-zero difference needs a note. RN-05.21: closed for good.
   */
  async close(id: string, input: CloseCashRegisterRequest): Promise<CashRegisterDto> {
    return this.prisma.transaction(async (db) => {
      const { register, access } = await this.lockOpen(db, id);
      const current = await loadCashRegister(db, id);
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
      const now = new Date();
      await updateWithVersion<CashRegister>(db.cashRegister, {
        where: { id },
        expectedVersion: input.version ?? register.version,
        data: {
          status: 'closed',
          closedAt: now,
          closedByType: access.actor.type,
          closedById: access.actor.id,
          closingNote: note,
        },
      });
      const organizationId = requireOrganizationId();
      await db.cashRegisterCount.createMany({
        data: counts.map((count) => ({ organizationId, cashRegisterId: id, ...count })),
      });
      await this.audit.record(db, {
        action: 'cash_register.closed',
        entityType: 'cash_register',
        entityId: id,
        before: { status: 'open' },
        after: { status: 'closed', counts, closingNote: note },
        metadata: { shiftId: register.shiftId, unitId: register.unitId },
      });
      const dto = await loadCashRegister(db, id);
      this.events.cashRegister(CashRegisterClosed, dto);
      return dto;
    });
  }

  /**
   * RN-05.05, RN-05.06: the register that receives a payment of `shiftId`, locked. With an id, it
   * must be of the shift and open; without one, the only open register of the shift.
   */
  async forPayment(
    db: TenantDb,
    shiftId: string,
    cashRegisterId: string | undefined,
  ): Promise<CashRegister> {
    let id = cashRegisterId?.toLowerCase();
    if (id === undefined) {
      const open = await db.cashRegister.findMany({
        where: { shiftId, status: 'open' },
        orderBy: { id: 'asc' },
        select: { id: true, name: true },
      });
      const [only] = open;
      if (!only) {
        throw operationError('NO_CASH_REGISTER_OPEN');
      }
      if (open.length > 1) {
        throw operationError('CASH_REGISTER_REQUIRED', { cashRegisters: open });
      }
      id = only.id;
    }
    if (!(await lockRow(db, 'cash_registers', id))) {
      throw operationError('INVALID_CASH_REGISTER');
    }
    const register = await db.cashRegister.findUniqueOrThrow({ where: { id } });
    if (register.shiftId !== shiftId) {
      throw operationError('INVALID_CASH_REGISTER');
    }
    if (register.status !== 'open') {
      throw operationError('CASH_REGISTER_CLOSED');
    }
    return register;
  }

  /** After a payment or reversal: new version and `cash_register.updated` (after the commit). */
  async touched(db: TenantDb, id: string): Promise<void> {
    await db.cashRegister.update({ where: { id }, data: { version: { increment: 1 } } });
    this.events.cashRegister(CashRegisterUpdated, await loadCashRegister(db, id));
  }

  private async loadDetail(db: TenantDb, id: string): Promise<CashRegisterDetailDto> {
    const register = await loadCashRegister(db, id);
    const movements = await db.cashMovement.findMany({
      where: { cashRegisterId: id },
      orderBy: { id: 'asc' },
    });
    return {
      ...register,
      movements: movements.map((movement): CashMovementDto => ({
        id: movement.id,
        cashRegisterId: movement.cashRegisterId,
        type: movement.type,
        amountCents: movement.amountCents,
        reason: movement.reason,
        createdBy: actorRef(movement.createdByType, movement.createdById),
        createdAt: movement.createdAt.toISOString(),
      })),
      payments: await loadPayments(db, { cashRegisterId: id }),
    };
  }

  private async requireRegister(db: TenantDb, id: string): Promise<CashRegister> {
    const register = await db.cashRegister.findUnique({ where: { id } });
    if (!register) {
      throw AppError.of('NOT_FOUND');
    }
    return register;
  }

  /** The register locked, open, and a cash operator acting on it (RN-05.16, RN-05.21). */
  private async lockOpen(db: TenantDb, id: string) {
    const found = await this.requireRegister(db, id);
    const access = await this.access.forUnit(db, found.unitId);
    assertCanOperateCash(access, CASH_FORBIDDEN);
    await lockRow(db, 'cash_registers', id);
    const register = await this.requireRegister(db, id);
    if (register.status !== 'open') {
      throw operationError('CASH_REGISTER_CLOSED');
    }
    return { register, access };
  }
}

const CASH_FORBIDDEN = 'Só o dono ou quem opera o caixa nesta unidade pode mexer nos caixas.';
