/**
 * Real-time clients in tests (phase 1c): socket.io-client against the Nest app listening on an
 * ephemeral port, as the app would connect (spec 01, section 10).
 */
import type { AddressInfo } from 'node:net';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { io, type Socket } from 'socket.io-client';

import { REALTIME_PATH } from '../../src/realtime/realtime.contracts.js';

/** The origin `createTestApp` allows (CORS_ORIGINS). */
export const TEST_ORIGIN = 'http://localhost:3100';

export interface ConnectOptions {
  /** `Cookie` header of the handshake. */
  cookie?: string;
  /** Sent as `auth.deviceId`; `null` sends no `auth`. */
  deviceId?: string | null;
  /** `Origin` header; `null` sends none. */
  origin?: string | null;
}

/** Starts the HTTP server on an ephemeral port (once) and returns its base URL. */
export async function listen(app: NestExpressApplication): Promise<string> {
  const server = app.getHttpServer() as {
    address(): AddressInfo | string | null;
    listening: boolean;
  };
  if (!server.listening) {
    await app.listen(0, '127.0.0.1');
  }
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

export function createSocket(url: string, options: ConnectOptions = {}): Socket {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) {
    headers.cookie = options.cookie;
  }
  const origin = options.origin === undefined ? TEST_ORIGIN : options.origin;
  if (origin !== null) {
    headers.origin = origin;
  }
  return io(url, {
    path: REALTIME_PATH,
    transports: ['websocket'],
    extraHeaders: headers,
    ...(options.deviceId === null ? {} : { auth: { deviceId: options.deviceId } }),
    reconnection: false,
    forceNew: true,
    autoConnect: false,
    timeout: 5_000,
  });
}

/** Error of a refused connection (`connect_error`). */
export interface ConnectFailure {
  message: string;
  data?: { error?: { code?: string; message?: string } };
}

/** Connects and resolves with the socket, or rejects with the `connect_error`. */
export function connect(url: string, options: ConnectOptions = {}): Promise<Socket> {
  const socket = createSocket(url, options);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => {
      resolve(socket);
    });
    socket.once('connect_error', (error: Error & { data?: unknown }) => {
      socket.close();
      reject(error);
    });
    socket.connect();
  });
}

/** Connects expecting a refusal; resolves with the `connect_error`. */
export async function connectFailure(
  url: string,
  options: ConnectOptions = {},
): Promise<ConnectFailure> {
  try {
    const socket = await connect(url, options);
    socket.close();
  } catch (error) {
    return error as ConnectFailure;
  }
  throw new Error('expected the connection to be refused');
}

/** Collects every event a socket receives. */
export function recordEvents(socket: Socket): { name: string; payload: unknown }[] {
  const events: { name: string; payload: unknown }[] = [];
  socket.onAny((name: string, payload: unknown) => {
    events.push({ name, payload });
  });
  return events;
}

/** Resolves with the next `name` event. */
export function nextEvent<T = unknown>(
  socket: Socket,
  name: string,
  timeoutMs = 3_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no "${name}" event within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.once(name, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Resolves with the reason of the next disconnection. */
export function nextDisconnect(socket: Socket, timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (socket.disconnected) {
      resolve('already disconnected');
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`still connected after ${timeoutMs} ms`));
    }, timeoutMs);
    socket.once('disconnect', (reason: string) => {
      clearTimeout(timer);
      resolve(reason);
    });
  });
}

/** Emits with an acknowledgement and resolves with it. */
export function request<T = unknown>(socket: Socket, event: string, body: unknown): Promise<T> {
  return socket.timeout(3_000).emitWithAck(event, body) as Promise<T>;
}

/** Waits a little, to assert that something did NOT arrive. */
export function settle(ms = 200): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
