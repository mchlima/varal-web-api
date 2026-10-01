import { afterAll, describe, expect, inject, it, vi } from 'vitest';

import { MaintenanceJob } from '../../src/jobs/maintenance.job.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { createTenant } from '../support/isolation-kit.js';
import { createTestApp } from '../support/test-app.js';

const databaseUrl = inject('databaseUrl');
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!databaseUrl)('daily cleanup job (pg-boss cron)', () => {
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('removes expired idempotency keys, old sessions, used or expired links and stale login counters', async () => {
    const app = await createTestApp({ databaseUrl: databaseUrl ?? '' });
    try {
      const platform = app.get(PlatformPrismaService);
      const tenant = await createTenant(platform, 'Limpeza');
      const now = new Date();
      const ago = (ms: number) => new Date(now.getTime() - ms);
      const session = (data: { expiresAt: Date; revokedAt?: Date }) =>
        platform.session.create({
          data: {
            subjectType: 'owner',
            subjectId: tenant.ownerId,
            organizationId: tenant.organizationId,
            deviceId: crypto.randomUUID(),
            refreshTokenHash: crypto.randomUUID(),
            ...data,
          },
        });
      const oldSession = await session({ expiresAt: ago(31 * DAY) });
      const oldRevoked = await session({
        expiresAt: new Date(now.getTime() + DAY),
        revokedAt: ago(31 * DAY),
      });
      const current = await session({ expiresAt: new Date(now.getTime() + DAY) });

      const token = (data: { createdAt: Date; expiresAt: Date; usedAt?: Date }) =>
        platform.passwordToken.create({
          data: {
            subjectType: 'owner',
            subjectId: tenant.ownerId,
            purpose: 'invite',
            tokenHash: crypto.randomUUID(),
            ...data,
          },
        });
      const usedToken = await token({
        createdAt: ago(2 * DAY),
        expiresAt: new Date(now.getTime() + DAY),
        usedAt: ago(DAY),
      });
      const validInvite = await token({
        createdAt: ago(2 * DAY),
        expiresAt: new Date(now.getTime() + 5 * DAY),
      });
      const recentReset = await token({ createdAt: ago(10 * 60 * 1000), expiresAt: ago(1000) });

      const staleThrottle = await platform.loginThrottle.create({
        data: { key: crypto.randomUUID(), failedCount: 2, lastFailedAt: ago(2 * DAY) },
      });
      const lockedThrottle = await platform.loginThrottle.create({
        data: {
          key: crypto.randomUUID(),
          failedCount: 0,
          lastFailedAt: ago(2 * DAY),
          lockedUntil: new Date(now.getTime() + 60_000),
        },
      });

      const result = await app.get(MaintenanceJob).runCleanup(now);
      expect(result.sessions).toBeGreaterThanOrEqual(2);

      const sessionIds = (
        await platform.session.findMany({ where: { subjectId: tenant.ownerId } })
      ).map((row) => row.id);
      expect(sessionIds).toEqual([current.id]);
      expect(sessionIds).not.toContain(oldSession.id);
      expect(sessionIds).not.toContain(oldRevoked.id);

      const tokenIds = (
        await platform.passwordToken.findMany({ where: { subjectId: tenant.ownerId } })
      ).map((row) => row.id);
      expect(tokenIds.sort()).toEqual([validInvite.id, recentReset.id].sort());
      expect(tokenIds).not.toContain(usedToken.id);

      await expect(
        platform.loginThrottle.findUnique({ where: { id: staleThrottle.id } }),
      ).resolves.toBeNull();
      await expect(
        platform.loginThrottle.findUnique({ where: { id: lockedThrottle.id } }),
      ).resolves.not.toBeNull();
    } finally {
      await app.close();
    }
  });
});
