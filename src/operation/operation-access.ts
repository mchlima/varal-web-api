import { Injectable } from '@nestjs/common';

import { AppError } from '../errors/app-error.js';
import type { StaffUnitPermission, Unit } from '../generated/prisma/client.js';
import type { TenantDb } from '../prisma/prisma.service.js';
import { permittedStations, type StationSummary } from '../units/permitted-stations.js';
import { UnitAccessService } from '../units/unit-access.js';

/** Who operates a unit and with which stations (spec 04; RN-03.16). */
export interface OperatorAccess {
  unit: Unit;
  actor: { type: 'owner' | 'staff'; id: string };
  /** The staff member's permission in the unit; null for the owner. */
  permission: StaffUnitPermission | null;
  /** Active stations the actor opens in the unit (the owner: all of them). */
  stations: StationSummary[];
}

export function isOwner(access: OperatorAccess): boolean {
  return access.permission === null;
}

/** RN-04.02: the owner and staff with `can_operate_cash` open and close shifts. */
export function canOperateCash(access: OperatorAccess): boolean {
  return access.permission === null || access.permission.canOperateCash;
}

/** Staff with a `counter` station of the unit (the owner always). */
export function hasCounter(access: OperatorAccess): boolean {
  return isOwner(access) || access.stations.some((station) => station.kind === 'counter');
}

/** Staff with access to `stationId` (the owner always). */
export function hasStation(access: OperatorAccess, stationId: string | null): boolean {
  return (
    isOwner(access) ||
    (stationId !== null && access.stations.some((station) => station.id === stationId))
  );
}

function forbidden(message: string): AppError {
  return AppError.of('FORBIDDEN', { message });
}

export function assertCanOperateCash(
  access: OperatorAccess,
  message = 'Só o dono ou quem opera o caixa nesta unidade pode abrir e fechar turno.',
): void {
  if (!canOperateCash(access)) {
    throw forbidden(message);
  }
}

export function assertCounter(access: OperatorAccess): void {
  if (!hasCounter(access)) {
    throw forbidden('Você precisa ter acesso ao balcão desta unidade.');
  }
}

/**
 * Permissions of the operation (spec 04): the owner does everything (and so does an admin in
 * "entrar como", who acts as the owner, RN-02.18); staff only in their active units and stations
 * (spec 03, RN-03.16). A unit of another organization is a 404; a unit without access is a 403.
 */
@Injectable()
export class OperationAccessService {
  constructor(private readonly units: UnitAccessService) {}

  async forUnit(db: TenantDb, unitId: string): Promise<OperatorAccess> {
    const { unit, actor, permission } = await this.units.forMember(unitId);
    const stations = await db.station.findMany({ where: { unitId, active: true } });
    const allowed = permittedStations(
      unitId,
      permission === null ? stations.map((station) => station.id) : permission.stationIds,
      stations,
    );
    return { unit, actor, permission, stations: allowed };
  }
}
