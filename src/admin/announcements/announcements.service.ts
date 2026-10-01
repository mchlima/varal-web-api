import { Injectable } from '@nestjs/common';

import { effectiveAnnouncementStatus } from '../../announcements/announcement-audience.js';
import { AuditService } from '../../audit/audit.service.js';
import { pageArgs, type Page, type PaginationQuery, toPage } from '../../common/pagination.js';
import { AppError } from '../../errors/app-error.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AnnouncementStatus } from '../../generated/prisma/enums.js';
import { PlatformPrismaService } from '../../prisma/platform-prisma.service.js';
import { adminError } from '../admin-errors.js';
import type {
  AnnouncementResponse,
  CreateAnnouncementRequest,
  UpdateAnnouncementRequest,
} from './announcements.schemas.js';

const announcementInclude = {
  targets: { select: { organizationId: true }, orderBy: { organizationId: 'asc' } },
  createdBy: { select: { id: true, name: true } },
  _count: { select: { reads: true } },
} as const satisfies Prisma.AnnouncementInclude;

type AnnouncementRow = Prisma.AnnouncementGetPayload<{ include: typeof announcementInclude }>;
type Db = Prisma.TransactionClient;

function snapshot(row: AnnouncementRow): Record<string, unknown> {
  return {
    title: row.title,
    body: row.body,
    audienceType: row.audienceType,
    audienceStatuses: row.audienceStatuses,
    organizationIds: row.targets.map((target) => target.organizationId),
    status: row.status,
    publishAt: row.publishAt?.toISOString() ?? null,
  };
}

/**
 * Announcements to owners (spec 02, section 5). Created as drafts; `publish` publishes now or
 * schedules (RN-02.15); the job of the minute publishes the scheduled ones (`publishDue`). Once
 * published only archiving is possible. Audited as `announcement.*`.
 */
