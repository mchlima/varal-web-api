import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { type AuthContext, getRequestContext, setAuthContext } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import type { Session } from '../generated/prisma/client.js';
import type { SubjectType } from '../generated/prisma/enums.js';
import { PlatformPrismaService } from '../prisma/platform-prisma.service.js';
import {
  type AccessTokenClaims,
  AccessTokenService,
  type IssuedAccessToken,
} from './access-token.service.js';
import type { AuthDb } from './auth-db.js';
import { AREA_SUBJECTS, type AuthArea } from './auth-area.js';
import { authError } from './auth-errors.js';
import { AuthEvents, type SessionRevocationReason } from './auth-events.js';
import { type ActiveImpersonation, ImpersonationService } from './impersonation.service.js';
import {
  LoginThrottleService,
  type LoginIdentifier,
  throttleKey,
} from './login-throttle.service.js';
import { hashPassword, needsRehash, verifyPassword } from './password-hasher.js';
import { PasswordTokenService } from './password-token.service.js';
import { type ClientInfo, SessionService } from './session.service.js';
import { entityTypeOf } from './subjects.js';

export interface IssuedSession {
  session: Session;
  accessToken: IssuedAccessToken;
  refreshToken: string;
}

export interface AuthenticatedRequest {
  claims: AccessTokenClaims & { expiresAt: Date };
  session: Session;
  /** The "entrar como" behind a panel session (spec 02, section 7), or null. */
  impersonation: ActiveImpersonation | null;
}

/** A subject that may log in, as loaded for a login. */
interface LoginSubject {
  subjectType: SubjectType;
  id: string;
  organizationId: string | null;
  passwordHash: string | null;
  active: boolean;
}

export interface Subject {
  subjectType: SubjectType;
  subjectId: string;
  organizationId: string | null;
}

