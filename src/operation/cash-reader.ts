import { isoDateOf, plainDateOf, todayInSaoPaulo } from '../common/time.js';
import { AppError } from '../errors/app-error.js';
import type { CashRegister, Prisma } from '../generated/prisma/client.js';
import type { PaymentMethod } from '../generated/prisma/enums.js';
import type { TenantDb } from '../prisma/prisma.service.js';
import { ActorNames } from './actor-names.js';
import type {
  CashMovementDto,
  CashRegisterDto,
  CashRegisterSessionDetailDto,
  CashRegisterSessionDto,
} from './cash.schemas.js';
import { loadPayments } from './operation-reader.js';
import { expectedOf, PAYMENT_METHODS } from './payment-rules.js';

/*
 * Reads of the cash registers of a unit and of their sessions (spec 05, section 5): rows → DTOs,
 * with the expected values per method computed on the server (RN-05.19).
 */

export const sessionInclude = {
  movements: { select: { type: true, amountCents: true } },
  payments: {
    select: { method: true, amountCents: true, reversedAt: true, isCreditSettlement: true },
  },
  counts: true,
  cashRegister: { select: { name: true } },
} satisfies Prisma.CashRegisterSessionInclude;

export type SessionRow = Prisma.CashRegisterSessionGetPayload<{ include: typeof sessionInclude }>;

function actorRef<T extends string>(type: T, id: string | null): { type: T; id: string | null } {
  return { type, id };
}

/** `CashRegisterSession` with the expected values per method (RN-05.19, section 5 table). */
export function toSessionDto(
  session: SessionRow,
  names: ActorNames,
  today = todayInSaoPaulo(),
): CashRegisterSessionDto {
  const { expected, cash, creditSettlements } = expectedOf(
    session,
    session.payments,
    session.movements,
  );
  const sales = expectedOf({ openingFloatCents: 0 }, session.payments, []);
  const order = (method: PaymentMethod) => PAYMENT_METHODS.indexOf(method);
  const received = session.payments
    .filter((payment) => payment.reversedAt === null)
    .reduce((sum, payment) => sum + payment.amountCents, 0);
  return {
    id: session.id,
    cashRegisterId: session.cashRegisterId,
    name: session.cashRegister.name,
    unitId: session.unitId,
    businessDate: isoDateOf(session.businessDate),
    status: session.status,
    openingFloatCents: session.openingFloatCents,
    openedBy: actorRef(session.openedByType, session.openedById),
    openedByName: names.nameOf(session.openedByType, session.openedById),
    openedAt: session.openedAt.toISOString(),
    openSinceEarlierDay:
      session.status === 'open' &&
      Temporal.PlainDate.compare(plainDateOf(session.businessDate), today) < 0,
    closedBy:
      session.closedByType === null ? null : actorRef(session.closedByType, session.closedById),
    closedAt: session.closedAt?.toISOString() ?? null,
    closingNote: session.closingNote,
    expected: PAYMENT_METHODS.map((method) => ({
      method,
      expectedCents: expected[method],
      salesCents: sales.expected[method] - creditSettlements[method],
      creditSettlementsCents: creditSettlements[method],
    })),
    cash,
    counts: [...session.counts]
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
    receivedCents: received,
    differenceCents: session.counts.reduce((sum, count) => sum + count.differenceCents, 0),
    pendingTabsCount: session.pendingTabsCount,
    pendingTabsTotalCents: session.pendingTabsTotalCents,
    version: session.version,
  };
}

async function namesOf(db: TenantDb, sessions: readonly SessionRow[]): Promise<ActorNames> {
  return ActorNames.load(
    db,
    sessions.map((session) => ({ type: session.openedByType, id: session.openedById })),
  );
}

export async function loadSession(db: TenantDb, id: string): Promise<CashRegisterSessionDto> {
  const session = await db.cashRegisterSession.findUnique({
    where: { id },
    include: sessionInclude,
  });
  if (!session) {
    throw AppError.of('NOT_FOUND');
  }
  return toSessionDto(session, await namesOf(db, [session]));
}

export async function loadSessionDetail(
  db: TenantDb,
  id: string,
): Promise<CashRegisterSessionDetailDto> {
  const session = await loadSession(db, id);
  const movements = await db.cashMovement.findMany({
    where: { cashRegisterSessionId: id },
    orderBy: { id: 'asc' },
  });
  return {
    ...session,
    movements: movements.map((movement): CashMovementDto => ({
      id: movement.id,
      cashRegisterSessionId: movement.cashRegisterSessionId,
      type: movement.type,
      amountCents: movement.amountCents,
      reason: movement.reason,
      createdBy: actorRef(movement.createdByType, movement.createdById),
      createdAt: movement.createdAt.toISOString(),
    })),
    payments: await loadPayments(db, { cashRegisterSessionId: id }),
  };
}

/**
 * Registers with the session in progress or, when closed, the last one (spec 05, section 7), and
 * the float suggested for the next opening (RN-05.23).
 */
export async function loadRegisters(
  db: TenantDb,
  where: Prisma.CashRegisterWhereInput,
): Promise<CashRegisterDto[]> {
  const registers = await db.cashRegister.findMany({
    where,
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  if (registers.length === 0) {
    return [];
  }
  // The session in progress of each register or, when closed, the latest one.
  const latest = (
    await Promise.all(
      registers.map((register) =>
        db.cashRegisterSession.findFirst({
          where: { cashRegisterId: register.id },
          orderBy: [{ status: 'asc' }, { openedAt: 'desc' }, { id: 'desc' }],
          include: sessionInclude,
        }),
      ),
    )
  ).filter((row): row is SessionRow => row !== null);
  const names = await namesOf(db, latest);
  const today = todayInSaoPaulo();
  return registers.map((register) => {
    const session = latest.find((row) => row.cashRegisterId === register.id) ?? null;
    return toRegisterDto(register, session === null ? null : toSessionDto(session, names, today));
  });
}

export function toRegisterDto(
  register: CashRegister,
  session: CashRegisterSessionDto | null,
): CashRegisterDto {
  return {
    id: register.id,
    unitId: register.unitId,
    name: register.name,
    sortOrder: register.sortOrder,
    active: register.active,
    session,
    suggestedOpeningFloatCents: session?.openingFloatCents ?? 0,
    version: register.version,
  };
}

export async function loadRegister(db: TenantDb, id: string): Promise<CashRegisterDto> {
  const [register] = await loadRegisters(db, { id });
  if (!register) {
    throw AppError.of('NOT_FOUND');
  }
  return register;
}
