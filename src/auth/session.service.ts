import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import type { Session } from '../generated/prisma/client.js';
import type { SubjectType } from '../generated/prisma/enums.js';
import { PlatformPrismaService } from '../prisma/platform-prisma.service.js';
import type { AuthDb } from './auth-db.js';
import { AREA_SUBJECTS, type AuthArea, REFRESH_TOKEN_TTL_MS } from './auth-area.js';
import { AuthEvents, type SessionRevocationReason } from './auth-events.js';
import { entityTypeOf } from './subjects.js';
import { hashToken, randomToken, sameHash } from './secure-token.js';

/**
 * A rotated refresh token presented again within this window is treated as a concurrent refresh
 * (two tabs, a retry after a lost response): it is refused without revoking the session. Later, it
 * is a reuse of a stolen token and the whole session is revoked.
 */
export const REFRESH_REUSE_GRACE_MS = 30_000;

export interface NewSession {
  subjectType: SubjectType;
  subjectId: string;
  organizationId: string | null;
  deviceId: string;
  userAgent: string | null;
  ip: string | null;
}

export interface ClientInfo {
  deviceId: string | null;
  userAgent: string | null;
  ip: string | null;
}

export type RotationResult =
  | { kind: 'rotated'; session: Session; refreshToken: string }
  | { kind: 'invalid' }
  | { kind: 'reused'; session: Session };

const uuidSchema = z.uuid();

/** The refresh token is `<session id>.<32 random bytes>`; only the hash of the secret is stored. */
function parseRefreshToken(token: string): { sessionId: string; secret: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0) {
    return null;
  }
  const sessionId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!uuidSchema.safeParse(sessionId).success || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    return null;
  }
  return { sessionId: sessionId.toLowerCase(), secret };
}

function userAgentOf(value: string | null): string | null {
  return value === null ? null : value.slice(0, 512);
}

