import { type CanActivate, type ExecutionContext, Injectable, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Request } from 'express';

import { type AuthContext, setAuthContext } from '../../src/context/request-context.js';
import type { ActorType } from '../../src/generated/prisma/enums.js';

/**
 * TEST ONLY. Stands in for the authentication of phase 1b: reads the actor from `X-Test-*` headers
 * and fills the request context with `setAuthContext`, exactly where the real guard will.
 * Never imported by `src/`.
 */
export const TEST_AUTH_HEADERS = {
  organizationId: 'X-Test-Organization-Id',
  actorType: 'X-Test-Actor-Type',
  actorId: 'X-Test-Actor-Id',
  impersonatorId: 'X-Test-Impersonator-Id',
} as const;

@Injectable()
export class StubAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const actorId = request.header(TEST_AUTH_HEADERS.actorId);
    if (actorId === undefined) {
      return true;
    }
    setAuthContext({
      organizationId: request.header(TEST_AUTH_HEADERS.organizationId) ?? null,
      actor: {
        type: (request.header(TEST_AUTH_HEADERS.actorType) ?? 'staff') as ActorType,
        id: actorId,
      },
      impersonatorId: request.header(TEST_AUTH_HEADERS.impersonatorId) ?? null,
    });
    return true;
  }
}

@Module({ providers: [{ provide: APP_GUARD, useClass: StubAuthGuard }] })
export class StubAuthModule {}

/** Headers that make {@link StubAuthGuard} authenticate the request as `auth`. */
export function authHeaders(auth: AuthContext): Record<string, string> {
  const headers: Record<string, string> = {
    [TEST_AUTH_HEADERS.actorType]: auth.actor.type,
    [TEST_AUTH_HEADERS.actorId]: auth.actor.id ?? '',
  };
  if (auth.organizationId !== null) {
    headers[TEST_AUTH_HEADERS.organizationId] = auth.organizationId;
  }
  if (auth.impersonatorId) {
    headers[TEST_AUTH_HEADERS.impersonatorId] = auth.impersonatorId;
  }
  return headers;
}
