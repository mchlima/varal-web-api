import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { dateColumn } from '../common/time.js';
import { updateWithVersion } from '../common/versioned-update.js';
import { requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import { type ContractedEvent, Prisma } from '../generated/prisma/client.js';
import type { ContractedEventStatus } from '../generated/prisma/enums.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { SetupEvents } from '../units/setup-events.js';
import type {
  ContractedEventDto,
  ContractedEventListQuery,
  CreateContractedEventRequest,
  UpdateContractedEventRequest,
} from './events.schemas.js';
import { eventInclude, loadEvent, toEventDto } from './events-reader.js';
import {
  assertCanOperateCash,
  isOwner,
  OperationAccessService,
  type OperatorAccess,
} from './operation-access.js';
import { operationError } from './operation-errors.js';
import { OperationEvents } from './operation-events.js';
import { lockRow } from './row-lock.js';
import { UnitOperationService } from './unit-operation.service.js';

type Actor = OperatorAccess['actor'];

/**
 * Starts a scheduled event (RN-04.34, RN-04.35): one in progress per unit
 * (`EVENT_ALREADY_IN_PROGRESS`, CA-04.15). Call it in a transaction that locked the unit row.
 * Returns the event; the caller emits `event.updated` and `unit.operation_updated`.
 */
export async function startEvent(
  db: TenantDb,
  audit: AuditService,
  event: ContractedEvent,
  actor: Actor,
): Promise<ContractedEventDto> {
  if (event.status !== 'scheduled') {
    throw operationError(
      event.status === 'in_progress' ? 'EVENT_ALREADY_IN_PROGRESS' : 'EVENT_NOT_SCHEDULED',
      { eventId: event.id },
    );
  }
  const other = await db.contractedEvent.findFirst({
    where: { unitId: event.unitId, status: 'in_progress' },
    select: { id: true },
  });
  if (other) {
    throw operationError('EVENT_ALREADY_IN_PROGRESS', { eventId: other.id });
  }
  try {
    await db.contractedEvent.update({
      where: { id: event.id },
      data: {
        status: 'in_progress',
        startedAt: new Date(),
        startedByType: actor.type,
        startedById: actor.id,
        version: { increment: 1 },
      },
    });
  } catch (error) {
    // Unique index of the event in progress of the unit, if a race got past the unit lock.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw operationError('EVENT_ALREADY_IN_PROGRESS');
    }
    throw error;
  }
  await audit.record(db, {
    action: 'event.started',
    entityType: 'contracted_event',
    entityId: event.id,
    before: { status: 'scheduled' },
    after: { status: 'in_progress' },
    metadata: { unitId: event.unitId },
  });
  return loadEvent(db, event.id);
}

/** Finishes an event in progress (RN-04.34): new tabs stop pointing to it (RN-04.36). */
export async function finishEvent(
  db: TenantDb,
  audit: AuditService,
  event: ContractedEvent,
  actor: Actor,
): Promise<ContractedEventDto> {
  if (event.status !== 'in_progress') {
    throw operationError('EVENT_NOT_IN_PROGRESS', { eventId: event.id });
  }
  await db.contractedEvent.update({
    where: { id: event.id },
    data: {
      status: 'finished',
      finishedAt: new Date(),
      finishedByType: actor.type,
      finishedById: actor.id,
      version: { increment: 1 },
    },
  });
  await audit.record(db, {
    action: 'event.finished',
    entityType: 'contracted_event',
    entityId: event.id,
    before: { status: 'in_progress' },
    after: { status: 'finished' },
    metadata: { unitId: event.unitId },
  });
  return loadEvent(db, event.id);
}

/**
 * Contracted events (spec 04, section 3.3). The owner registers, edits and cancels; the owner and
 * staff who operate cash start and finish (RN-04.34) and read the events of the unit.
 */
