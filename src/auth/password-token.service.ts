import { Injectable } from '@nestjs/common';

import type { PasswordTokenPurpose, SubjectType } from '../generated/prisma/enums.js';
import type { AuthDb } from './auth-db.js';
import { authError } from './auth-errors.js';
import { hashToken, randomToken } from './secure-token.js';

/** Spec 01, section 7.4: invites last 7 days, resets 1 hour (for owners, staff and admins). */
export const PASSWORD_TOKEN_TTL_MS: Record<PasswordTokenPurpose, number> = {
  invite: 7 * 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
};

/** RN-01.02: at most 3 reset links per user per hour. */
export const MAX_RESETS_PER_HOUR = 3;
const HOUR_MS = 60 * 60 * 1000;

export interface PasswordTokenSubject {
  subjectType: SubjectType;
  subjectId: string;
}

export interface IssuedPasswordToken {
  token: string;
  expiresAt: Date;
}

export interface ConsumedPasswordToken extends PasswordTokenSubject {
  id: string;
  purpose: PasswordTokenPurpose;
}

/**
 * Invite and reset links (spec 01, section 7.4): 32 random bytes, only the SHA-256 stored, single
 * use. Issuing a token ends the unused ones of the same purpose for the same user.
 */
@Injectable()
export class PasswordTokenService {
  /** Throws `PASSWORD_RESET_LIMIT_REACHED` (429) past 3 reset links in the last hour (RN-01.02). */
  async issue(
    tx: AuthDb,
    subject: PasswordTokenSubject,
    purpose: PasswordTokenPurpose,
    now = new Date(),
  ): Promise<IssuedPasswordToken> {
    if (purpose === 'reset') {
      const lastHour = await tx.passwordToken.count({
        where: { ...subject, purpose, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
      });
      if (lastHour >= MAX_RESETS_PER_HOUR) {
        throw authError('PASSWORD_RESET_LIMIT_REACHED');
      }
    }
    // Ends the previous links of the same purpose; the rows stay, so RN-01.02 can count them.
    await tx.passwordToken.updateMany({
      where: { ...subject, purpose, usedAt: null, expiresAt: { gt: now } },
      data: { expiresAt: now },
    });
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + PASSWORD_TOKEN_TTL_MS[purpose]);
    await tx.passwordToken.create({
      data: { ...subject, purpose, tokenHash: hashToken(token), expiresAt },
    });
    return { token, expiresAt };
  }

  /**
   * Uses a token once. Returns null when it does not exist, was used, expired, or belongs to a
   * subject type that this endpoint does not accept (admin tokens never work in the panel).
   */
  async consume(
    tx: AuthDb,
    token: string,
    allowedSubjects: readonly SubjectType[],
    now = new Date(),
  ): Promise<ConsumedPasswordToken | null> {
    const [row] = await tx.passwordToken.updateManyAndReturn({
      where: {
        tokenHash: hashToken(token),
        usedAt: null,
        expiresAt: { gt: now },
        subjectType: { in: [...allowedSubjects] },
      },
      data: { usedAt: now },
      select: { id: true, subjectType: true, subjectId: true, purpose: true },
    });
    return row ?? null;
  }
}
