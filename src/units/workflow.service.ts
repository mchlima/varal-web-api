import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { updateWithVersion } from '../common/versioned-update.js';
import { requireOrganizationId } from '../context/request-context.js';
import type { Unit } from '../generated/prisma/client.js';
import type { WorkflowStageTarget } from '../generated/prisma/enums.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { OpenShiftChecker } from './open-shift.js';
import { setupError } from './setup-errors.js';
import { SetupEvents } from './setup-events.js';
import { requireUnit } from './stations.service.js';
import { UnitAccessService } from './unit-access.js';
import { toWorkflowStageDto, type WorkflowDto } from './units.schemas.js';
import { validateWorkflow } from './workflow-rules.js';

export interface WorkflowStageInput {
  id?: string | undefined;
  name: string;
  target: WorkflowStageTarget;
  stationId?: string | null | undefined;
}

/** Positions are moved out of the way before the new order is written (unique per unit). */
const SORT_ORDER_SHIFT = 100_000;

/**
 * The workflow of a unit (spec 03, section 4.2): read, and saved at once (`PUT`), validated by
 * RN-03.05 to RN-03.07.
 *
 * Stage ids are kept: a stage sent with its `id` is updated in place, so items of past shifts still
 * point to it (spec 04); a current stage left out of the request is archived (`archived_at`), never
 * deleted. Positions are rewritten 1..n in the order of the request.
 */
@Injectable()
export class WorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly shifts: OpenShiftChecker,
    private readonly events: SetupEvents,
    private readonly units: UnitAccessService,
  ) {}

  /**
   * Read by the owner and by the staff of the unit (the counter and the stations show the stages;
   * phase 5 adjustment). Writing stays with the owner (`PUT`).
   */
  async get(unitId: string): Promise<WorkflowDto> {
    const { unit } = await this.units.forMember(unitId);
    return this.read(this.prisma.db, unit);
  }

  async save(
    unitId: string,
    input: { version?: number | undefined; stages: WorkflowStageInput[] },
  ): Promise<WorkflowDto> {
    return this.prisma.transaction(async (db) => {
      const current = await requireUnit(db, unitId);
      // CA-03.03 / RN-03.07.
      await this.shifts.assertNoOpenShift(db, unitId);
      // Bumps the version first: it locks the unit row, so two saves never interleave, and
      // answers VERSION_CONFLICT when the app saw an older workflow.
      const unit = await updateWithVersion<Unit>(db.unit, {
        where: { id: unitId },
        expectedVersion: input.version ?? current.version,
        data: {},
      });

      const stations = await db.station.findMany({ where: { unitId } });
      const issues = validateWorkflow(input.stages, stations);
      if (issues.length > 0) {
        // CA-03.02.
        throw setupError('INVALID_WORKFLOW', { issues });
      }

      const existing = await db.workflowStage.findMany({
        where: { unitId, archivedAt: null },
        orderBy: { sortOrder: 'asc' },
      });
      const existingIds = new Set(existing.map((stage) => stage.id));
      const keptIds = input.stages.flatMap((stage) =>
        stage.id === undefined ? [] : [stage.id.toLowerCase()],
      );
      if (new Set(keptIds).size !== keptIds.length || keptIds.some((id) => !existingIds.has(id))) {
        throw setupError('INVALID_REFERENCE', {
          message: 'Uma das etapas enviadas não é uma etapa atual desta unidade.',
        });
      }
      const kept = new Set(keptIds);
      const archived = existing.filter((stage) => !kept.has(stage.id)).map((stage) => stage.id);
      if (archived.length > 0) {
        await db.workflowStage.updateMany({
          where: { id: { in: archived } },
          data: { archivedAt: new Date() },
        });
      }
      if (keptIds.length > 0) {
        await db.workflowStage.updateMany({
          where: { id: { in: keptIds } },
          data: { sortOrder: { increment: SORT_ORDER_SHIFT } },
        });
      }
      for (const [index, stage] of input.stages.entries()) {
        const data = {
          name: stage.name,
          sortOrder: index + 1,
          target: stage.target,
          stationId: stage.target === 'fixed_station' ? (stage.stationId ?? null) : null,
          isFinal: stage.target === 'none',
        };
        if (stage.id === undefined) {
          await db.workflowStage.create({
            data: { organizationId: requireOrganizationId(), unitId, ...data },
          });
        } else {
          await db.workflowStage.update({ where: { id: stage.id.toLowerCase() }, data });
        }
      }

      const saved = await this.read(db, unit);
      await this.audit.record(db, {
        action: 'workflow.updated',
        entityType: 'unit',
        entityId: unitId,
        before: { stages: existing.map(auditedStage) },
        after: { stages: saved.stages.map(auditedStage) },
        metadata: { archivedStageIds: archived },
      });
      this.events.emitConfig(unitId, unit.version);
      return saved;
    });
  }

  private async read(db: TenantDb, unit: Unit): Promise<WorkflowDto> {
    const stages = await db.workflowStage.findMany({
      where: { unitId: unit.id, archivedAt: null },
      orderBy: { sortOrder: 'asc' },
    });
    return { unitId: unit.id, version: unit.version, stages: stages.map(toWorkflowStageDto) };
  }
}

function auditedStage(stage: {
  id: string;
  name: string;
  target: WorkflowStageTarget;
  stationId: string | null;
}): Record<string, unknown> {
  return { id: stage.id, name: stage.name, target: stage.target, stationId: stage.stationId };
}
