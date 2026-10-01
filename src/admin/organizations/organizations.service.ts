import { Injectable } from '@nestjs/common';

import { visibleAnnouncementsWhere } from '../../announcements/announcement-audience.js';
import { AuditService } from '../../audit/audit.service.js';
import { PasswordLinkService } from '../../auth/password-link.service.js';
import { generateAccessCode, normalizeAccessCode } from '../../common/access-code.js';
import { pageArgs, type Page, type PaginationQuery, toPage } from '../../common/pagination.js';
import { AppError } from '../../errors/app-error.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { SubscriptionStatus } from '../../generated/prisma/enums.js';
import { PlatformPrismaService } from '../../prisma/platform-prisma.service.js';
import { UnitTemplateService } from '../../units/unit-template.service.js';
import { adminError } from '../admin-errors.js';
import type {
  CreateOrganizationRequest,
  OrganizationDetail,
  OrganizationSummary,
  UpdateOrganizationRequest,
} from './organizations.schemas.js';

/** Attempts to create an organization when the random access code collides (unique index). */
const CREATE_ATTEMPTS = 5;

const organizationInclude = {
  users: { orderBy: { id: 'asc' }, take: 1 },
} as const satisfies Prisma.OrganizationInclude;

type OrganizationRow = Prisma.OrganizationGetPayload<{ include: typeof organizationInclude }>;
type Owner = OrganizationRow['users'][number];
interface InviteRow {
  subjectId: string;
  expiresAt: Date;
  usedAt: Date | null;
}

type Db = Prisma.TransactionClient;

/**
 * Organizations and subscription situation (spec 02, section 4). Uses the unscoped client: the admin
 * works across organizations. Every change is audited with the organization of the row (spec 01,
 * section 8), so the owner's audit trail shows what the Varal team did.
 */
@Injectable()
export class OrganizationsService {
  constructor(
    private readonly platform: PlatformPrismaService,
    private readonly passwordLinks: PasswordLinkService,
    private readonly audit: AuditService,
    private readonly unitTemplate: UnitTemplateService,
  ) {}

