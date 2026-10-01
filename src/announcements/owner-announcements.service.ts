import { Injectable } from '@nestjs/common';

import { getRequestContext, requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { visibleAnnouncementsWhere } from './announcement-audience.js';

const BANNER_LIMIT = 50;

/**
 * Owner side of the announcements (RN-02.16). Reads through the tenant client: the organization is
 * the one of the session, and `announcement_reads` is tenant data. Announcements themselves are
 * platform data, filtered here by the audience of the organization (RN-02.14).
 */
@Injectable()
export class OwnerAnnouncementsService {
  constructor(private readonly prisma: PrismaService) {}

  async unread(
    now = new Date(),
  ): Promise<{ id: string; title: string; body: string; publishedAt: string }[]> {
    const { organization, userId } = await this.owner();
    const rows = await this.prisma.db.announcement.findMany({
      where: {
        AND: [visibleAnnouncementsWhere(organization, now), { reads: { none: { userId } } }],
      },
      orderBy: { publishAt: 'desc' },
      take: BANNER_LIMIT,
      select: { id: true, title: true, body: true, publishAt: true, publishedAt: true },
    });
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      publishedAt: (row.publishedAt ?? row.publishAt ?? now).toISOString(),
    }));
  }

  /** Idempotent. In an "entrar como" nothing is recorded (the owner has not read it). */
  async markRead(announcementId: string, now = new Date()): Promise<void> {
    const { organization, userId } = await this.owner();
    const visible = await this.prisma.db.announcement.findFirst({
      where: { AND: [{ id: announcementId }, visibleAnnouncementsWhere(organization, now)] },
      select: { id: true },
    });
    if (!visible) {
      throw AppError.of('NOT_FOUND');
    }
    if (getRequestContext()?.auth?.impersonatorId) {
      return;
    }
    await this.prisma.db.announcementRead.upsert({
      where: { announcementId_userId: { announcementId, userId } },
      create: { announcementId, userId, organizationId: requireOrganizationId(), readAt: now },
      update: {},
    });
  }

  private async owner() {
    const auth = getRequestContext()?.auth;
    const userId = auth?.actor.id;
    const organizationId = requireOrganizationId();
    const organization = await this.prisma.db.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, subscriptionStatus: true },
    });
    if (!organization || !userId) {
      throw AppError.of('UNAUTHENTICATED');
    }
    return { organization, userId };
  }
}
