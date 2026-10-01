import type { CookieOptions, Request, Response } from 'express';

import { getRequestContext } from '../context/request-context.js';
import { AUTH_COOKIES, type AuthArea, REFRESH_TOKEN_TTL_MS } from './auth-area.js';
import type { IssuedSession } from './auth.service.js';
import type { SessionInfo } from './auth.schemas.js';
import type { ClientInfo } from './session.service.js';

/**
 * Session cookies (spec 01, section 7.2): `httpOnly`, `Secure`, `SameSite=Strict`, no `Domain`
 * (valid only on the API host). Browsers accept `Secure` cookies on http://localhost, so the same
 * attributes work in development.
 */
function baseOptions(): CookieOptions {
  return { httpOnly: true, secure: true, sameSite: 'strict' };
}

export function setSessionCookies(response: Response, area: AuthArea, issued: IssuedSession): void {
  const names = AUTH_COOKIES[area];
  response.cookie(names.access, issued.accessToken.token, {
    ...baseOptions(),
    path: '/',
    maxAge: issued.accessToken.expiresAt.getTime() - Date.now(),
  });
  response.cookie(names.refresh, issued.refreshToken, {
    ...baseOptions(),
    path: names.refreshPath,
    // 30 days, or what is left of an "entrar como" (spec 02, CA-02.08).
    maxAge:
      issued.session.impersonationId === null
        ? REFRESH_TOKEN_TTL_MS
        : Math.max(0, issued.session.expiresAt.getTime() - Date.now()),
  });
}

export function clearSessionCookies(response: Response, area: AuthArea): void {
  const names = AUTH_COOKIES[area];
  response.clearCookie(names.access, { ...baseOptions(), path: '/' });
  response.clearCookie(names.refresh, { ...baseOptions(), path: names.refreshPath });
}

/** Device, IP and user agent of the request (spec 01, section 7.2; RN-01.19). */
export function clientOf(request: Request): ClientInfo {
  const context = getRequestContext();
  return {
    deviceId: context?.deviceId ?? null,
    ip: context?.ip ?? null,
    userAgent: request.header('user-agent') ?? null,
  };
}

export function sessionInfoOf(
  issued: Pick<IssuedSession, 'session'> & { accessTokenExpiresAt: Date },
): SessionInfo {
  return {
    id: issued.session.id,
    deviceId: issued.session.deviceId,
    accessTokenExpiresAt: issued.accessTokenExpiresAt.toISOString(),
    expiresAt: issued.session.expiresAt.toISOString(),
  };
}
