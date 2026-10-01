import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { getRequestContext, setAuthContext } from '../context/request-context.js';
import type { ImpersonationEndedBy } from '../generated/prisma/enums.js';
import { PlatformPrismaService } from '../prisma/platform-prisma.service.js';
import { AccessTokenService } from './access-token.service.js';
import type { AuthDb } from './auth-db.js';
import { authError } from './auth-errors.js';
import { AuthEvents } from './auth-events.js';
import type { IssuedSession } from './auth.service.js';
import { hashToken } from './secure-token.js';
import { type ClientInfo, SessionService } from './session.service.js';

/** RN-02.17 / CA-02.08: an "entrar como" lasts 60 minutes. */
export const IMPERSONATION_TTL_MS = 60 * 60 * 1000;
/** The one-time link that opens the panel is valid for 2 minutes after it is issued. */
export const IMPERSONATION_HANDOFF_TTL_MS = 2 * 60 * 1000;

/** What the guard keeps of the "entrar como" behind a panel session. */
export interface ActiveImpersonation {
  id: string;
  platformAdminId: string;
  organizationId: string;
  expiresAt: Date;
}

export interface EndedImpersonation {
  ended: boolean;
  /** Call after the transaction committed: disconnects the sockets of the ended sessions. */
  notify: () => void;
}

/**
 * Panel side of the "entrar como" (spec 02, section 7). The admin side (start, list, end) is in
 * src/admin/impersonation; both share the rules here.
 *
 * Flow (RN-02.21; the cookies of the API host are distinguished by name, spec 01, section 4):
 * 1. `POST /admin/impersonations` (admin, `impersonation:use`) records the impersonation (60 min) and
 *    returns a one-time link `{PANEL_URL}/entrar-como#token=...` (2 min, only the hash stored, the
 *    token in the fragment never reaches servers or logs).
 * 2. The admin app opens the link in a new tab of the panel. The panel sends the token to
 *    `POST /auth/impersonation` with its own `X-Device-Id`. The browser also sends the admin's
 *    access cookie (same API host): the API requires the admin session of the SAME admin that
 *    started the impersonation, so a leaked link is useless in another browser.
 * 3. The API opens a panel session for the owner (subject `owner`, `sessions.impersonation_id`),
 *    ending with the impersonation, and sets the panel cookies. Every request of that session gets
 *    `impersonatorId` and `impersonationId` in the context, so the audit records the admin
 *    (RN-02.20).
 */
@Injectable()
export class ImpersonationService {
  constructor(
    private readonly platform: PlatformPrismaService,
    private readonly sessions: SessionService,
    private readonly tokens: AccessTokenService,
    private readonly audit: AuditService,
    private readonly events: AuthEvents,
  ) {}

  /** The impersonation of a session, or null when it ended or expired (the session stops). */
  async findActive(id: string, now = new Date()): Promise<ActiveImpersonation | null> {
    const row = await this.platform.impersonationSession.findUnique({
      where: { id },
      select: {
        id: true,
        platformAdminId: true,
        organizationId: true,
        expiresAt: true,
        endedAt: true,
      },
    });
    if (row?.endedAt !== null || row.expiresAt <= now) {
      return null;
    }
    return {
      id: row.id,
      platformAdminId: row.platformAdminId,
      organizationId: row.organizationId,
      expiresAt: row.expiresAt,
    };
  }

