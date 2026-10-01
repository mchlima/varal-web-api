import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { DefaultEventsMap, Server, Socket } from 'socket.io';

import { RealtimeAccessService } from './realtime-access.service.js';
import { RealtimeAuthenticator, type SocketSession } from './realtime-auth.js';
import {
  CLIENT_EVENTS,
  RealtimeConnectError,
  type RealtimeErrorCode,
  type RealtimeRoomAck,
  realtimeErrorBody,
  SESSION_EVENTS,
} from './realtime.contracts.js';
import { RealtimeService } from './realtime.service.js';
import { isPublicRoom, parseRoom, roomName, sessionRoom, subjectRoom } from './rooms.js';

interface SocketData {
  session?: SocketSession;
  expiryTimer?: NodeJS.Timeout;
}

type RealtimeServer = Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;
type RealtimeSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

/**
 * Real-time gateway of the customers' app (spec 01, section 10), at `/ws` (options in
 * `RealtimeIoAdapter`).
 *
 * Handshake (middleware, before the connection is accepted):
 * 1. authenticates the access cookie and the device (`RealtimeAuthenticator`); failures reach the
 *    client as `connect_error` with `err.data` = `ErrorResponse` (`UNAUTHENTICATED`,
 *    `DEVICE_ID_REQUIRED`);
 * 2. joins the internal room of the session and every `unit:`/`station:` room the user may access.
 *
 * While connected:
 * - `rooms.join` / `rooms.leave` (optional): the client may leave a room it does not need (e.g.
 *   the stations it is not operating) and join it again; joins are checked against the user's
 *   access, so a room of another organization is refused (`ROOM_FORBIDDEN`, CA-01.02);
 * - when the access token used in the handshake expires, the socket gets `session.expired` and is
 *   disconnected; the app renews the session by REST and reconnects;
 * - when the session is revoked, `RealtimeService.endSessions` sends `session.revoked` and
 *   disconnects (CA-01.05);
 * - when the user's access changes (spec 03: permissions, units, stations),
 *   `RealtimeService.refreshAccess` sends `session.access_changed` and disconnects; the app reloads
 *   `/auth/me` and reconnects, getting the rooms of the new access.
 */
@WebSocketGateway()
export class RealtimeGateway
  implements
    OnGatewayInit<RealtimeServer>,
    OnGatewayConnection<RealtimeSocket>,
    OnGatewayDisconnect<RealtimeSocket>
{
  private readonly logger = new Logger('RealtimeGateway');

  constructor(
    private readonly authenticator: RealtimeAuthenticator,
    private readonly access: RealtimeAccessService,
    private readonly realtime: RealtimeService,
  ) {}

  afterInit(server: RealtimeServer): void {
    this.realtime.attach(server as Server);
    server.use((socket, next) => {
      this.admit(socket).then(
        () => {
          next();
        },
        (error: unknown) => {
          next(this.toConnectError(error));
        },
      );
    });
  }

  handleConnection(socket: RealtimeSocket): void {
    const session = socket.data.session;
    if (!session) {
      socket.disconnect(true);
      return;
    }
    const delay = Math.max(0, session.accessTokenExpiresAt.getTime() - Date.now());
    const timer = setTimeout(() => {
      socket.emit(
        SESSION_EVENTS.expired,
        this.realtime.expiredPayload(session.accessTokenExpiresAt),
      );
      socket.disconnect(true);
    }, delay);
    timer.unref();
    socket.data.expiryTimer = timer;
  }

  handleDisconnect(socket: RealtimeSocket): void {
    clearTimeout(socket.data.expiryTimer);
  }

  @SubscribeMessage(CLIENT_EVENTS.joinRoom)
  async joinRoom(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<RealtimeRoomAck> {
    return this.roomRequest(socket, body, async (session, room) => {
      if (!(await this.access.canAccess(session, room))) {
        return 'ROOM_FORBIDDEN';
      }
      await socket.join(roomName(room));
      return null;
    });
  }

  @SubscribeMessage(CLIENT_EVENTS.leaveRoom)
  async leaveRoom(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<RealtimeRoomAck> {
    return this.roomRequest(socket, body, async (_session, room) => {
      await socket.leave(roomName(room));
      return null;
    });
  }

  private async admit(socket: RealtimeSocket): Promise<void> {
    const session = await this.authenticator.authenticate({
      cookie: socket.handshake.headers.cookie,
      auth: socket.handshake.auth,
    });
    const rooms = await this.access.allowedRoomNames(session);
    socket.data.session = session;
    await socket.join([
      sessionRoom(session.sessionId),
      subjectRoom(session.subjectType, session.subjectId),
      ...rooms,
    ]);
  }

  private async roomRequest(
    socket: RealtimeSocket,
    body: unknown,
    apply: (
      session: SocketSession,
      room: NonNullable<ReturnType<typeof parseRoom>>,
    ) => Promise<RealtimeErrorCode | null>,
  ): Promise<RealtimeRoomAck> {
    const session = socket.data.session;
    if (!session) {
      return this.failure('UNAUTHENTICATED');
    }
    const room =
      typeof body === 'object' && body !== null && 'room' in body ? parseRoom(body.room) : null;
    if (!room) {
      return this.failure('VALIDATION_FAILED');
    }
    try {
      const error = await apply(session, room);
      if (error) {
        return this.failure(error);
      }
    } catch (error) {
      this.logger.error(
        'room request failed',
        error instanceof Error ? error.stack : String(error),
      );
      return this.failure('INTERNAL_ERROR');
    }
    return { ok: true, rooms: [...socket.rooms].filter(isPublicRoom).sort() };
  }

  private failure(code: RealtimeErrorCode): RealtimeRoomAck {
    return { ok: false, ...realtimeErrorBody(code) };
  }

  private toConnectError(error: unknown): RealtimeConnectError {
    if (error instanceof RealtimeConnectError) {
      return error;
    }
    this.logger.error('handshake failed', error instanceof Error ? error.stack : String(error));
    return new RealtimeConnectError('INTERNAL_ERROR');
  }
}
