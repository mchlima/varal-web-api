import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Server } from 'socket.io';
import type { z } from 'zod';

import { AuthEvents, type SessionRevocationReason } from '../auth/auth-events.js';
import { requireOrganizationId } from '../context/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type AccessChangeReason,
  type EventSessionAccessChanged,
  EventSessionAccessChangedSchema,
  type EventSessionExpired,
  type EventSessionRevoked,
  EventSessionExpiredSchema,
  EventSessionRevokedSchema,
  type RealtimeEnvelope,
  type RealtimeEventDefinition,
  SESSION_EVENTS,
} from './realtime.contracts.js';
import { isPublicRoom, sessionRoom, stationRoom, subjectRoom, unitRoom } from './rooms.js';

/** What the emitting module provides; the envelope adds the organization, type and time. */
export interface RealtimeEmit<TData> {
  unitId: string;
  /** Version of the resource after the change (spec 01, section 10). */
  version: number;
  data: TData;
}

/**
 * Emits real-time events to the rooms (spec 01, section 10). Used by the business modules
 * (specs 03, 04 and 05):
 *
 * ```ts
 * const OrderCreated = defineRealtimeEvent('EventOrderCreated', 'order.created', OrderSchema);
 * await this.prisma.transaction(async (tx) => {
 *   ...
 *   this.realtime.emitToUnit(OrderCreated, { unitId, version: order.version, data: order });
 *   this.realtime.emitToStation(stationId, OrderCreated, { unitId, version, data: onlyItsItems });
 * });
 * ```
 *
 * - The organization comes from the request context, never from the caller.
 * - The envelope is validated with the event schema at the call (a bad payload fails the action
 *   and rolls its transaction back), and sent only **after the commit** of the ambient transaction
 *   (`PrismaService.afterCommit`): events never leave a rolled-back transaction. Outside a
 *   transaction they are sent at once.
 * - Ending sessions: on `auth.sessions_revoked` the sockets of those sessions get
 *   `session.revoked` and are disconnected at once (CA-01.05).
 *
 * Single instance: rooms live in the memory of this process (Socket.IO's default adapter). More
 * than one API instance would need a shared adapter (e.g. `@socket.io/postgres-adapter`) and
 * sticky sessions only if polling were enabled.
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RealtimeService');
  private server: Server | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authEvents: AuthEvents,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.authEvents.onSessionsRevoked((event) => {
      this.endSessions(event.sessionIds, event.reason);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Called by the gateway once the Socket.IO server exists. */
  attach(server: Server): void {
    this.server = server;
  }

  emitToUnit<TType extends string, TData extends z.ZodType>(
    event: RealtimeEventDefinition<TType, TData>,
    payload: RealtimeEmit<z.infer<TData>>,
  ): void {
    this.emitAfterCommit([unitRoom(payload.unitId)], event, payload);
  }

  /** Station rooms (`station:{stationId}`); `payload.unitId` is the unit of the station. */
  emitToStation<TType extends string, TData extends z.ZodType>(
    stationId: string,
    event: RealtimeEventDefinition<TType, TData>,
    payload: RealtimeEmit<z.infer<TData>>,
  ): void {
    this.emitAfterCommit([stationRoom(stationId)], event, payload);
  }

  /**
   * Sends `session.revoked` to every socket of these sessions and disconnects them (CA-01.05).
   * Called after the revocation committed.
   */
  endSessions(sessionIds: readonly string[], reason: SessionRevocationReason): void {
    const server = this.server;
    if (!server || sessionIds.length === 0) {
      return;
    }
    const rooms = sessionIds.map(sessionRoom);
    const payload: EventSessionRevoked = EventSessionRevokedSchema.parse({
      type: SESSION_EVENTS.revoked,
      occurredAt: new Date().toISOString(),
      data: { reason },
    });
    // Same connection, in order: the event is written before the disconnect packet.
    server.to(rooms).emit(SESSION_EVENTS.revoked, payload);
    server.in(rooms).disconnectSockets(true);
  }

  /**
   * Makes sockets reconnect with the rooms of their new access (spec 01, section 10: "mudança de
   * permissão encerra as sessões ou as conexões de tempo real, para valer na hora"). After the
   * commit of the ambient transaction, every socket of the given subjects or in the given unit
   * rooms gets `session.access_changed` and is disconnected; the session stays valid, and the app
   * reloads `/auth/me` and reconnects. Used by spec 03 on permission, unit and station changes.
   */
  refreshAccess(
    target: {
      subjects?: readonly { type: 'owner' | 'staff'; id: string }[];
      unitIds?: readonly string[];
    },
    reason: AccessChangeReason,
  ): void {
    const rooms = [
      ...(target.subjects ?? []).map((subject) => subjectRoom(subject.type, subject.id)),
      ...(target.unitIds ?? []).map(unitRoom),
    ];
    if (rooms.length === 0) {
      return;
    }
    const payload: EventSessionAccessChanged = EventSessionAccessChangedSchema.parse({
      type: SESSION_EVENTS.accessChanged,
      occurredAt: new Date().toISOString(),
      data: { reason },
    });
    this.prisma.afterCommit(() => {
      const server = this.server;
      if (!server) {
        return;
      }
      server.to(rooms).emit(SESSION_EVENTS.accessChanged, payload);
      server.in(rooms).disconnectSockets(true);
    });
  }

  /** `unit:` and `station:` rooms of each connected socket of a session (diagnostics and tests). */
  async roomsOfSession(sessionId: string): Promise<string[][]> {
    if (!this.server) {
      return [];
    }
    const sockets = await this.server.in(sessionRoom(sessionId)).fetchSockets();
    return sockets.map((socket) => [...socket.rooms].filter(isPublicRoom).sort());
  }

  /** Payload of `session.expired`, sent by the gateway when the socket's token expires. */
  expiredPayload(expiredAt: Date): EventSessionExpired {
    return EventSessionExpiredSchema.parse({
      type: SESSION_EVENTS.expired,
      occurredAt: new Date().toISOString(),
      data: { expiredAt: expiredAt.toISOString() },
    });
  }

  private emitAfterCommit<TType extends string, TData extends z.ZodType>(
    rooms: string[],
    event: RealtimeEventDefinition<TType, TData>,
    payload: RealtimeEmit<z.infer<TData>>,
  ): void {
    const envelope: RealtimeEnvelope<TType, z.infer<TData>> = event.schema.parse({
      type: event.type,
      organizationId: requireOrganizationId(),
      unitId: payload.unitId,
      occurredAt: new Date().toISOString(),
      version: payload.version,
      data: payload.data,
    });
    this.prisma.afterCommit(() => {
      if (!this.server) {
        this.logger.warn(`event ${event.type} dropped: the real-time server is not running`);
        return;
      }
      this.server.to(rooms).emit(event.type, envelope);
    });
  }
}