@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: OperationAccessService,
    private readonly events: OperationEvents,
    private readonly operation: UnitOperationService,
    private readonly setupEvents: SetupEvents,
  ) {}

  /** `GET /units/{id}/events?status=&from=&to=`: in progress, then by date. */
  async list(unitId: string, query: ContractedEventListQuery): Promise<ContractedEventDto[]> {
    const db = this.prisma.db;
    assertCanOperateCash(await this.access.forUnit(db, unitId), READ_FORBIDDEN);
    const statuses = query.status?.split(',') as ContractedEventStatus[] | undefined;
    const rows = await db.contractedEvent.findMany({
      where: {
        unitId,
        ...(statuses === undefined ? {} : { status: { in: [...new Set(statuses)] } }),
        ...(query.to === undefined ? {} : { startsOn: { lte: dateColumn(query.to) } }),
        ...(query.from === undefined
          ? {}
          : {
              OR: [
                { endsOn: { gte: dateColumn(query.from) } },
                { endsOn: null, startsOn: { gte: dateColumn(query.from) } },
              ],
            }),
      },
      include: eventInclude,
      orderBy: [{ startsOn: 'asc' }, { id: 'asc' }],
    });
    const rank = (status: ContractedEventStatus) =>
      status === 'in_progress' ? 0 : status === 'scheduled' ? 1 : 2;
    return rows
      .map(toEventDto)
      .sort(
        (a, b) =>
          rank(a.status) - rank(b.status) ||
          (a.status === 'scheduled'
            ? a.startsOn.localeCompare(b.startsOn)
            : b.startsOn.localeCompare(a.startsOn)),
      );
  }

  async get(id: string): Promise<ContractedEventDto> {
    const db = this.prisma.db;
    const event = await requireEvent(db, id);
    assertCanOperateCash(await this.access.forUnit(db, event.unitId), READ_FORBIDDEN);
    return loadEvent(db, id);
  }

  /** RN-04.05: contractor, dates, agreement and an optional active list of the unit. */
  async create(unitId: string, input: CreateContractedEventRequest): Promise<ContractedEventDto> {
    return this.prisma.transaction(async (db) => {
      assertOwner(await this.access.forUnit(db, unitId));
      const priceListId = await this.checkPriceList(db, unitId, input.priceListId ?? null);
      const event = await db.contractedEvent.create({
        data: {
          organizationId: requireOrganizationId(),
          unitId,
          contractorName: input.contractorName,
          startsOn: dateColumn(input.startsOn),
          endsOn: input.endsOn == null ? null : dateColumn(input.endsOn),
          priceListId,
          modality: input.modality,
          agreedAmountCents: input.agreedAmountCents ?? null,
          agreedQuantity: input.agreedQuantity ?? null,
          limits: emptyToNull(input.limits),
          notes: emptyToNull(input.notes),
        },
      });
      await this.audit.record(db, {
        action: 'event.created',
        entityType: 'contracted_event',
        entityId: event.id,
        after: audited(event),
        metadata: { unitId },
      });
      const dto = await loadEvent(db, event.id);
      this.events.contractedEvent(dto);
      return dto;
    });
  }

  /**
   * RN-04.37: agreement and list change until the event is finished; a new list of an event in
   * progress applies to new items (the counters reload the prices).
   */
  async update(id: string, input: UpdateContractedEventRequest): Promise<ContractedEventDto> {
    return this.prisma.transaction(async (db) => {
      const found = await requireEvent(db, id);
      assertOwner(await this.access.forUnit(db, found.unitId));
      await lockRow(db, 'units', found.unitId);
      const current = await requireEvent(db, id);
      if (current.status === 'finished' || current.status === 'canceled') {
        throw operationError('EVENT_CLOSED');
      }
      const startsOn = input.startsOn ?? isoOf(current.startsOn);
      const endsOn =
        input.endsOn === undefined ? current.endsOn && isoOf(current.endsOn) : input.endsOn;
      if (endsOn !== null && endsOn < startsOn) {
        throw AppError.of('VALIDATION_FAILED', {
          details: {
            fields: [
              {
                path: 'endsOn',
                message: 'A data final precisa ser igual ou depois da data do evento.',
              },
            ],
          },
        });
      }
      const priceListId =
        input.priceListId === undefined
          ? current.priceListId
          : await this.checkPriceList(db, current.unitId, input.priceListId);
      const updated = await updateWithVersion<ContractedEvent>(db.contractedEvent, {
        where: { id },
        expectedVersion: input.version ?? current.version,
        data: {
          ...(input.contractorName === undefined ? {} : { contractorName: input.contractorName }),
          startsOn: dateColumn(startsOn),
          endsOn: endsOn === null ? null : dateColumn(endsOn),
          priceListId,
          ...(input.modality === undefined ? {} : { modality: input.modality }),
          ...(input.agreedAmountCents === undefined
            ? {}
            : { agreedAmountCents: input.agreedAmountCents }),
          ...(input.agreedQuantity === undefined ? {} : { agreedQuantity: input.agreedQuantity }),
          ...(input.limits === undefined ? {} : { limits: emptyToNull(input.limits) }),
          ...(input.notes === undefined ? {} : { notes: emptyToNull(input.notes) }),
        },
      });
      await this.audit.record(db, {
        action: 'event.updated',
        entityType: 'contracted_event',
        entityId: id,
        before: audited(current),
        after: audited(updated),
        metadata: { unitId: current.unitId },
      });
      const dto = await loadEvent(db, id);
      this.events.contractedEvent(dto);
      if (current.status === 'in_progress' && current.priceListId !== priceListId) {
        await this.setupEvents.menuChanged(db, current.unitId);
        await this.operation.changed(db, current.unitId);
      }
      return dto;
    });
  }

  /** RN-04.34, RN-04.35 (CA-04.14, CA-04.15): owner and cash operators; no register needed. */
  async start(id: string, version?: number): Promise<ContractedEventDto> {
    return this.transition(id, version, async (db, event, actor) =>
      startEvent(db, this.audit, event, actor),
    );
  }

  /** RN-04.34: new tabs stop pointing to the event and the current list of the unit applies again. */
  async finish(id: string, version?: number): Promise<ContractedEventDto> {
    return this.transition(id, version, async (db, event, actor) =>
      finishEvent(db, this.audit, event, actor),
    );
  }

  /** RN-04.34: only a scheduled event is canceled, by the owner; it never comes back. */
  async cancel(id: string, version?: number): Promise<ContractedEventDto> {
    return this.prisma.transaction(async (db) => {
      const found = await requireEvent(db, id);
      assertOwner(await this.access.forUnit(db, found.unitId));
      await lockRow(db, 'units', found.unitId);
      const event = await requireEvent(db, id);
      if (event.status !== 'scheduled') {
        throw operationError('EVENT_NOT_SCHEDULED');
      }
      await updateWithVersion<ContractedEvent>(db.contractedEvent, {
        where: { id },
        expectedVersion: version ?? event.version,
        data: { status: 'canceled', canceledAt: new Date() },
      });
      await this.audit.record(db, {
        action: 'event.canceled',
        entityType: 'contracted_event',
        entityId: id,
        before: { status: 'scheduled' },
        after: { status: 'canceled' },
        metadata: { unitId: event.unitId },
      });
      const dto = await loadEvent(db, id);
      this.events.contractedEvent(dto);
      return dto;
    });
  }

  private async transition(
    id: string,
    version: number | undefined,
    apply: (db: TenantDb, event: ContractedEvent, actor: Actor) => Promise<ContractedEventDto>,
  ): Promise<ContractedEventDto> {
    return this.prisma.transaction(async (db) => {
      const found = await requireEvent(db, id);
      const access = await this.access.forUnit(db, found.unitId);
      assertCanOperateCash(access, 'Só o dono ou quem opera o caixa inicia e encerra eventos.');
      // Same lock as opening a register and changing the current list.
      await lockRow(db, 'units', found.unitId);
      const event = await requireEvent(db, id);
      if (version !== undefined && version !== event.version) {
        throw AppError.of('VERSION_CONFLICT', { details: { currentVersion: event.version } });
      }
      const dto = await apply(db, event, access.actor);
      this.events.contractedEvent(dto);
      // RN-04.32: the effective list of the unit changes with the event.
      await this.setupEvents.menuChanged(db, event.unitId);
      await this.operation.changed(db, event.unitId);
      return dto;
    });
  }

  /** RN-04.05: an active list of the same unit (`INVALID_PRICE_LIST`), or none ("Normal"). */
  private async checkPriceList(
    db: TenantDb,
    unitId: string,
    priceListId: string | null,
  ): Promise<string | null> {
    if (priceListId === null) {
      return null;
    }
    const list = await db.priceList.findFirst({
      where: { id: priceListId.toLowerCase(), unitId },
    });
    if (!list?.active) {
      throw operationError('INVALID_PRICE_LIST');
    }
    return list.id;
  }
}

const READ_FORBIDDEN = 'Só o dono ou quem opera o caixa nesta unidade vê os eventos.';

function assertOwner(access: OperatorAccess): void {
  if (!isOwner(access)) {
    throw AppError.of('FORBIDDEN', { message: 'Só o dono cadastra, altera e cancela eventos.' });
  }
}

async function requireEvent(db: TenantDb, id: string): Promise<ContractedEvent> {
  const event = await db.contractedEvent.findUnique({ where: { id } });
  if (!event) {
    throw AppError.of('NOT_FOUND');
  }
  return event;
}

function isoOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

function audited(event: ContractedEvent): Record<string, unknown> {
  return {
    startsOn: isoOf(event.startsOn),
    endsOn: event.endsOn === null ? null : isoOf(event.endsOn),
    priceListId: event.priceListId,
    modality: event.modality,
    agreedAmountCents: event.agreedAmountCents,
    agreedQuantity: event.agreedQuantity,
    hasLimits: event.limits !== null,
    hasNotes: event.notes !== null,
  };
}
