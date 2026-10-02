import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import type { Station } from '../generated/prisma/client.js';
import type { StationKind } from '../generated/prisma/enums.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { OperationGuard } from './operation-guard.js';
import { setupError } from './setup-errors.js';
import { SetupEvents } from './setup-events.js';
import { defaultTimeLimits, type TimeLimits, validTimeLimits } from './time-limits.js';
import { type StationDto, toStationDto } from './units.schemas.js';
import { ownersOf } from './units.service.js';

export interface CreateStationInput {
  name: string;
  kind: StationKind;
  sortOrder?: number | undefined;
  attentionAfterMinutes?: number | undefined;
  lateAfterMinutes?: number | undefined;
}

export interface UpdateStationInput {
  name?: string | undefined;
  kind?: StationKind | undefined;
  sortOrder?: number | undefined;
  active?: boolean | undefined;
  attentionAfterMinutes?: number | undefined;
  lateAfterMinutes?: number | undefined;
}

/**
 * RN-03.25: the limits of a `queue` station after a change. A counter has none; a station that
 * becomes `queue` gets the defaults of the unit; fields not sent keep their value.
 */
function limitsAfter(
  kind: StationKind,
  current: { attentionAfterMinutes: number | null; lateAfterMinutes: number | null } | null,
  input: { attentionAfterMinutes?: number | undefined; lateAfterMinutes?: number | undefined },
  unitLateAfterMinutes: number,
): TimeLimits | null {
  if (kind !== 'queue') {
    if (input.attentionAfterMinutes !== undefined || input.lateAfterMinutes !== undefined) {
      throw setupError('INVALID_TIME_LIMITS', { reason: 'counter' });
    }
    return null;
  }
  const base =
    current?.lateAfterMinutes != null && current.attentionAfterMinutes != null
      ? {
          attentionAfterMinutes: current.attentionAfterMinutes,
          lateAfterMinutes: current.lateAfterMinutes,
        }
      : defaultTimeLimits(unitLateAfterMinutes);
  const limits = {
    attentionAfterMinutes: input.attentionAfterMinutes ?? base.attentionAfterMinutes,
    lateAfterMinutes: input.lateAfterMinutes ?? base.lateAfterMinutes,
  };
  if (!validTimeLimits(limits)) {
    throw setupError('INVALID_TIME_LIMITS');
  }
  return limits;
}

/**
 * Stations of a unit (spec 03, section 4.1). Owner only. Never deleted, only deactivated.
 *
 * - RN-03.07 / CA-03.03: with an open cash register (`CASH_REGISTER_OPEN`) or items in preparation
 *   (`ITEMS_IN_PROGRESS`), stations cannot change, except their time limits, which apply at once
 *   to the cards on the screen (RN-03.25, CA-04.24).
 * - RN-03.25 / CA-03.12: `queue` stations have attention and delay limits (`INVALID_TIME_LIMITS`).
 * - RN-03.04: the unit keeps at least one active `counter` and one active `queue` station.
 * - A station the workflow (`fixed_station`), a category or a product points to stays an active
 *   `queue` station (`STATION_IN_USE`), so routing never lands on a closed screen (RN-03.06, 03.08).
 */
