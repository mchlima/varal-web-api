import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { type Page, type PaginationQuery, pageArgs, toPage } from '../common/pagination.js';
import { updateWithVersion } from '../common/versioned-update.js';
import { requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import type { Unit } from '../generated/prisma/client.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { OpenShiftChecker } from './open-shift.js';
import { setupError } from './setup-errors.js';
import { SetupEvents } from './setup-events.js';
import { UnitTemplateService } from './unit-template.service.js';
import { toUnitDto, type UnitDto } from './units.schemas.js';

export interface CreateUnitInput {
  name: string;
  lateAfterMinutes: number;
}

export interface UpdateUnitInput {
  name?: string | undefined;
  active?: boolean | undefined;
  lateAfterMinutes?: number | undefined;
  version?: number | undefined;
}

/** Owners and staff with a permission in the unit: the subjects whose rooms change with it. */
export async function subjectsOfUnit(
  db: TenantDb,
  unitId: string,
): Promise<{ type: 'owner' | 'staff'; id: string }[]> {
  const [owners, permissions] = await Promise.all([
    db.user.findMany({ where: { active: true }, select: { id: true } }),
    db.staffUnitPermission.findMany({ where: { unitId }, select: { staffMemberId: true } }),
  ]);
  return [
    ...owners.map((owner) => ({ type: 'owner' as const, id: owner.id })),
    ...permissions.map((permission) => ({ type: 'staff' as const, id: permission.staffMemberId })),
  ];
}

/** Active owners of the organization (they are in every unit and station room). */
export async function ownersOf(db: TenantDb): Promise<{ type: 'owner'; id: string }[]> {
  const owners = await db.user.findMany({ where: { active: true }, select: { id: true } });
  return owners.map((owner) => ({ type: 'owner' as const, id: owner.id }));
}

/** Units of the organization (spec 03, section 3). Owner only. */
@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly template: UnitTemplateService,
    private readonly shifts: OpenShiftChecker,
    private readonly events: SetupEvents,
    private readonly realtime: RealtimeService,
  ) {}

  async list(query: PaginationQuery): Promise<Page<UnitDto>> {
    const args = pageArgs(query);
    const rows = await this.prisma.db.unit.findMany(args);
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toUnitDto), nextCursor: page.nextCursor };
  }

  /**
   * RN-03.03: a new unit is born with the default stations and workflow (CA-03.01) and an empty
   * menu, in the same transaction.
   */
  async create(input: CreateUnitInput): Promise<UnitDto> {
    return this.prisma.transaction(async (db) => {
      await this.assertNameFree(db, input.name, null);
      const unit = await db.unit.create({
        data: {
          organizationId: requireOrganizationId(),
          name: input.name,
          lateAfterMinutes: input.lateAfterMinutes,
        },
      });
      await this.audit.record(db, {
        action: 'unit.created',
        entityType: 'unit',
        entityId: unit.id,
        after: auditedUnit(unit),
      });
      await this.template.applyDefaultTemplate(db, {
        organizationId: unit.organizationId,
        unitId: unit.id,
      });
      // The owners' sockets join the rooms of the new unit and its stations.
      this.realtime.refreshAccess({ subjects: await ownersOf(db) }, 'unit_changed');
      return toUnitDto(unit);
    });
  }

  /**
   * Renames, (de)activates and sets `late_after_minutes`. RN-03.02: a unit with an open shift is
   * not deactivated; RN-03.01: the last active unit is not deactivated.
   */
  async update(unitId: string, input: UpdateUnitInput): Promise<UnitDto> {
    return this.prisma.transaction(async (db) => {
      const current = await db.unit.findUnique({ where: { id: unitId } });
      if (!current) {
        throw AppError.of('NOT_FOUND');
      }
      const deactivating = input.active === false && current.active;
      if (deactivating) {
        await this.shifts.assertNoOpenShift(db, unitId);
        const others = await db.unit.count({ where: { active: true, id: { not: unitId } } });
        if (others === 0) {
          throw setupError('LAST_ACTIVE_UNIT');
        }
      }
      if (input.name !== undefined && input.name !== current.name) {
        await this.assertNameFree(db, input.name, unitId);
      }
      const updated = await updateWithVersion<Unit>(db.unit, {
        where: { id: unitId },
        expectedVersion: input.version ?? current.version,
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.active === undefined ? {} : { active: input.active }),
          ...(input.lateAfterMinutes === undefined
            ? {}
            : { lateAfterMinutes: input.lateAfterMinutes }),
        },
      });
      await this.audit.record(db, {
        action: 'unit.updated',
        entityType: 'unit',
        entityId: unitId,
        before: auditedUnit(current),
        after: auditedUnit(updated),
      });
      this.events.emitConfig(unitId, updated.version);
      if (updated.active !== current.active) {
        this.realtime.refreshAccess(
          { subjects: await subjectsOfUnit(db, unitId), unitIds: [unitId] },
          'unit_changed',
        );
      }
      return toUnitDto(updated);
    });
  }

  private async assertNameFree(db: TenantDb, name: string, exceptId: string | null): Promise<void> {
    const taken = await db.unit.count({
      where: {
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId === null ? {} : { id: { not: exceptId } }),
      },
    });
    if (taken > 0) {
      throw setupError('UNIT_NAME_TAKEN');
    }
  }
}

function auditedUnit(unit: Unit): Record<string, unknown> {
  return { name: unit.name, active: unit.active, lateAfterMinutes: unit.lateAfterMinutes };
}
