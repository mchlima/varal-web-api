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
 * - Owner: every active unit of the organization. Stations arrive with spec 03; until then the owner
 *   gets no `station:` room (the station table will list the stations of the active units).
 * - Staff: the active units of `staff_unit_permissions` and the stations in their `station_ids`.
 *
 * Queries run through the tenant client with the organization of the session, so a unit or station
 * of another organization is never found (CA-01.02).
 */
@Injectable()
export class RealtimeAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async allowedRooms(session: SocketSession): Promise<AllowedRooms> {
    return this.asSubject(session, async () => {
      if (session.subjectType === 'owner') {
        const units = await this.prisma.db.unit.findMany({
          where: { active: true },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        return { unitIds: units.map((unit) => unit.id), stationIds: [] };
      }
      const permissions = await this.prisma.db.staffUnitPermission.findMany({
        where: { staffMemberId: session.subjectId, unit: { active: true } },
        select: { unitId: true, stationIds: true },
        orderBy: { unitId: 'asc' },
      });
      return {
        unitIds: permissions.map((permission) => permission.unitId),
        stationIds: [...new Set(permissions.flatMap((permission) => permission.stationIds))],
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
          impersonatorId: null,
          sessionId: session.sessionId,
        },
      }),
      async () => await fn(),
    );
  }
}
