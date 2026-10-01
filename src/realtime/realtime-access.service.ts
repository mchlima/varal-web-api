import { Injectable } from '@nestjs/common';

import { runWithContext, systemContext } from '../context/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SocketSession } from './realtime-auth.js';
import { type RoomRef, stationRoom, unitRoom } from './rooms.js';

/** Rooms a user may be in. */
export interface AllowedRooms {
  unitIds: string[];
  stationIds: string[];
}

/**
 * Which `unit:` and `station:` rooms a user may access (spec 01, section 10: "o servidor só coloca o
 * aparelho em salas da organização e das unidades e estações que o usuário pode acessar").
 *
 * - Owner: every active unit of the organization and every active station of those units (the
 *   owner opens any station, spec 01, section 7.1).
 * - Staff: the active units of `staff_unit_permissions` and, among their `station_ids`, the active
 *   stations of that same unit (`station_ids` has no foreign key, so ids of another unit, of a
 *   deactivated station or of nothing are ignored).
 *
 * Queries run through the tenant client with the organization of the session, so a unit or station
 * of another organization is never found (CA-01.02).
 */
@Injectable()
export class RealtimeAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async allowedRooms(session: SocketSession): Promise<AllowedRooms> {
    return this.asSubject(session, async () => {
      const db = this.prisma.db;
      if (session.subjectType === 'owner') {
        const units = await db.unit.findMany({
          where: { active: true },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        const stations = await db.station.findMany({
          where: { active: true, unit: { active: true } },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        return {
          unitIds: units.map((unit) => unit.id),
          stationIds: stations.map((station) => station.id),
        };
      }
      const permissions = await db.staffUnitPermission.findMany({
        where: { staffMemberId: session.subjectId, unit: { active: true } },
        select: { unitId: true, stationIds: true },
        orderBy: { unitId: 'asc' },
      });
      const requested = permissions.flatMap((permission) =>
        permission.stationIds.map((id) => ({ unitId: permission.unitId, id })),
      );
      const stations =
        requested.length === 0
          ? []
          : await db.station.findMany({
              where: { active: true, id: { in: requested.map((station) => station.id) } },
              select: { id: true, unitId: true },
              orderBy: { id: 'asc' },
            });
      const allowed = new Set(requested.map((station) => `${station.unitId}:${station.id}`));
      return {
        unitIds: permissions.map((permission) => permission.unitId),
        stationIds: stations
          .filter((station) => allowed.has(`${station.unitId}:${station.id}`))
          .map((station) => station.id),
      };
    });
  }

  /** Room names of {@link allowedRooms}. */
  async allowedRoomNames(session: SocketSession): Promise<string[]> {
    const { unitIds, stationIds } = await this.allowedRooms(session);
    return [...unitIds.map(unitRoom), ...stationIds.map(stationRoom)];
  }

  async canAccess(session: SocketSession, room: RoomRef): Promise<boolean> {
    const allowed = await this.allowedRooms(session);
    const ids = room.kind === 'unit' ? allowed.unitIds : allowed.stationIds;
    return ids.some((id) => id.toLowerCase() === room.id);
  }

  /** Runs `fn` in a context with the organization and actor of the socket's session. */
  private asSubject<T>(session: SocketSession, fn: () => Promise<T>): Promise<T> {
    return runWithContext(
      systemContext({
        deviceId: session.deviceId,
        auth: {
          organizationId: session.organizationId,
          actor: { type: session.subjectType, id: session.subjectId },
          impersonatorId: session.impersonatorId,
          impersonationId: session.impersonationId,
          sessionId: session.sessionId,
        },
      }),
      async () => await fn(),
    );
  }
}
