import type { Prisma } from '../generated/prisma/client.js';
import type { SubscriptionStatus } from '../generated/prisma/enums.js';

/**
 * Who sees an announcement (spec 02, section 5). Shared by the owner's banner (src/announcements)
 * and the admin (src/admin/announcements).
 *
 * - RN-02.15: an announcement is visible once published. A scheduled one counts as published from
 *   `publish_at` on, even before the job of the minute marks it `published` (CA-02.06: "aparece na
 *   data marcada"). Archived ones are never visible.
 * - RN-02.14: the audience is every organization, the organizations in some subscription situations
 *   (evaluated now, not at publication), or the organizations chosen one by one.
 */
export function visibleAnnouncementsWhere(
  organization: { id: string; subscriptionStatus: SubscriptionStatus },
  now: Date,
): Prisma.AnnouncementWhereInput {
  return {
    AND: [
      {
        OR: [{ status: 'published' }, { status: 'scheduled', publishAt: { lte: now } }],
      },
      {
        OR: [
          { audienceType: 'all' },
          { audienceType: 'by_status', audienceStatuses: { has: organization.subscriptionStatus } },
          { audienceType: 'selected', targets: { some: { organizationId: organization.id } } },
        ],
      },
    ],
  };
}

/** Status as the users see it: a scheduled announcement past `publish_at` is published. */
export function effectiveAnnouncementStatus(
  announcement: {
    status: 'draft' | 'scheduled' | 'published' | 'archived';
    publishAt: Date | null;
  },
  now: Date,
): 'draft' | 'scheduled' | 'published' | 'archived' {
  if (
    announcement.status === 'scheduled' &&
    announcement.publishAt !== null &&
    announcement.publishAt <= now
  ) {
    return 'published';
  }
  return announcement.status;
}
