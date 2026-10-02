import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../errors/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { StationKind, WorkflowStageTarget } from '../generated/prisma/enums.js';
import type { TenantDb } from '../prisma/prisma.service.js';
import { defaultTimeLimits } from './time-limits.js';

/**
 * Default stations and workflow of a new unit (spec 03, section 4.4; RN-03.03; CA-03.01).
 * `prepStation` is the station new categories get by default ("Toda categoria nova recebe Cozinha").
 */
export const DEFAULT_TEMPLATE = {
  stations: [
    { key: 'counter', name: 'Balcão', kind: 'counter' },
    { key: 'kitchen', name: 'Cozinha', kind: 'queue' },
    { key: 'delivery', name: 'Balcão de entrega', kind: 'queue' },
  ],
  stages: [
    { name: 'Recebido', target: 'product_station', station: null },
    { name: 'Preparando', target: 'product_station', station: null },
    { name: 'Pronto', target: 'fixed_station', station: 'delivery' },
    { name: 'Entregue', target: 'none', station: null },
  ],
  prepStation: 'Cozinha',
  /** RN-03.03, RN-05.17: the cash register every new unit is born with (CA-03.11). */
  cashRegister: 'Caixa 1',
} as const satisfies {
  stations: readonly { key: string; name: string; kind: StationKind }[];
  stages: readonly { name: string; target: WorkflowStageTarget; station: string | null }[];
  prepStation: string;
  cashRegister: string;
};

/**
 * What the template needs from the database: a transaction of the tenant client (`PrismaService`,
 * owner creating a unit) or of the unscoped client (`PlatformPrismaService`, the platform admin
 * creating an organization in spec 02, and the seed). Every query names the organization by hand,
 * so it is correct with both.
 */
export type TemplateDb = TenantDb | Prisma.TransactionClient;

export interface TemplateTarget {
  organizationId: string;
  unitId: string;
}

export interface TemplateResult {
  /** False when the unit already had stations or stages (nothing was changed). */
  applied: boolean;
  stationIds: string[];
  stageIds: string[];
  /** "Caixa 1", created when the unit had no cash register (null otherwise). */
  cashRegisterId: string | null;
}

/**
 * Applies the default template to a unit (RN-03.03): stations (the `queue` ones with the time limits
 * of RN-03.25), workflow and the cash register "Caixa 1" (RN-05.17). **Integration point of spec 02**: the platform
 * admin creating an organization (and its first unit) calls
 * `UnitTemplateService.applyDefaultTemplate(tx, { organizationId, unitId })` in the same
 * transaction; `UnitsModule` exports this service.
 *
 * - Idempotent: applies only to a unit with no station and no active stage; otherwise it changes
 *   nothing and returns `applied: false`. The unit row is locked (`FOR UPDATE`) first, so two
 *   concurrent calls never create the template twice.
 * - Run it inside the transaction that created the unit; it writes the audit row
 *   `unit.template_applied` there.
 */
@Injectable()
export class UnitTemplateService {
  constructor(private readonly audit: AuditService) {}

  async applyDefaultTemplate(tx: TemplateDb, target: TemplateTarget): Promise<TemplateResult> {
    // Both clients expose the same delegates; the tenant extension only adds filters, and every
    // query here already names the organization.
    const db = tx as Prisma.TransactionClient;
    const { organizationId, unitId } = target;
    // Raw SQL is not filtered by the tenant scope: the organization is checked by hand.
    const locked = await db.$queryRaw<{ id: string; late_after_minutes: number }[]>`
      SELECT id, late_after_minutes FROM units
      WHERE id = ${unitId}::uuid AND organization_id = ${organizationId}::uuid
      FOR UPDATE`;
    const [unit] = locked;
    if (!unit) {
      throw AppError.of('NOT_FOUND');
    }
    const scope = { organizationId, unitId };
    const [stationCount, stageCount] = await Promise.all([
      db.station.count({ where: scope }),
      db.workflowStage.count({ where: { ...scope, archivedAt: null } }),
    ]);
    if (stationCount > 0 || stageCount > 0) {
      return { applied: false, stationIds: [], stageIds: [], cashRegisterId: null };
    }

    const limits = defaultTimeLimits(unit.late_after_minutes);
    const stationIds = new Map<string, string>();
    for (const [index, station] of DEFAULT_TEMPLATE.stations.entries()) {
      const created = await db.station.create({
        data: {
          ...scope,
          name: station.name,
          kind: station.kind,
          sortOrder: index + 1,
          ...(station.kind === 'queue' ? limits : {}),
        },
      });
      stationIds.set(station.key, created.id);
    }
    const stageIds: string[] = [];
    for (const [index, stage] of DEFAULT_TEMPLATE.stages.entries()) {
      const created = await db.workflowStage.create({
        data: {
          ...scope,
          name: stage.name,
          sortOrder: index + 1,
          target: stage.target,
          stationId: stage.station === null ? null : (stationIds.get(stage.station) ?? null),
          isFinal: stage.target === 'none',
        },
      });
      stageIds.push(created.id);
    }
    let cashRegisterId: string | null = null;
    if ((await db.cashRegister.count({ where: scope })) === 0) {
      const register = await db.cashRegister.create({
        data: { ...scope, name: DEFAULT_TEMPLATE.cashRegister, sortOrder: 1 },
      });
      cashRegisterId = register.id;
    }
    await this.audit.record(db, {
      action: 'unit.template_applied',
      entityType: 'unit',
      entityId: unitId,
      organizationId,
      metadata: {
        stations: DEFAULT_TEMPLATE.stations.map((station) => station.name),
        stages: DEFAULT_TEMPLATE.stages.map((stage) => stage.name),
        cashRegister: cashRegisterId === null ? null : DEFAULT_TEMPLATE.cashRegister,
      },
    });
    return { applied: true, stationIds: [...stationIds.values()], stageIds, cashRegisterId };
  }
}