@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly platform: PlatformPrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    query: PaginationQuery & { status?: AnnouncementStatus | undefined },
    now = new Date(),
  ): Promise<Page<AnnouncementResponse>> {
    const args = pageArgs(query, 'desc');
    const rows = await this.platform.announcement.findMany({
      ...args,
      where: { AND: [this.statusWhere(query.status, now), args.where] },
      include: announcementInclude,
    });
    const page = toPage(rows, query.limit);
    return {
      data: await Promise.all(page.data.map((row) => this.toResponse(this.platform, row, now))),
      nextCursor: page.nextCursor,
    };
  }

  async get(id: string, now = new Date()): Promise<AnnouncementResponse> {
    const row = await this.platform.announcement.findUnique({
      where: { id },
      include: announcementInclude,
    });
    if (!row) {
      throw AppError.of('NOT_FOUND');
    }
    return this.toResponse(this.platform, row, now);
  }

  async create(adminId: string, input: CreateAnnouncementRequest): Promise<AnnouncementResponse> {
    const id = await this.platform.$transaction(async (tx) => {
      const targets = await this.checkTargets(tx, input.audienceType, [
        ...new Set(input.organizationIds),
      ]);
      const created = await tx.announcement.create({
        data: {
          title: input.title,
          body: input.body,
          audienceType: input.audienceType,
          audienceStatuses:
            input.audienceType === 'by_status' ? [...new Set(input.audienceStatuses)] : [],
          status: 'draft',
          createdById: adminId,
        },
      });
      await tx.announcementTarget.createMany({
        data: targets.map((organizationId) => ({ announcementId: created.id, organizationId })),
      });
      const row = await this.load(tx, created.id);
      await this.audit.record(tx, {
        action: 'announcement.created',
        entityType: 'announcement',
        entityId: created.id,
        organizationId: null,
        after: snapshot(row),
      });
      return created.id;
    });
    return this.get(id);
  }

  async update(
    id: string,
    input: UpdateAnnouncementRequest,
    now = new Date(),
  ): Promise<AnnouncementResponse> {
    await this.platform.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      if (
        effectiveAnnouncementStatus(before, now) !== before.status ||
        !['draft', 'scheduled'].includes(before.status)
      ) {
        throw adminError('ANNOUNCEMENT_NOT_EDITABLE');
      }
      const audienceType = input.audienceType ?? before.audienceType;
      const audienceStatuses =
        audienceType === 'by_status'
          ? [...new Set(input.audienceStatuses ?? before.audienceStatuses)]
          : [];
      const organizationIds =
        audienceType === 'selected'
          ? [
              ...new Set(
                input.organizationIds ?? before.targets.map((target) => target.organizationId),
              ),
            ]
          : [];
      if (audienceType === 'by_status' && audienceStatuses.length === 0) {
        throw AppError.of('VALIDATION_FAILED', {
          details: {
            fields: [
              {
                path: 'audienceStatuses',
                message: 'Escolha pelo menos uma situação de assinatura.',
              },
            ],
          },
        });
      }
      const targets = await this.checkTargets(tx, audienceType, organizationIds);
      await tx.announcement.update({
        where: { id },
        data: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
          audienceType,
          audienceStatuses,
        },
      });
      await tx.announcementTarget.deleteMany({
        where: { announcementId: id, organizationId: { notIn: targets } },
      });
      await tx.announcementTarget.createMany({
        data: targets.map((organizationId) => ({ announcementId: id, organizationId })),
        skipDuplicates: true,
      });
      const after = await this.load(tx, id);
      await this.audit.record(tx, {
        action: 'announcement.updated',
        entityType: 'announcement',
        entityId: id,
        organizationId: null,
        before: snapshot(before),
        after: snapshot(after),
      });
    });
    return this.get(id);
  }

  /** RN-02.15: publishes now, or schedules when `publishAt` is in the future. */
  async publish(
    id: string,
    publishAt: Date | undefined,
    now = new Date(),
  ): Promise<AnnouncementResponse> {
    await this.platform.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      const current = effectiveAnnouncementStatus(before, now);
      if (current !== 'draft' && current !== 'scheduled') {
        throw adminError('ANNOUNCEMENT_INVALID_TRANSITION', {
          message: 'Este comunicado já foi publicado ou arquivado.',
        });
      }
      const schedule = publishAt !== undefined && publishAt > now;
      await tx.announcement.update({
        where: { id },
        data: schedule
          ? { status: 'scheduled', publishAt, publishedAt: null }
          : { status: 'published', publishAt: now, publishedAt: now },
      });
      const after = await this.load(tx, id);
      await this.audit.record(tx, {
        action: schedule ? 'announcement.scheduled' : 'announcement.published',
        entityType: 'announcement',
        entityId: id,
        organizationId: null,
        before: { status: before.status, publishAt: before.publishAt?.toISOString() ?? null },
        after: { status: after.status, publishAt: after.publishAt?.toISOString() ?? null },
      });
    });
    return this.get(id);
  }

  async archive(id: string, now = new Date()): Promise<AnnouncementResponse> {
    await this.platform.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.status === 'archived') {
        throw adminError('ANNOUNCEMENT_INVALID_TRANSITION', {
          message: 'Este comunicado já está arquivado.',
        });
      }
      await tx.announcement.update({
        where: { id },
        data: { status: 'archived', archivedAt: now },
      });
      await this.audit.record(tx, {
        action: 'announcement.archived',
        entityType: 'announcement',
        entityId: id,
        organizationId: null,
        before: { status: effectiveAnnouncementStatus(before, now) },
        after: { status: 'archived' },
      });
    });
    return this.get(id);
  }

  /**
   * Job of the minute: scheduled announcements whose date arrived become `published`, with
   * `published_at` = the scheduled date (RN-02.15). Owners already see them from `publish_at` on.
   */
  async publishDue(now = new Date()): Promise<number> {
    const due = await this.platform.announcement.findMany({
      where: { status: 'scheduled', publishAt: { lte: now } },
      select: { id: true, publishAt: true },
      take: 100,
    });
    let count = 0;
    for (const item of due) {
      await this.platform.$transaction(async (tx) => {
        const { count: changed } = await tx.announcement.updateMany({
          where: { id: item.id, status: 'scheduled' },
          data: { status: 'published', publishedAt: item.publishAt ?? now },
        });
        if (changed === 0) {
          return;
        }
        count++;
        await this.audit.record(tx, {
          action: 'announcement.published',
          entityType: 'announcement',
          entityId: item.id,
          organizationId: null,
          before: { status: 'scheduled' },
          after: { status: 'published' },
          metadata: { scheduled: true },
        });
      });
    }
    return count;
  }

  private statusWhere(
    status: AnnouncementStatus | undefined,
    now: Date,
  ): Prisma.AnnouncementWhereInput {
    switch (status) {
      case undefined:
        return {};
      case 'published':
        return {
          OR: [{ status: 'published' }, { status: 'scheduled', publishAt: { lte: now } }],
        };
      case 'scheduled':
        return { status: 'scheduled', publishAt: { gt: now } };
      default:
        return { status };
    }
  }

  private async checkTargets(
    tx: Db,
    audienceType: string,
    organizationIds: string[],
  ): Promise<string[]> {
    if (audienceType !== 'selected') {
      return [];
    }
    const found = await tx.organization.count({ where: { id: { in: organizationIds } } });
    if (found !== organizationIds.length) {
      throw AppError.of('VALIDATION_FAILED', {
        details: {
          fields: [{ path: 'organizationIds', message: 'Alguma organização não foi encontrada.' }],
        },
      });
    }
    if (organizationIds.length === 0) {
      throw AppError.of('VALIDATION_FAILED', {
        details: {
          fields: [{ path: 'organizationIds', message: 'Escolha pelo menos uma organização.' }],
        },
      });
    }
    return organizationIds;
  }

  private load(db: Db, id: string): Promise<AnnouncementRow> {
    return db.announcement.findUniqueOrThrow({ where: { id }, include: announcementInclude });
  }

  /** Row lock: two admins never publish and edit the same announcement at once. */
  private async lock(tx: Db, id: string): Promise<AnnouncementRow> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM announcements WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) {
      throw AppError.of('NOT_FOUND');
    }
    return this.load(tx, id);
  }

  private async toResponse(db: Db, row: AnnouncementRow, now: Date): Promise<AnnouncementResponse> {
    const organizationIds = row.targets.map((target) => target.organizationId);
    const organizations: Prisma.OrganizationWhereInput =
      row.audienceType === 'all'
        ? {}
        : row.audienceType === 'by_status'
          ? { subscriptionStatus: { in: row.audienceStatuses } }
          : { id: { in: organizationIds } };
    const audienceOwnerCount = await db.user.count({
      where: { active: true, organization: organizations },
    });
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      audienceType: row.audienceType,
      audienceStatuses: row.audienceStatuses,
      organizationIds,
      status: effectiveAnnouncementStatus(row, now),
      publishAt: row.publishAt?.toISOString() ?? null,
      publishedAt:
        (
          row.publishedAt ??
          (effectiveAnnouncementStatus(row, now) === 'published' ? row.publishAt : null)
        )?.toISOString() ?? null,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      readCount: row._count.reads,
      audienceOwnerCount,
    };
  }
}
