import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AUTH_COOKIES } from '../auth/auth-area.js';
import { AuthService } from '../auth/auth.service.js';
import type { SubjectType } from '../generated/prisma/enums.js';
import { RealtimeConnectError } from './realtime.contracts.js';

/** What the server keeps about an authenticated socket (`socket.data`). */
export interface SocketSession {
  sessionId: string;
  subjectType: Extract<SubjectType, 'owner' | 'staff'>;
  subjectId: string;
  organizationId: string;
  deviceId: string;
  /** "Entrar como" (spec 02): the admin acting as the owner, and the impersonation. */
  impersonatorId: string | null;
  impersonationId: string | null;
  /** End of the access token used in the handshake: the socket is disconnected then. */
  accessTokenExpiresAt: Date;
}

/** The part of the Socket.IO handshake the authentication reads. */
export interface HandshakeInput {
  /** `Cookie` header of the upgrade request. */
  cookie: string | undefined;
  /** `auth` object of the Socket.IO handshake (`io(url, { auth: { deviceId } })`). */
  auth: unknown;
}

/**
 * Value of the cookie `name` in a `Cookie` header, or undefined. Values are URL-decoded like
 * `cookie-parser` does for the HTTP routes; a malformed encoding counts as absent.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) {
      continue;
    }
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    try {
      value = decodeURIComponent(value);
    } catch {
      return undefined;
    }
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

const handshakeAuthSchema = z.object({ deviceId: z.uuid() });

/**
 * Authenticates a Socket.IO handshake (spec 01, section 10): "a conexão é autenticada pelo mesmo
 * cookie de sessão; sem sessão válida, a conexão é recusada".
 *
 * - Reads only the access cookie of the customers' app (`__Host-varal_at`) and verifies it with the
 *   panel secret and audience: an admin token is never accepted, under any cookie name (CA-01.04).
 * - Checks the session row like the HTTP guard (revoked or expired sessions are refused).
 * - The device id comes in `auth.deviceId` of the handshake (browsers cannot set headers on a
 *   WebSocket) and must be the device of the session (spec 01, section 7.2).
 */
@Injectable()
export class RealtimeAuthenticator {
  constructor(private readonly auth: AuthService) {}

  async authenticate(handshake: HandshakeInput): Promise<SocketSession> {
    const token = readCookie(handshake.cookie, AUTH_COOKIES.panel.access);
    if (token === undefined) {
      throw new RealtimeConnectError('UNAUTHENTICATED');
    }
    const parsedAuth = handshakeAuthSchema.safeParse(handshake.auth);
    if (!parsedAuth.success) {
      throw new RealtimeConnectError('DEVICE_ID_REQUIRED');
    }
    const authenticated = await this.auth.authenticate('panel', token);
    if (!authenticated) {
      throw new RealtimeConnectError('UNAUTHENTICATED');
    }
    const { session, claims, impersonation } = authenticated;
    const deviceId = parsedAuth.data.deviceId.toLowerCase();
    if (
      session.deviceId.toLowerCase() !== deviceId ||
      session.organizationId === null ||
      (session.subjectType !== 'owner' && session.subjectType !== 'staff')
    ) {
      throw new RealtimeConnectError('UNAUTHENTICATED');
    }
    return {
      sessionId: session.id,
      subjectType: session.subjectType,
      subjectId: session.subjectId,
      organizationId: session.organizationId,
      deviceId,
      impersonatorId: impersonation?.platformAdminId ?? null,
      impersonationId: impersonation?.id ?? null,
      accessTokenExpiresAt: claims.expiresAt,
    };
  }
}