  /**
   * Exchanges the one-time link for the panel session (step 3 above). `adminAccessToken` is the
   * admin's access cookie, sent by the same browser. Errors: `UNAUTHENTICATED` without that admin
   * session, `INVALID_IMPERSONATION_TOKEN` for a used, expired or someone else's link.
   */
  async openPanelSession(
    handoffToken: string,
    admin: { platformAdminId: string },
    client: ClientInfo & { deviceId: string },
    now = new Date(),
  ): Promise<IssuedSession> {
    const tokenHash = hashToken(handoffToken);
    const issued = await this.platform.$transaction(async (tx) => {
      const [impersonation] = await tx.impersonationSession.updateManyAndReturn({
        where: {
          handoffTokenHash: tokenHash,
          handoffUsedAt: null,
          handoffExpiresAt: { gt: now },
          platformAdminId: admin.platformAdminId,
          endedAt: null,
          expiresAt: { gt: now },
        },
        data: { handoffUsedAt: now, handoffTokenHash: null },
      });
      if (!impersonation) {
        throw authError('INVALID_IMPERSONATION_TOKEN');
      }
      const owner = await tx.user.findUnique({ where: { id: impersonation.ownerId } });
      if (owner?.active !== true || owner.organizationId !== impersonation.organizationId) {
        throw authError('INVALID_IMPERSONATION_TOKEN');
      }
      // The exchange route is public: from here on the request acts as the owner, on behalf of
      // the admin (RN-02.20).
      if (!getRequestContext()?.auth) {
        setAuthContext({
          organizationId: impersonation.organizationId,
          actor: { type: 'owner', id: owner.id },
          impersonatorId: impersonation.platformAdminId,
          impersonationId: impersonation.id,
          sessionId: null,
        });
      }
      const created = await this.sessions.createForImpersonation(
        tx,
        {
          subjectType: 'owner',
          subjectId: owner.id,
          organizationId: impersonation.organizationId,
          deviceId: client.deviceId,
          userAgent: client.userAgent,
          ip: client.ip,
          impersonationId: impersonation.id,
          expiresAt: impersonation.expiresAt,
        },
        now,
      );
      await this.audit.record(tx, {
        action: 'impersonation.session_opened',
        entityType: 'session',
        entityId: created.session.id,
        organizationId: impersonation.organizationId,
        metadata: { impersonationId: impersonation.id },
      });
      return created;
    });
    const accessToken = await this.tokens.issue(
      'panel',
      {
        subjectId: issued.session.subjectId,
        subjectType: issued.session.subjectType,
        sessionId: issued.session.id,
        organizationId: issued.session.organizationId,
      },
      now,
      issued.session.expiresAt,
    );
    return { session: issued.session, accessToken, refreshToken: issued.refreshToken };
  }

  /**
   * Ends an impersonation in `tx` (the admin, the "Encerrar acesso" of the panel, or the expiry
   * job) and every panel session of it. Returns `ended: false` when it was already over.
   */
  async end(
    tx: AuthDb,
    impersonationId: string,
    endedBy: ImpersonationEndedBy,
    now = new Date(),
    metadata: Record<string, unknown> = {},
  ): Promise<EndedImpersonation> {
    const current = await tx.impersonationSession.findUnique({ where: { id: impersonationId } });
    if (current?.endedAt !== null) {
      return { ended: false, notify: () => undefined };
    }
    // An expired one ends at its own deadline, whenever the job notices it.
    const endedAt = endedBy === 'expired' && current.expiresAt < now ? current.expiresAt : now;
    const [ended] = await tx.impersonationSession.updateManyAndReturn({
      where: { id: impersonationId, endedAt: null },
      data: { endedAt, endedBy },
    });
    if (!ended) {
      return { ended: false, notify: () => undefined };
    }
    const sessionIds = await this.sessions.revokeForImpersonation(
      tx,
      ended.id,
      ended.organizationId,
      now,
    );
    await this.audit.record(tx, {
      action: endedBy === 'expired' ? 'impersonation.expired' : 'impersonation.ended',
      entityType: 'impersonation_session',
      entityId: ended.id,
      organizationId: ended.organizationId,
      after: { endedAt: endedAt.toISOString(), endedBy },
      metadata,
    });
    return {
      ended: true,
      notify: () => {
        this.events.sessionsRevoked({
          subjectType: 'owner',
          subjectId: ended.ownerId,
          sessionIds,
          reason: 'impersonation_ended',
        });
      },
    };
  }
}
