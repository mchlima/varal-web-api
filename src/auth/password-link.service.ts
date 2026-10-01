import { setTimeout as sleep } from 'node:timers/promises';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { EmailService } from '../email/email.service.js';
import { AppError } from '../errors/app-error.js';
import type { EmailType, PasswordTokenPurpose, SubjectType } from '../generated/prisma/enums.js';
import { PlatformPrismaService } from '../prisma/platform-prisma.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthDb } from './auth-db.js';
import { PasswordTokenService } from './password-token.service.js';
import { entityTypeOf } from './subjects.js';

/** RN-01.03: "Esqueci a senha" takes at least this long, whether or not the e-mail exists. */
export const FORGOT_MIN_DURATION_MS = 400;

export interface IssuedLink {
  link: string;
  expiresAt: Date;
  /** Null when no e-mail was queued (no address, or not requested). */
  emailLogId: string | null;
}

interface LinkTarget {
  subjectType: SubjectType;
  subjectId: string;
  organizationId: string | null;
  recipientName: string;
  organizationName: string | null;
  email: string | null;
}

/**
 * Invite and reset links (spec 01, section 7.4) with their e-mails (section 9). The link carries the
 * token in the URL fragment (`#token=`), which browsers never send to servers, so it stays out of
 * access logs and `Referer` headers. Front route: `/definir-senha` in both apps.
 *
 * Entry points:
 * - {@link issueOwnerInvite}: the platform admin creating an organization (spec 02, phase 3).
 * - {@link requestOwnerPasswordReset}: "Esqueci a senha" of the owner (RN-01.03).
 * - {@link issueStaffPasswordReset}: the owner resetting a staff member (RN-03.18, endpoint in spec 03).
 * - {@link issueAdminInvite} and {@link requestAdminPasswordReset}: admin users (spec 02).
 */
@Injectable()
export class PasswordLinkService {
  private readonly logger = new Logger('PasswordLinks');

  constructor(
    @Inject(APP_ENV) private readonly env: Env,
    private readonly platform: PlatformPrismaService,
    private readonly prisma: PrismaService,
    private readonly tokens: PasswordTokenService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
  ) {}

  /** Owner invite, in the transaction that creates the organization (RN-02.09). */
  async issueOwnerInvite(tx: AuthDb, ownerId: string): Promise<IssuedLink> {
    const owner = await tx.user.findUniqueOrThrow({
      where: { id: ownerId },
      include: { organization: { select: { name: true } } },
    });
    return this.issue(
      tx,
      {
        subjectType: 'owner',
        subjectId: owner.id,
        organizationId: owner.organizationId,
        recipientName: owner.name,
        organizationName: owner.organization.name,
        email: owner.email,
      },
      'invite',
      'owner_invite',
    );
  }

  /** "Esqueci a senha" of the owner. Same answer and similar time whether or not the e-mail exists. */
  async requestOwnerPasswordReset(email: string): Promise<void> {
    await this.withMinimumDuration(async () => {
      const owner = await this.platform.user.findUnique({
        where: { email: email.trim().toLowerCase() },
        include: { organization: { select: { name: true } } },
      });
      if (!owner?.active) {
        return;
      }
      await this.silently(() =>
        this.platform.$transaction((tx) =>
          this.issue(
            tx,
            {
              subjectType: 'owner',
              subjectId: owner.id,
              organizationId: owner.organizationId,
              recipientName: owner.name,
              organizationName: owner.organization.name,
              email: owner.email,
            },
            'reset',
            'owner_password_reset',
          ),
        ),
      );
    });
  }