@Injectable()
export class StationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly guard: OperationGuard,
    private readonly events: SetupEvents,
    private readonly realtime: RealtimeService,
  ) {}

  async list(unitId: string): Promise<StationDto[]> {
    const db = this.prisma.db;
    await requireUnit(db, unitId);
    const stations = await db.station.findMany({
      where: { unitId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return stations.map(toStationDto);
  }

  async create(unitId: string, input: CreateStationInput): Promise<StationDto> {
    return this.prisma.transaction(async (db) => {
      const unit = await requireUnit(db, unitId);
      await this.guard.assertCanChangeFlow(db, unitId);
      await this.assertNameFree(db, unitId, input.name, null);
      const limits = limitsAfter(input.kind, null, input, unit.lateAfterMinutes);
      const last = await db.station.aggregate({ where: { unitId }, _max: { sortOrder: true } });
      const station = await db.station.create({
        data: {
          organizationId: requireOrganizationId(),
          unitId,
          name: input.name,
          kind: input.kind,
          sortOrder: input.sortOrder ?? (last._max.sortOrder ?? 0) + 1,
          attentionAfterMinutes: limits?.attentionAfterMinutes ?? null,
          lateAfterMinutes: limits?.lateAfterMinutes ?? null,
        },
      });
      await this.audit.record(db, {
        action: 'station.created',
        entityType: 'station',
        entityId: station.id,
        after: audited(station),
        metadata: { unitId },
      });
      await this.events.configChanged(db, unitId);
      // The owners open any station: their sockets reconnect to join the new station room.
      this.realtime.refreshAccess({ subjects: await ownersOf(db) }, 'stations_changed');
      return toStationDto(station);
    });
  }

  async update(stationId: string, input: UpdateStationInput): Promise<StationDto> {
    return this.prisma.transaction(async (db) => {
      const current = await db.station.findUnique({ where: { id: stationId } });
      if (!current) {
        throw AppError.of('NOT_FOUND');
      }
      const unitId = current.unitId;
      const onlyLimits =
        input.name === undefined &&
        input.kind === undefined &&
        input.sortOrder === undefined &&
        input.active === undefined;
      if (!onlyLimits) {
        await this.guard.assertCanChangeFlow(db, unitId);
      }
      if (input.name !== undefined && input.name.toLowerCase() !== current.name.toLowerCase()) {
        await this.assertNameFree(db, unitId, input.name, stationId);
      }
      const next = {
        kind: input.kind ?? current.kind,
        active: input.active ?? current.active,
      };
      await this.assertStillUsable(db, current, next);
      const unit = await requireUnit(db, unitId);
      const limits = limitsAfter(next.kind, current, input, unit.lateAfterMinutes);

      const station = await db.station.update({
        where: { id: stationId },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
          ...(input.active === undefined ? {} : { active: input.active }),
          attentionAfterMinutes: limits?.attentionAfterMinutes ?? null,
          lateAfterMinutes: limits?.lateAfterMinutes ?? null,
        },
      });
      await this.audit.record(db, {
        action: 'station.updated',
        entityType: 'station',
        entityId: stationId,
        before: audited(current),
        after: audited(station),
        metadata: { unitId },
      });
      await this.events.configChanged(db, unitId);
      if (station.active !== current.active || station.kind !== current.kind) {
        // Staff and owners of the unit get the rooms of the new set of stations.
        this.realtime.refreshAccess(
          { subjects: await ownersOf(db), unitIds: [unitId] },
          'stations_changed',
        );
      }
      return toStationDto(station);
    });
  }

  private async assertStillUsable(
    db: TenantDb,
    current: Station,
    next: { kind: StationKind; active: boolean },
  ): Promise<void> {
    const wasActiveQueue = current.active && current.kind === 'queue';
    const isActiveQueue = next.active && next.kind === 'queue';
    if (wasActiveQueue && !isActiveQueue) {
      const [stages, categories, products] = await Promise.all([
        db.workflowStage.count({ where: { stationId: current.id, archivedAt: null } }),
        db.category.count({ where: { defaultStationId: current.id } }),
        db.product.count({ where: { stationId: current.id } }),
      ]);
      if (stages + categories + products > 0) {
        throw setupError('STATION_IN_USE', { stages, categories, products });
      }
    }
    if (current.active && (!next.active || next.kind !== current.kind)) {
      // RN-03.04, counted as if the change were applied.
      const remaining = await db.station.groupBy({
        by: ['kind'],
        where: { unitId: current.unitId, active: true, id: { not: current.id } },
        _count: { _all: true },
      });
      const kinds = new Set(remaining.map((group) => group.kind));
      if (next.active) {
        kinds.add(next.kind);
      }
      if (!kinds.has('counter') || !kinds.has('queue')) {
        throw setupError('STATION_KIND_REQUIRED');
      }
    }
  }

  private async assertNameFree(
    db: TenantDb,
    unitId: string,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const taken = await db.station.count({
      where: {
        unitId,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId === null ? {} : { id: { not: exceptId } }),
      },
    });
    if (taken > 0) {
      throw setupError('STATION_NAME_TAKEN');
    }
  }
}

/** The unit, through the tenant client: another organization's unit is a 404 (CA-01.02). */
export async function requireUnit(db: TenantDb, unitId: string) {
  const unit = await db.unit.findUnique({ where: { id: unitId } });
  if (!unit) {
    throw AppError.of('NOT_FOUND');
  }
  return unit;
}

function audited(station: Station): Record<string, unknown> {
  return {
    name: station.name,
    kind: station.kind,
    sortOrder: station.sortOrder,
    active: station.active,
    attentionAfterMinutes: station.attentionAfterMinutes,
    lateAfterMinutes: station.lateAfterMinutes,
  };
}