  async list(
    query: PaginationQuery & {
      search?: string | undefined;
      status?: SubscriptionStatus | undefined;
    },
  ): Promise<Page<OrganizationSummary>> {
    const args = pageArgs(query, 'desc');
    const search = query.search;
    const filters: Prisma.OrganizationWhereInput = {
      ...(query.status === undefined ? {} : { subscriptionStatus: query.status }),
      ...(!search
        ? {}
        : {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { accessCode: normalizeAccessCode(search) },
              { users: { some: { email: { contains: search.toLowerCase() } } } },
            ],
          }),
    };
    const rows = await this.platform.organization.findMany({
      ...args,
      where: { AND: [filters, args.where] },
      include: organizationInclude,
    });
    const page = toPage(rows, query.limit);
    const invites = await this.latestInvites(
      this.platform,
      page.data.flatMap((row) => row.users.map((user) => user.id)),
    );
    return {
      data: page.data.map((row) => this.toSummary(row, invites)),
      nextCursor: page.nextCursor,
    };
  }

  async get(id: string, now = new Date()): Promise<OrganizationDetail> {
    const row = await this.platform.organization.findUnique({
      where: { id },
      include: organizationInclude,
    });
    if (!row) {
      throw AppError.of('NOT_FOUND');
    }
    const owner = row.users[0];
    const [invites, units, activeStaffCount, lastAccess, unreadAnnouncements] = await Promise.all([
      this.latestInvites(this.platform, owner ? [owner.id] : []),
      this.platform.unit.findMany({
        where: { organizationId: id },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, active: true },
      }),
      this.platform.staffMember.count({ where: { organizationId: id, active: true } }),
      this.platform.session.aggregate({
        where: { organizationId: id, impersonationId: null },
        _max: { lastUsedAt: true },
      }),
      owner
        ? this.platform.announcement.count({
            where: {
              AND: [visibleAnnouncementsWhere(row, now), { reads: { none: { userId: owner.id } } }],
            },
          })
        : Promise.resolve(0),
    ]);
    return {
      ...this.toSummary(row, invites),
      units,
      activeStaffCount,
      // Shifts arrive with spec 04: list the last 10 here (opened_at desc).
      recentShifts: [],
      lastAccessAt: lastAccess._max.lastUsedAt?.toISOString() ?? null,
      unreadAnnouncements,
    };
  }

  /**
   * RN-02.09: in one transaction, the organization (with a unique `access_code`), the first unit
   * with the default template (`UnitTemplateService`, spec 03), the owner without a password and the
   * owner's invite e-mail. RN-02.10: the owner's e-mail cannot belong to another owner.
   */
  async create(input: CreateOrganizationRequest): Promise<OrganizationDetail> {
    const email = input.owner.email;
    for (let attempt = 1; ; attempt++) {
      try {
        const organizationId = await this.platform.$transaction(async (tx) => {
          if (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
            throw adminError('OWNER_EMAIL_TAKEN');
          }
          const organization = await tx.organization.create({
            data: {
              name: input.name,
              accessCode: await this.freeAccessCode(tx),
              subscriptionStatus: input.subscriptionStatus,
            },
          });
          const unit = await tx.unit.create({
            data: { organizationId: organization.id, name: input.unitName },
          });
          const owner = await tx.user.create({
            data: {
              organizationId: organization.id,
              name: input.owner.name,
              email,
              passwordHash: null,
            },
          });
          await this.audit.record(tx, {
            action: 'organization.created',
            entityType: 'organization',
            entityId: organization.id,
            organizationId: organization.id,
            after: {
              name: organization.name,
              accessCode: organization.accessCode,
              subscriptionStatus: organization.subscriptionStatus,
            },
          });
          await this.audit.record(tx, {
            action: 'unit.created',
            entityType: 'unit',
            entityId: unit.id,
            organizationId: organization.id,
            after: { name: unit.name, active: unit.active },
          });
          await this.audit.record(tx, {
            action: 'user.created',
            entityType: 'user',
            entityId: owner.id,
            organizationId: organization.id,
            after: { name: owner.name, email: owner.email, active: owner.active },
          });
          // Default stations and workflow of the first unit (RN-02.09, spec 03 RN-03.03).
          await this.unitTemplate.applyDefaultTemplate(tx, {
            organizationId: organization.id,
            unitId: unit.id,
          });
          await this.passwordLinks.issueOwnerInvite(tx, owner.id);
          return organization.id;
        });
        return await this.get(organizationId);
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
          throw error;
        }
        // Owner e-mail taken by a concurrent creation, or the access code collided. The next
        // attempt tells them apart (the e-mail check runs first).
        if (attempt >= CREATE_ATTEMPTS) {
          throw AppError.of('CONFLICT');
        }
      }
    }
  }

  /** Name, and the owner's name or e-mail (`organizations:update`). */
  async update(id: string, input: UpdateOrganizationRequest): Promise<OrganizationDetail> {
    try {
      await this.platform.$transaction(async (tx) => {
        const current = await this.findForUpdate(tx, id);
        if (input.name !== undefined && input.name !== current.name) {
          await tx.organization.update({ where: { id }, data: { name: input.name } });
          await this.audit.record(tx, {
            action: 'organization.updated',
            entityType: 'organization',
            entityId: id,
            organizationId: id,
            before: { name: current.name },
            after: { name: input.name },
          });
        }
        if (input.owner && (input.owner.name !== undefined || input.owner.email !== undefined)) {
          await this.updateOwner(tx, current, input.owner);
        }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw adminError('OWNER_EMAIL_TAKEN');
      }
      throw error;
    }
    return this.get(id);
  }

  /** Sends the owner's invite again (7 days); the previous link stops working. */
  async resendOwnerInvite(id: string): Promise<{ expiresAt: string }> {
    return this.platform.$transaction(async (tx) => {
      const current = await this.findForUpdate(tx, id);
      const owner = this.activeOwner(current);
      if (owner.passwordHash !== null) {
        throw adminError('OWNER_ALREADY_ACTIVE');
      }
      const invite = await this.passwordLinks.issueOwnerInvite(tx, owner.id);
      await this.audit.record(tx, {
        action: 'organization.owner_invite_resent',
        entityType: 'user',
        entityId: owner.id,
        organizationId: id,
      });
      return { expiresAt: invite.expiresAt.toISOString() };
    });
  }

  /** RN-02.11/RN-02.12: `pilot` or `active` → `suspended` (`organizations:suspend`). */
  suspend(id: string, reason: string): Promise<OrganizationDetail> {
    return this.changeStatus(id, 'suspended', reason, 'organization.suspended', [
      'pilot',
      'active',
    ]);
  }

  /** RN-02.12: `suspended` or `canceled` → `active` or `pilot` (`organizations:suspend`). */
  reactivate(id: string, status: 'active' | 'pilot', reason: string): Promise<OrganizationDetail> {
    return this.changeStatus(id, status, reason, 'organization.reactivated', [
      'suspended',
      'canceled',
    ]);
  }

  /** RN-02.11: any other situation, with a reason (`subscriptions:update`). */
  setSubscriptionStatus(
    id: string,
    status: SubscriptionStatus,
    reason: string,
  ): Promise<OrganizationDetail> {
    return this.changeStatus(id, status, reason, 'organization.subscription_status_changed', null);
  }

  private async changeStatus(
    id: string,
    status: SubscriptionStatus,
    reason: string,
    action: string,
    allowedFrom: readonly SubscriptionStatus[] | null,
  ): Promise<OrganizationDetail> {
    await this.platform.$transaction(async (tx) => {
      const current = await this.findForUpdate(tx, id);
      const from = current.subscriptionStatus;
      if (from === status || (allowedFrom !== null && !allowedFrom.includes(from))) {
        throw adminError('INVALID_STATUS_TRANSITION', { details: { from, to: status } });
      }
      // The reason of a suspension or cancellation is shown to the owner's banner (RN-02.12).
      const suspendedReason = status === 'suspended' || status === 'canceled' ? reason : null;
      await tx.organization.update({
        where: { id },
        data: { subscriptionStatus: status, suspendedReason },
      });
      await this.audit.record(tx, {
        action,
        entityType: 'organization',
        entityId: id,
        organizationId: id,
        before: { subscriptionStatus: from, suspendedReason: current.suspendedReason },
        after: { subscriptionStatus: status, suspendedReason },
        metadata: { reason },
      });
    });
    return this.get(id);
  }

  private async updateOwner(
    tx: Db,
    organization: OrganizationRow,
    input: { name?: string | undefined; email?: string | undefined },
  ): Promise<void> {
    const owner = this.activeOwner(organization);
    const emailChanged = input.email !== undefined && input.email !== owner.email;
    if (emailChanged) {
      const taken = await tx.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      });
      if (taken) {
        throw adminError('OWNER_EMAIL_TAKEN');
      }
    }
    const updated = await tx.user.update({
      where: { id: owner.id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        // The new address is not verified until the owner uses a link sent to it.
        ...(emailChanged ? { email: input.email, emailVerifiedAt: null } : {}),
      },
    });
    await this.audit.record(tx, {
      action: 'user.updated',
      entityType: 'user',
      entityId: owner.id,
      organizationId: organization.id,
      before: { name: owner.name, email: owner.email },
      after: { name: updated.name, email: updated.email },
    });
    if (emailChanged && updated.passwordHash === null) {
      await this.passwordLinks.issueOwnerInvite(tx, owner.id);
    }
  }

  private async findForUpdate(tx: Db, id: string): Promise<OrganizationRow> {
    // Serializes changes of the same organization (status, owner).
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM organizations WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) {
      throw AppError.of('NOT_FOUND');
    }
    return tx.organization.findUniqueOrThrow({ where: { id }, include: organizationInclude });
  }

  private activeOwner(organization: OrganizationRow): Owner {
    const owner = organization.users[0];
    if (!owner?.active) {
      throw adminError('ORGANIZATION_WITHOUT_OWNER');
    }
    return owner;
  }

  private async freeAccessCode(tx: Db): Promise<string> {
    for (;;) {
      const code = generateAccessCode();
      const taken = await tx.organization.findUnique({
        where: { accessCode: code },
        select: { id: true },
      });
      if (!taken) {
        return code;
      }
    }
  }

  /** Latest invite of each owner, to tell pending, expired and accepted invites apart. */
  private async latestInvites(db: Db, ownerIds: string[]): Promise<Map<string, InviteRow>> {
    if (ownerIds.length === 0) {
      return new Map();
    }
    const rows = await db.passwordToken.findMany({
      where: { subjectType: 'owner', subjectId: { in: ownerIds }, purpose: 'invite' },
      orderBy: [{ subjectId: 'asc' }, { createdAt: 'desc' }],
      distinct: ['subjectId'],
      select: { subjectId: true, expiresAt: true, usedAt: true },
    });
    return new Map(rows.map((row) => [row.subjectId, row]));
  }

  private toSummary(row: OrganizationRow, invites: Map<string, InviteRow>): OrganizationSummary {
    const owner = row.users[0];
    return {
      id: row.id,
      name: row.name,
      accessCode: row.accessCode,
      subscriptionStatus: row.subscriptionStatus,
      suspendedReason: row.suspendedReason,
      createdAt: row.createdAt.toISOString(),
      owner: owner ? this.toOwner(owner, invites.get(owner.id), new Date()) : null,
    };
  }

  private toOwner(owner: Owner, invite: InviteRow | undefined, now: Date) {
    const accepted = owner.passwordHash !== null;
    const pending = !accepted && invite?.usedAt === null && invite.expiresAt > now;
    return {
      id: owner.id,
      name: owner.name,
      email: owner.email,
      active: owner.active,
      inviteStatus: accepted
        ? ('accepted' as const)
        : pending
          ? ('pending' as const)
          : ('expired' as const),
      inviteExpiresAt: accepted || !invite ? null : invite.expiresAt.toISOString(),
    };
  }
}