/**
 * Login, sessions and passwords of the three profiles (spec 01, section 7).
 *
 * Decisions (documented in the README):
 * - Wrong password, unknown user, inactive user and user without a password give the same error,
 *   after the same argon2 work.
 * - Organizations `suspended` or `canceled` can still log in: RN-01.01 only blocks opening cash registers.
 * - Failed logins are not written to `audit_logs` (insert-only, it would grow with garbage from
 *   unknown identifiers); they feed the per-identifier lock and the lock is logged.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly platform: PlatformPrismaService,
    private readonly tokens: AccessTokenService,
    private readonly sessions: SessionService,
    private readonly throttle: LoginThrottleService,
    private readonly passwordTokens: PasswordTokenService,
    private readonly audit: AuditService,
    private readonly events: AuthEvents,
    private readonly impersonations: ImpersonationService,
  ) {}

  // ------------------------------------------------------------------------------------------
  // Login
  // ------------------------------------------------------------------------------------------

  /** Owner: e-mail and password (spec 01, section 7.1). */
  async loginOwner(email: string, password: string, client: ClientInfo): Promise<IssuedSession> {
    const normalized = email.trim().toLowerCase();
    return this.login(
      { kind: 'owner', email: normalized },
      'INVALID_CREDENTIALS',
      async () => {
        const user = await this.platform.user.findUnique({ where: { email: normalized } });
        return user && { subjectType: 'owner', ...user };
      },
      password,
      client,
    );
  }

  /** Staff: establishment code, username and password (spec 01, section 7.1; CA-01.03). */
  async loginStaff(
    accessCode: string,
    username: string,
    password: string,
    client: ClientInfo,
  ): Promise<IssuedSession> {
    const code = accessCode.trim().toUpperCase();
    const name = username.trim();
    return this.login(
      { kind: 'staff', accessCode: code, username: name },
      'INVALID_STAFF_CREDENTIALS',
      async () => {
        // Unique by (organization_id, lower(username)): an expression index.
        const staff = await this.platform.staffMember.findFirst({
          where: {
            organization: { accessCode: code },
            username: { equals: name, mode: 'insensitive' },
          },
        });
        return staff && { subjectType: 'staff', ...staff };
      },
      password,
      client,
      async (subject) => {
        // RN-03.16: without an active unit the staff member cannot log in. Checked only after the
        // password, so it never reveals whether a username exists.
        const units = await this.platform.staffUnitPermission.count({
          where: { staffMemberId: subject.id, unit: { active: true } },
        });
        if (units === 0) {
          throw authError('STAFF_WITHOUT_UNIT');
        }
      },
    );
  }

  /** Platform admin: e-mail and password, in the admin context (CA-01.04). */
  async loginAdmin(email: string, password: string, client: ClientInfo): Promise<IssuedSession> {
    const normalized = email.trim().toLowerCase();
    const issued = await this.login(
      { kind: 'platform_admin', email: normalized },
      'INVALID_CREDENTIALS',
      async () => {
        const admin = await this.platform.platformAdmin.findUnique({
          where: { email: normalized },
        });
        return admin && { subjectType: 'platform_admin', organizationId: null, ...admin };
      },
      password,
      client,
    );
    await this.platform.platformAdmin.update({
      where: { id: issued.session.subjectId },
      data: { lastLoginAt: issued.session.createdAt },
    });
    return issued;
  }

  private async login(
    identifier: LoginIdentifier,
    invalidCode: 'INVALID_CREDENTIALS' | 'INVALID_STAFF_CREDENTIALS',
    find: () => Promise<LoginSubject | null>,
    password: string,
    client: ClientInfo,
    authorize?: (subject: LoginSubject) => Promise<void>,
  ): Promise<IssuedSession> {
    const deviceId = client.deviceId;
    if (deviceId === null) {
      throw authError('DEVICE_ID_REQUIRED');
    }
    const key = throttleKey(identifier);
    await this.throttle.assertNotLocked(key);

    const subject = await find();
    const usable = subject?.active === true ? subject : null;
    const valid = await verifyPassword(usable?.passwordHash ?? null, password);
    if (!valid || usable?.passwordHash == null) {
      await this.throttle.registerFailure(key);
      throw authError(invalidCode);
    }
    await this.throttle.reset(key);
    await authorize?.(usable);

    const area: AuthArea = usable.subjectType === 'platform_admin' ? 'admin' : 'panel';
    const subjectRef: Subject = {
      subjectType: usable.subjectType,
      subjectId: usable.id,
      organizationId: usable.organizationId,
    };
    // The login route is public: from here on the request acts as the subject (audit actor).
    this.actAs(subjectRef, null);

    const { session, refreshToken, replacedSessionIds } = await this.platform.$transaction(
      async (tx) => {
        if (needsRehash(usable.passwordHash ?? '')) {
          await this.updatePasswordHash(tx, subjectRef, await hashPassword(password));
        }
        const created = await this.sessions.create(tx, {
          ...subjectRef,
          deviceId,
          userAgent: client.userAgent,
          ip: client.ip,
        });
        await this.audit.record(tx, {
          action: 'auth.login',
          entityType: 'session',
          entityId: created.session.id,
          organizationId: subjectRef.organizationId,
          metadata: { subjectType: subjectRef.subjectType },
        });
        return created;
      },
    );
    this.notifyRevoked(subjectRef, replacedSessionIds, 'new_login_on_device');
    const accessToken = await this.tokens.issue(area, this.claimsOf(session));
    return { session, accessToken, refreshToken };
  }

  // ------------------------------------------------------------------------------------------
  // Session
  // ------------------------------------------------------------------------------------------

  /**
   * Validates an access token of `area` and its session. The session row is read on every request
   * (one primary-key lookup), so logout, password change and deactivation cut access at once
   * instead of waiting up to 15 minutes for the token to expire.
   */
  async authenticate(area: AuthArea, accessToken: string): Promise<AuthenticatedRequest | null> {
    const claims = await this.tokens.verify(area, accessToken);
    if (!claims) {
      return null;
    }
    const session = await this.sessions.findActive(claims.sessionId);
    if (
      session?.subjectType !== claims.subjectType ||
      session.subjectId !== claims.subjectId ||
      session.organizationId !== claims.organizationId
    ) {
      return null;
    }
    if (session.impersonationId === null) {
      return { claims, session, impersonation: null };
    }
    // An "entrar como" session stops as soon as the admin ends it (CA-02.08).
    const impersonation = await this.impersonations.findActive(session.impersonationId);
    if (impersonation?.organizationId !== session.organizationId) {
      return null;
    }
    return { claims, session, impersonation };
  }

  /** Rotates the refresh token (spec 01, section 7.2) and issues a new access token. */
  async refresh(area: AuthArea, refreshToken: string, client: ClientInfo): Promise<IssuedSession> {
    const result = await this.sessions.rotate(area, refreshToken, client);
    if (result.kind !== 'rotated') {
      throw AppError.of('UNAUTHENTICATED');
    }
    const accessToken = await this.tokens.issue(area, this.claimsOf(result.session), new Date());
    return { session: result.session, accessToken, refreshToken: result.refreshToken };
  }

  /**
   * Ends the session of this device (spec 01, section 7.2). Works with the access token or, when it
   * already expired, with the refresh token. Without a valid session it does nothing.
   */
  async logout(
    area: AuthArea,
    cookies: { accessToken?: string; refreshToken?: string },
  ): Promise<void> {
    let session: Session | null = null;
    if (cookies.accessToken) {
      session = (await this.authenticate(area, cookies.accessToken))?.session ?? null;
    }
    if (!session && cookies.refreshToken) {
      session = await this.sessions.findByRefreshToken(area, cookies.refreshToken);
    }
    if (!session) {
      return;
    }
    const found = session;
    const subject = {
      subjectType: found.subjectType,
      subjectId: found.subjectId,
      organizationId: found.organizationId,
    };
    this.actAs(subject, found.id);
    const { revoked, impersonationEnded } = await this.platform.$transaction(async (tx) => {
      const ended = await this.sessions.revoke(tx, found, 'logout');
      if (ended) {
        await this.audit.record(tx, {
          action: 'auth.logout',
          entityType: 'session',
          entityId: found.id,
          organizationId: found.organizationId,
        });
      }
      // "Encerrar acesso" in the panel (RN-02.19) is the logout of the "entrar como" session: it
      // ends the impersonation too.
      const impersonation =
        found.impersonationId === null
          ? null
          : await this.impersonations.end(tx, found.impersonationId, new Date(), {
              via: 'panel_logout',
            });
      return { revoked: ended, impersonationEnded: impersonation };
    });
    if (revoked) {
      this.notifyRevoked(subject, [found.id], 'logout');
    }
    impersonationEnded?.notify();
  }

  // ------------------------------------------------------------------------------------------
  // Passwords
  // ------------------------------------------------------------------------------------------

  /**
   * Logged-in password change. Ends every session of the subject (spec 01, section 7.2), including
   * this one, and opens a new session for this device so the user stays logged in here.
   */
  async changePassword(
    area: AuthArea,
    currentPassword: string,
    newPassword: string,
    client: ClientInfo,
  ): Promise<IssuedSession> {
    const auth = this.requireAuth();
    if (auth.impersonatorId) {
      // The Varal team never changes the owner's password in an "entrar como" (spec 02, section 7).
      throw authError('NOT_ALLOWED_DURING_IMPERSONATION');
    }
    const subject: Subject = {
      subjectType: auth.actor.type as SubjectType,
      subjectId: auth.actor.id ?? '',
      organizationId: auth.organizationId,
    };
    const session = auth.sessionId ? await this.sessions.findActive(auth.sessionId) : null;
    if (!session) {
      throw AppError.of('UNAUTHENTICATED');
    }
    const currentHash = await this.passwordHashOf(this.platform, subject);
    if (!(await verifyPassword(currentHash, currentPassword))) {
      throw authError('WRONG_CURRENT_PASSWORD');
    }
    const newHash = await hashPassword(newPassword);
    const { created, revokedIds } = await this.platform.$transaction(async (tx) => {
      await this.updatePasswordHash(tx, subject, newHash);
      const ids = await this.sessions.revokeAllForSubject(tx, subject, 'password_changed');
      const opened = await this.sessions.create(tx, {
        ...subject,
        deviceId: session.deviceId,
        userAgent: client.userAgent,
        ip: client.ip,
      });
      await this.audit.record(tx, {
        action: 'auth.password_changed',
        entityType: entityTypeOf(subject.subjectType),
        entityId: subject.subjectId,
        organizationId: subject.organizationId,
        metadata: { revokedSessions: ids.length },
      });
      return { created: opened, revokedIds: ids };
    });
    this.notifyRevoked(subject, revokedIds, 'password_changed');
    const accessToken = await this.tokens.issue(area, this.claimsOf(created.session));
    return { session: created.session, accessToken, refreshToken: created.refreshToken };
  }

  /**
   * Defines a password with an invite or reset token (spec 01, section 7.4). Ends every session of
   * the subject (CA-01.05) and clears a login lock of the identifier.
   */
  async resetPassword(area: AuthArea, token: string, newPassword: string): Promise<void> {
    const newHash = await hashPassword(newPassword);
    const result = await this.platform.$transaction(async (tx) => {
      const consumed = await this.passwordTokens.consume(tx, token, AREA_SUBJECTS[area]);
      if (!consumed) {
        throw authError('INVALID_PASSWORD_TOKEN');
      }
      const subject = await this.loadSubjectForReset(tx, consumed.subjectType, consumed.subjectId);
      if (!subject) {
        throw authError('INVALID_PASSWORD_TOKEN');
      }
      this.actAs(subject, null);
      await this.updatePasswordHash(tx, subject, newHash, { verifyEmail: true });
      const reason: SessionRevocationReason = 'password_reset';
      const revokedIds = await this.sessions.revokeAllForSubject(tx, subject, reason);
      await this.audit.record(tx, {
        action: consumed.purpose === 'invite' ? 'auth.invite_accepted' : 'auth.password_reset',
        entityType: entityTypeOf(subject.subjectType),
        entityId: subject.subjectId,
        organizationId: subject.organizationId,
        metadata: { revokedSessions: revokedIds.length },
      });
      return { subject, revokedIds };
    });
    this.notifyRevoked(result.subject, result.revokedIds, 'password_reset');
    await this.throttle.reset(throttleKey(result.subject.identifier));
  }

  /**
   * Ends every session of a subject, e.g. when the owner deactivates a staff member (RN-03.17).
   * Runs in the transaction of that action; emits `auth.sessions_revoked` once it commits.
   */
  async revokeSessionsInTransaction(
    tx: AuthDb,
    subject: Subject,
    reason: SessionRevocationReason,
  ): Promise<{ sessionIds: string[]; notify: () => void }> {
    const sessionIds = await this.sessions.revokeAllForSubject(tx, subject, reason);
    return {
      sessionIds,
      notify: () => {
        this.notifyRevoked(subject, sessionIds, reason);
      },
    };
  }

  // ------------------------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------------------------

  claimsOf(session: Session): AccessTokenClaims {
    return {
      subjectId: session.subjectId,
      subjectType: session.subjectType,
      sessionId: session.id,
      organizationId: session.organizationId,
    };
  }

  private requireAuth(): AuthContext {
    const auth = getRequestContext()?.auth;
    if (!auth?.actor.id) {
      throw AppError.of('UNAUTHENTICATED');
    }
    return auth;
  }

  /** Makes the rest of a public request (login, logout, reset) act as `subject` (audit actor). */
  private actAs(subject: Subject, sessionId: string | null): void {
    if (getRequestContext()?.auth) {
      return;
    }
    setAuthContext({
      organizationId: subject.organizationId,
      actor: { type: subject.subjectType, id: subject.subjectId },
      sessionId,
    });
  }

  private notifyRevoked(
    subject: Subject,
    sessionIds: string[],
    reason: SessionRevocationReason,
  ): void {
    this.events.sessionsRevoked({
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      sessionIds,
      reason,
    });
  }

  private async passwordHashOf(db: AuthDb, subject: Subject): Promise<string | null> {
    const select = { passwordHash: true } as const;
    switch (subject.subjectType) {
      case 'owner':
        return (
          (await db.user.findUnique({ where: { id: subject.subjectId }, select }))?.passwordHash ??
          null
        );
      case 'staff':
        return (
          (await db.staffMember.findUnique({ where: { id: subject.subjectId }, select }))
            ?.passwordHash ?? null
        );
      case 'platform_admin':
        return (
          (await db.platformAdmin.findUnique({ where: { id: subject.subjectId }, select }))
            ?.passwordHash ?? null
        );
    }
  }

  private async updatePasswordHash(
    db: AuthDb,
    subject: Subject,
    passwordHash: string,
    options: { verifyEmail?: boolean } = {},
  ): Promise<void> {
    const where = { id: subject.subjectId };
    switch (subject.subjectType) {
      case 'owner': {
        // Accepting an invite or a reset link proves the e-mail (spec 01, section 12).
        const verified = options.verifyEmail
          ? await db.user.findUnique({ where, select: { emailVerifiedAt: true } })
          : null;
        await db.user.update({
          where,
          data: {
            passwordHash,
            ...(options.verifyEmail && verified?.emailVerifiedAt === null
              ? { emailVerifiedAt: new Date() }
              : {}),
          },
        });
        return;
      }
      case 'staff':
        await db.staffMember.update({ where, data: { passwordHash } });
        return;
      case 'platform_admin':
        await db.platformAdmin.update({ where, data: { passwordHash } });
        return;
    }
  }

  /** The active subject of a token, with its login identifier (to clear a lock after the reset). */
  private async loadSubjectForReset(
    db: AuthDb,
    subjectType: SubjectType,
    subjectId: string,
  ): Promise<(Subject & { identifier: LoginIdentifier }) | null> {
    switch (subjectType) {
      case 'owner': {
        const user = await db.user.findUnique({ where: { id: subjectId } });
        return user?.active
          ? {
              subjectType,
              subjectId,
              organizationId: user.organizationId,
              identifier: { kind: 'owner', email: user.email },
            }
          : null;
      }
      case 'staff': {
        const staff = await db.staffMember.findUnique({
          where: { id: subjectId },
          include: { organization: { select: { accessCode: true } } },
        });
        return staff?.active
          ? {
              subjectType,
              subjectId,
              organizationId: staff.organizationId,
              identifier: {
                kind: 'staff',
                accessCode: staff.organization.accessCode,
                username: staff.username,
              },
            }
          : null;
      }
      case 'platform_admin': {
        const admin = await db.platformAdmin.findUnique({ where: { id: subjectId } });
        return admin?.active
          ? {
              subjectType,
              subjectId,
              organizationId: null,
              identifier: { kind: 'platform_admin', email: admin.email },
            }
          : null;
      }
    }
  }
}
