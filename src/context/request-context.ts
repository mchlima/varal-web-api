import { AsyncLocalStorage } from 'node:async_hooks';

import type { ActorType } from '../generated/prisma/enums.js';

/**
 * Who is acting. `system` is used by jobs and scripts, which have no logged-in subject (`id` null).
 */
export interface Actor {
  type: ActorType;
  id: string | null;
}

/**
 * Authenticated part of the context (spec 01, section 6).
 *
 * Integration point for phase 1b: the authentication guard validates the session cookie and calls
 * {@link setAuthContext} once per request. The organization always comes from the token, never
 * from a parameter sent by the client. In "entrar como" (spec 02), `actor` is the owner and
 * `impersonatorId` the platform admin (RN-02.20).
 */
export interface AuthContext {
  /** Null for platform admins outside an impersonation session. */
  organizationId: string | null;
  actor: Actor;
  impersonatorId?: string | null;
  /** Session of the logged-in subject (`sessions.id`), set by the authentication guard. */
  sessionId?: string | null;
}

/** Per-request data available anywhere down the call chain (spec 01, section 6). */
export interface RequestContext {
  /** Correlation id: echoed in the `X-Request-Id` response header and written to the audit log. */
  requestId: string;
  /** `X-Device-Id` header (UUID kept on the device, spec 01, section 7.2). */
  deviceId: string | null;
  /** Client IP as resolved by Express behind the trusted proxy (RN-01.19). */
  ip: string | null;
  auth: AuthContext | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` inside a new context. Used by the HTTP middleware, jobs, scripts and tests. */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Current context, or `undefined` outside {@link runWithContext}. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export class RequestContextError extends Error {
  override name = 'RequestContextError';
}

/**
 * Fills the authenticated part of the current context. May be called only once per context, so
 * nothing later in the request can swap the organization or the actor.
 */
export function setAuthContext(auth: AuthContext): void {
  const context = storage.getStore();
  if (!context) {
    throw new RequestContextError('setAuthContext called outside a request context');
  }
  if (context.auth) {
    throw new RequestContextError('The auth context of this request is already set');
  }
  context.auth = Object.freeze({ ...auth, actor: Object.freeze({ ...auth.actor }) });
}

/** Organization of the current context, or `null` when there is none (anonymous, platform, no context). */
export function currentOrganizationId(): string | null {
  return storage.getStore()?.auth?.organizationId ?? null;
}

/**
 * Organization of the current context; throws when there is none. Use it to fill `organizationId`
 * in creates (the Prisma types require it); the tenant scope checks that it matches the context.
 */
export function requireOrganizationId(): string {
  const organizationId = currentOrganizationId();
  if (organizationId === null) {
    throw new RequestContextError('No organization in the request context (spec 01, section 6)');
  }
  return organizationId;
}

/** Context for code that runs outside HTTP (jobs, seed, tests), acting as the system or as a subject. */
export function systemContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: overrides.requestId ?? crypto.randomUUID(),
    deviceId: overrides.deviceId ?? null,
    ip: overrides.ip ?? null,
    auth: overrides.auth ?? null,
  };
}
