import type { IncomingMessage } from 'node:http';

import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server, ServerOptions } from 'socket.io';

import { REALTIME_PATH } from './realtime.contracts.js';

/** The client sends nothing but small room requests. */
const MAX_MESSAGE_BYTES = 16 * 1024;

/**
 * True when the `Origin` of the handshake is one of the exact origins of `CORS_ORIGINS`.
 *
 * CORS does not apply to WebSocket upgrades (browsers open them from any page), so the origin is
 * checked here (RN-01.20). A request without `Origin` is refused too: every browser sends it, and
 * scripts must send it explicitly (e.g. `extraHeaders: { origin }` in socket.io-client on Node).
 */
export function isAllowedOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  return origin !== undefined && allowed.includes(origin);
}

/**
 * Socket.IO server options of the real-time channel (spec 01, section 10; plan 2.1).
 *
 * - `path: '/ws'`.
 * - `transports: ['websocket']`: no HTTP long-polling, so no sticky session is ever needed (the
 *   polling requests of one client could reach different instances) and the handshake is a single
 *   upgrade request that carries the cookie and the `Origin`. Every browser the app supports has
 *   WebSocket; the client must be created with `transports: ['websocket']`.
 * - `pingInterval` 25 s (Socket.IO default): traffic every 25 s keeps the connection under the
 *   100 s idle limit of Cloudflare; `pingTimeout` 20 s detects a dead device in under a minute.
 * - CORS with credentials only for the exact origins (RN-01.20, never `*`) and the same list
 *   enforced on the upgrade by `allowRequest`.
 * - No connection state recovery: after a reconnection the app reloads the state by REST
 *   (RN-01.05).
 */
export function realtimeServerOptions(origins: readonly string[]): Partial<ServerOptions> {
  return {
    path: REALTIME_PATH,
    serveClient: false,
    transports: ['websocket'],
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: MAX_MESSAGE_BYTES,
    cors: { origin: [...origins], credentials: true },
    allowRequest: (
      request: IncomingMessage,
      callback: (error: string | null | undefined, success: boolean) => void,
    ) => {
      callback(null, isAllowedOrigin(request.headers.origin, origins));
    },
  };
}

/** Nest adapter that creates the Socket.IO server with {@link realtimeServerOptions}. */
export class RealtimeIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly origins: readonly string[],
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    return super.createIOServer(port, {
      ...options,
      ...realtimeServerOptions(this.origins),
    } as ServerOptions);
  }
}
