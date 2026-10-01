import { EventEmitter } from 'node:events';

import { Injectable, Logger } from '@nestjs/common';

import type { SubjectType } from '../generated/prisma/enums.js';

/**
 * Why sessions were ended. Stored in `sessions.revoked_reason` and in the audit log, and sent to the
 * app in the real-time event `session.revoked` (`EventSessionRevoked`).
 */
export const SESSION_REVOCATION_REASONS = [
  'logout',
  'password_changed',
  'password_reset',
  'refresh_token_reused',
  'new_login_on_device',
  'staff_deactivated',
  /** The owner removed every unit of the staff member (RN-03.16: without a unit there is no login). */
  'staff_access_removed',
  'subject_deactivated',
] as const;

export type SessionRevocationReason = (typeof SESSION_REVOCATION_REASONS)[number];

/** Internal event `auth.sessions_revoked`, emitted after the revocation committed. */
export interface SessionsRevokedEvent {
  subjectType: SubjectType;
  subjectId: string;
  sessionIds: string[];
  reason: SessionRevocationReason;
}

export const SESSIONS_REVOKED = 'auth.sessions_revoked';

/**
 * In-process events of the authentication.
 *
 * The real-time module (src/realtime) subscribes to {@link SESSIONS_REVOKED} and disconnects the
 * sockets of those sessions right away (CA-01.05: "o WebSocket é desconectado").
 * HTTP requests already stop working at once, because the guard checks the session on every request.
 */
@Injectable()
export class AuthEvents {
  private readonly emitter = new EventEmitter();
  private readonly logger = new Logger('AuthEvents');

  onSessionsRevoked(listener: (event: SessionsRevokedEvent) => void): () => void {
    this.emitter.on(SESSIONS_REVOKED, listener);
    return () => this.emitter.off(SESSIONS_REVOKED, listener);
  }

  /** Call only after the transaction that revoked the sessions committed. */
  sessionsRevoked(event: SessionsRevokedEvent): void {
    if (event.sessionIds.length === 0) {
      return;
    }
    try {
      this.emitter.emit(SESSIONS_REVOKED, event);
    } catch (error) {
      // A failing listener must not fail the request that already committed.
      this.logger.error(
        `listener of ${SESSIONS_REVOKED} failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