  /**
   * Reset of a staff member by the owner (RN-03.18): returns the link to copy or send by WhatsApp,
   * and also e-mails it when asked and the staff member has an address. Must run in the owner's
   * request: the staff member is looked up through the tenant client, so another organization's id
   * is a 404. RN-01.02 applies (429 after 3 links in an hour).
   */
  async issueStaffPasswordReset(
    staffMemberId: string,
    options: { sendEmail: boolean },
  ): Promise<IssuedLink> {
    const staff = await this.prisma.db.staffMember.findUnique({
      where: { id: staffMemberId },
      include: { organization: { select: { name: true } } },
    });
    if (!staff) {
      throw AppError.of('NOT_FOUND');
    }
    return this.platform.$transaction((tx) =>
      this.issue(
        tx,
        {
          subjectType: 'staff',
          subjectId: staff.id,
          organizationId: staff.organizationId,
          recipientName: staff.name,
          organizationName: staff.organization.name,
          email: options.sendEmail ? staff.email : null,
        },
        'reset',
        'staff_password_reset',
      ),
    );
  }

  /** Invite of a platform admin (spec 02, `POST /admin/users`), in the transaction that creates it. */
  async issueAdminInvite(tx: AuthDb, platformAdminId: string): Promise<IssuedLink> {
    const admin = await tx.platformAdmin.findUniqueOrThrow({ where: { id: platformAdminId } });
    return this.issue(
      tx,
      {
        subjectType: 'platform_admin',
        subjectId: admin.id,
        organizationId: null,
        recipientName: admin.name,
        organizationName: null,
        email: admin.email,
      },
      'invite',
      'admin_invite',
    );
  }

  /** "Esqueci a senha" of the admin, with the same guarantees as the owner's (RN-01.03). */
  async requestAdminPasswordReset(email: string): Promise<void> {
    await this.withMinimumDuration(async () => {
      const admin = await this.platform.platformAdmin.findUnique({
        where: { email: email.trim().toLowerCase() },
      });
      if (!admin?.active) {
        return;
      }
      await this.silently(() =>
        this.platform.$transaction((tx) =>
          this.issue(
            tx,
            {
              subjectType: 'platform_admin',
              subjectId: admin.id,
              organizationId: null,
              recipientName: admin.name,
              organizationName: null,
              email: admin.email,
            },
            'reset',
            'admin_password_reset',
          ),
        ),
      );
    });
  }

  private async issue(
    tx: AuthDb,
    target: LinkTarget,
    purpose: PasswordTokenPurpose,
    emailType: EmailType,
  ): Promise<IssuedLink> {
    const { token, expiresAt } = await this.tokens.issue(
      tx,
      { subjectType: target.subjectType, subjectId: target.subjectId },
      purpose,
    );
    const base = target.subjectType === 'platform_admin' ? this.env.ADMIN_URL : this.env.PANEL_URL;
    const kind = purpose === 'invite' ? 'convite' : 'redefinicao';
    const link = `${base}/definir-senha#token=${token}&tipo=${kind}`;

    let emailLogId: string | null = null;
    if (target.email) {
      const queued = await this.email.enqueue(
        tx,
        {
          type: emailType,
          to: target.email,
          variables: {
            recipientName: target.recipientName,
            organizationName: target.organizationName,
            link,
            expiresAt: expiresAt.toISOString(),
          },
        },
        target.organizationId,
      );
      emailLogId = queued.emailLogId;
    }
    await this.audit.record(tx, {
      action: 'auth.password_link_issued',
      entityType: entityTypeOf(target.subjectType),
      entityId: target.subjectId,
      organizationId: target.organizationId,
      metadata: { purpose, emailType, emailLogId },
    });
    return { link, expiresAt, emailLogId };
  }

  /** RN-01.03: never let the outcome (e.g. RN-01.02 limit reached) change the public answer. */
  private async silently(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      if (error instanceof AppError && error.code === 'PASSWORD_RESET_LIMIT_REACHED') {
        this.logger.warn('reset link not sent: limit of 3 per hour reached (RN-01.02)');
        return;
      }
      throw error;
    }
  }

  private async withMinimumDuration(fn: () => Promise<void>): Promise<void> {
    const started = performance.now();
    try {
      await fn();
    } finally {
      const remaining = FORGOT_MIN_DURATION_MS - (performance.now() - started);
      if (remaining > 0) {
        await sleep(remaining);
      }
    }
  }
}
