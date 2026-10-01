import type { EmailType } from '../generated/prisma/enums.js';

export const EMAIL_QUEUE = 'email.send';

/**
 * Spec 01, section 9: up to 3 attempts with a growing wait. pg-boss counts retries, so 3 attempts
 * are the first one plus `retryLimit: 2` (about 30 s and then 1 to 2 min later).
 */
export const EMAIL_QUEUE_OPTIONS = {
  retryLimit: 2,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 600,
  expireInSeconds: 120,
  // Completed jobs carry the (encrypted) link: keep them only for a day.
  deleteAfterSeconds: 24 * 60 * 60,
} as const;

/** RN-01.04: monthly limit of the SMTP plan and the alert threshold (80%). */
export const EMAIL_MONTHLY_LIMIT = 10_000;
export const EMAIL_WARNING_THRESHOLD = 8_000;

export type EmailCriticality = 'critical' | 'non_critical';

/**
 * RN-01.04: at 100% of the limit only critical e-mails (invites and resets) keep going. Every type
 * of the MVP is critical; new types (e.g. announcements) must be classified here.
 */
export const EMAIL_CRITICALITY: Record<EmailType, EmailCriticality> = {
  owner_invite: 'critical',
  owner_password_reset: 'critical',
  staff_password_reset: 'critical',
  admin_invite: 'critical',
  admin_password_reset: 'critical',
};

export type EmailUsageLevel = 'ok' | 'warning' | 'critical';

/** RN-01.04: `warning` from 8,000 sent in the month, `critical` from 10,000. */
export function usageLevel(count: number): EmailUsageLevel {
  if (count >= EMAIL_MONTHLY_LIMIT) {
    return 'critical';
  }
  return count >= EMAIL_WARNING_THRESHOLD ? 'warning' : 'ok';
}

/** Variables of the templates; every type of the MVP carries a link with a password token. */
export interface EmailVariables {
  recipientName: string;
  /** Name of the organization (owners and staff); null for platform admins. */
  organizationName: string | null;
  /** Invite or reset link, with the token in the fragment (never sent to servers or logs). */
  link: string;
  /** When the link stops working (ISO 8601). */
  expiresAt: string;
}

export interface EmailMessage {
  type: EmailType;
  to: string;
  variables: EmailVariables;
}

/** Job data of {@link EMAIL_QUEUE}. Recipient and link travel encrypted (payload-crypto.ts). */
export interface EmailJobData {
  emailLogId: string;
  payload: string;
}
