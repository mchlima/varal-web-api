import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { getRequestContext, setAuthContext } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import { AUTH_COOKIES, type AuthArea, isAdminPath } from './auth-area.js';
import { ADMIN_AREA, IS_PUBLIC } from './auth.decorators.js';
import { type AuthenticatedRequest, AuthService } from './auth.service.js';

const authenticatedRequests = new WeakMap<Request, AuthenticatedRequest>();

/** Session and token claims the guard validated for this request (protected routes only). */
export function authenticatedOf(request: Request): AuthenticatedRequest {
  const authenticated = authenticatedRequests.get(request);
  if (!authenticated) {
    throw AppError.of('UNAUTHENTICATED');
  }
  return authenticated;
}

/** Reads a cookie by name; `cookie-parser` fills `request.cookies`. */
export function cookieOf(request: Request, name: string): string | undefined {
  const cookies = request.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Global guard (APP_GUARD) of the HTTP routes (spec 01, sections 6 and 7.2).
 *
 * - `@Public()` routes pass without a session.
 * - Admin routes (`@AdminArea()` or path under `/api/v1/admin`) accept only the admin cookie, signed
 *   with the admin secret; every other route accepts only the panel cookie (CA-01.04).
 * - The JWT is checked and then its session row, on every request: revoked or expired sessions stop
 *   at once (logout, password change or reset, deactivation).
 * - The device of the request (`X-Device-Id`), when sent, must be the one of the session.
 * - On success it fills the request context with `setAuthContext`: organization (from the token,
 *   never from the client), actor and session. The tenant filter of Prisma relies on it.
 *
 * WebSocket connections are authenticated in the handshake by `RealtimeAuthenticator` (src/realtime).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets)) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const adminByMetadata =
      this.reflector.getAllAndOverride<boolean | undefined>(ADMIN_AREA, targets) === true;
    const area: AuthArea = adminByMetadata || isAdminPath(request.path) ? 'admin' : 'panel';

    const token = cookieOf(request, AUTH_COOKIES[area].access);
    if (token === undefined) {
      throw AppError.of('UNAUTHENTICATED');
    }
    const authenticated = await this.auth.authenticate(area, token);
    if (!authenticated) {
      throw AppError.of('UNAUTHENTICATED');
    }
    const { session } = authenticated;
    const requestContext = getRequestContext();
    if (requestContext?.deviceId && requestContext.deviceId !== session.deviceId) {
      throw AppError.of('UNAUTHENTICATED');
    }
    authenticatedRequests.set(request, authenticated);
    setAuthContext({
      organizationId: session.organizationId,
      actor: { type: session.subjectType, id: session.subjectId },
      // "Entrar como" (spec 02) fills it from sessions.impersonation_id.
      impersonatorId: null,
      sessionId: session.id,
    });
    return true;
  }
}
