import { Injectable, Logger } from '@nestjs/common';

import { PlatformPrismaService } from '../prisma/platform-prisma.service.js';
import { authError } from './auth-errors.js';
import { hashToken } from './secure-token.js';

/** Spec 01, section 7.3: 10 wrong attempts in a row lock the identifier for 15 minutes. */
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

/** Login identifiers, normalized so the same person always hits the same counter. */
export type LoginIdentifier =
  | { kind: 'owner'; email: string }
  | { kind: 'staff'; accessCode: string; username: string }
  | { kind: 'platform_admin'; email: string };

export function throttleKey(identifier: LoginIdentifier): string {
  switch (identifier.kind) {
    case 'owner':
    case 'platform_admin':
      return hashToken(`${identifier.kind}:${identifier.email.toLowerCase()}`);
    case 'staff':
      return hashToken(
        `staff:${identifier.accessCode.toUpperCase()}:${identifier.username.toLowerCase()}`,
      );
  }
}

/**
 * Lock after consecutive failures, per identifier (spec 01, section 7.3). It applies the same way to
 * identifiers that do not exist, so neither the error nor the lock reveals whether a user exists.
 * The counter lives in the database (`login_throttles`), so it holds across restarts.
 */
@Injectable()
export class LoginThrottleService {
  private readonly logger = new Logger('LoginThrottle');

  constructor(private readonly platform: PlatformPrismaService) {}

  /** Throws `LOGIN_TEMPORARILY_LOCKED` while the identifier is locked. */
  async assertNotLocked(key: string, now = new Date()): Promise<void> {
    const row = await this.platform.loginThrottle.findUnique({
      where: { key },
      select: { lockedUntil: true },
    });
    if (row?.lockedUntil && row.lockedUntil > now) {
      const retryAfterSeconds = Math.ceil((row.lockedUntil.getTime() - now.getTime()) / 1000);
      throw authError('LOGIN_TEMPORARILY_LOCKED', { retryAfterSeconds });
    }
  }

  /** Counts a wrong attempt; the 10th in a row locks the identifier. */
  async registerFailure(key: string, now = new Date()): Promise<void> {
    const row = await this.platform.loginThrottle.upsert({
      where: { key },
      create: { key, failedCount: 1, lastFailedAt: now },
      update: { failedCount: { increment: 1 }, lastFailedAt: now },
      select: { failedCount: true },
    });
    if (row.failedCount >= LOGIN_MAX_FAILURES) {
      await this.platform.loginThrottle.update({
        where: { key },
        data: { failedCount: 0, lockedUntil: new Date(now.getTime() + LOGIN_LOCK_MS) },
      });
      this.logger.warn(
        `login locked for 15 minutes after ${LOGIN_MAX_FAILURES} failures (key ${key.slice(0, 12)}…)`,
      );
    }
  }

  /** A successful login ends the sequence of failures. */
  async reset(key: string): Promise<void> {
    await this.platform.loginThrottle.deleteMany({ where: { key } });
  }
}