/**
 * Sessions (spec 01, section 7.2): one row per device login, with an opaque refresh token that
 * rotates on every use and lives 30 days from the last rotation.
 *
 * Revocation is immediate for HTTP: the guard checks the session row on every request. Revoking
 * emits `auth.sessions_revoked` (after commit, by the caller) for the realtime gateway of phase 1c.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly platform: PlatformPrismaService,
    private readonly audit: AuditService,
    private readonly events: AuthEvents,
  ) {}

  /**
   * Opens a session. A previous active session of the same subject on the same device is ended
   * (a new login replaces it), so the list of sessions stays one per device.
   */
  async create(
    tx: AuthDb,
    input: NewSession,
    now = new Date(),
  ): Promise<{ session: Session; refreshToken: string; replacedSessionIds: string[] }> {
    const replacedSessionIds = await this.revokeWhere(
      tx,
      {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        deviceId: input.deviceId,
        impersonationId: null,
      },
      'new_login_on_device',
      now,
    );
    const secret = randomToken();
    const session = await tx.session.create({
      data: {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        organizationId: input.organizationId,
        deviceId: input.deviceId,
        refreshTokenHash: hashToken(secret),
        expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
        lastUsedAt: now,
        userAgent: userAgentOf(input.userAgent),
        ip: input.ip,
      },
    });
    return { session, refreshToken: `${session.id}.${secret}`, replacedSessionIds };
  }

  /** The session if it exists, is not revoked and has not expired. */
  async findActive(sessionId: string, now = new Date()): Promise<Session | null> {
    const session = await this.platform.session.findUnique({ where: { id: sessionId } });
    if (session?.revokedAt !== null || session.expiresAt <= now) {
      return null;
    }
    return session;
  }

  /** The active session a refresh token points to, without rotating it (logout). */
  async findByRefreshToken(
    area: AuthArea,
    refreshToken: string,
    now = new Date(),
  ): Promise<Session | null> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) {
      return null;
    }
    const session = await this.findActive(parsed.sessionId, now);
    if (!session || !AREA_SUBJECTS[area].includes(session.subjectType)) {
      return null;
    }
    return sameHash(hashToken(parsed.secret), session.refreshTokenHash) ? session : null;
  }

  /**
   * Rotates a refresh token (spec 01, section 7.2). Presenting the token replaced by the last
   * rotation, after {@link REFRESH_REUSE_GRACE_MS}, means it was copied: the session is revoked.
   */
  async rotate(
    area: AuthArea,
    refreshToken: string,
    client: ClientInfo,
    now = new Date(),
  ): Promise<RotationResult> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) {
      return { kind: 'invalid' };
    }
    const session = await this.findActive(parsed.sessionId, now);
    if (!session || !AREA_SUBJECTS[area].includes(session.subjectType)) {
      return { kind: 'invalid' };
    }
    // The cookie is bound to the device that logged in.
    if (client.deviceId !== null && client.deviceId !== session.deviceId) {
      return { kind: 'invalid' };
    }

    const presented = hashToken(parsed.secret);
    if (sameHash(presented, session.refreshTokenHash)) {
      const secret = randomToken();
      const [updated] = await this.platform.session.updateManyAndReturn({
        // Only one of two concurrent rotations of the same token wins.
        where: { id: session.id, refreshTokenHash: session.refreshTokenHash, revokedAt: null },
        data: {
          refreshTokenHash: hashToken(secret),
          previousRefreshTokenHash: session.refreshTokenHash,
          refreshedAt: now,
          lastUsedAt: now,
          expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
          userAgent: userAgentOf(client.userAgent),
          ip: client.ip,
        },
      });
      return updated
        ? { kind: 'rotated', session: updated, refreshToken: `${updated.id}.${secret}` }
        : { kind: 'invalid' };
    }

    const previous = session.previousRefreshTokenHash;
    if (previous !== null && sameHash(presented, previous)) {
      const sinceRotation = now.getTime() - (session.refreshedAt?.getTime() ?? 0);
      if (sinceRotation < REFRESH_REUSE_GRACE_MS) {
        return { kind: 'invalid' };
      }
      await this.platform.$transaction(async (tx) => {
        await this.revokeWhere(
          tx,
          { id: session.id },
          'refresh_token_reused',
          now,
          session.organizationId,
        );
      });
      this.events.sessionsRevoked({
        subjectType: session.subjectType,
        subjectId: session.subjectId,
        sessionIds: [session.id],
        reason: 'refresh_token_reused',
      });
      return { kind: 'reused', session };
    }
    return { kind: 'invalid' };
  }

  /** Ends one session (logout). Returns false when it was already ended. */
  async revoke(
    tx: AuthDb,
    session: Session,
    reason: SessionRevocationReason,
    now = new Date(),
  ): Promise<boolean> {
    const ids = await this.revokeWhere(tx, { id: session.id }, reason, now, session.organizationId);
    return ids.length > 0;
  }

  /**
   * Ends every active session of a subject: password change or reset (spec 01, section 7.2) and
   * deactivation of a staff member (RN-03.17). Writes the audit row in `tx`; the caller emits
   * {@link AuthEvents.sessionsRevoked} after the transaction commits.
   */
  async revokeAllForSubject(
    tx: AuthDb,
    subject: { subjectType: SubjectType; subjectId: string; organizationId: string | null },
    reason: SessionRevocationReason,
    now = new Date(),
  ): Promise<string[]> {
    return this.revokeWhere(
      tx,
      { subjectType: subject.subjectType, subjectId: subject.subjectId },
      reason,
      now,
      subject.organizationId,
    );
  }

  private async revokeWhere(
    tx: AuthDb,
    where: {
      id?: string;
      subjectType?: SubjectType;
      subjectId?: string;
      deviceId?: string;
      impersonationId?: null;
    },
    reason: SessionRevocationReason,
    now: Date,
    organizationId?: string | null,
  ): Promise<string[]> {
    const revoked = await tx.session.updateManyAndReturn({
      where: { ...where, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now, revokedReason: reason },
      select: { id: true, subjectType: true, subjectId: true, organizationId: true },
    });
    const first = revoked[0];
    if (first === undefined || reason === 'logout') {
      // Logout has its own audit action (auth.logout), written by the caller.
      return revoked.map((row) => row.id);
    }
    await this.audit.record(tx, {
      action: 'auth.sessions_revoked',
      entityType: entityTypeOf(first.subjectType),
      entityId: first.subjectId,
      organizationId: organizationId === undefined ? first.organizationId : organizationId,
      metadata: { reason, sessionIds: revoked.map((row) => row.id) },
    });
    return revoked.map((row) => row.id);
  }
}
