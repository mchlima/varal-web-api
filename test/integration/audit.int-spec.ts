import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { AuditError, AuditService } from '../../src/audit/audit.service.js';
import type { Env } from '../../src/config/env.js';
import {
  type AuthContext,
  runWithContext,
  setAuthContext,
  systemContext,
} from '../../src/context/request-context.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { asTenant, createTenant, type Tenant } from '../support/isolation-kit.js';

const databaseUrl = inject('databaseUrl');

describe.skipIf(!databaseUrl)('AuditService (spec 01, section 8)', () => {
  const platform = new PlatformPrismaService({ DATABASE_URL: databaseUrl ?? '' } as Env);
  const prisma = new PrismaService(platform);
  const audit = new AuditService();
  let tenant: Tenant;

  beforeAll(async () => {
    tenant = await createTenant(platform, 'Auditoria');
  });

  afterAll(async () => {
    await platform.$disconnect();
  });

  /** Runs `fn` like an HTTP request: device, IP and request id in the context. */
  function asRequest<T>(auth: AuthContext, fn: () => Promise<T>): Promise<T> {
    const context = systemContext({
      deviceId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      ip: '200.150.10.1',
      requestId: 'req-audit-1',
    });
    return runWithContext(context, async () => {
      setAuthContext(auth);
      return await fn();
    });
  }

  it('CA-01.08: writes one row with actor, device, IP, request id and only the changed fields', async () => {
    const unit = await asRequest(tenant.ownerAuth, () =>
      prisma.transaction(async (tx) => {
        const before = await tx.unit.findUniqueOrThrow({ where: { id: tenant.unitId } });
        const after = await tx.unit.update({
          where: { id: tenant.unitId },
          data: { lateAfterMinutes: 20 },
        });
        await audit.record(tx, {
          action: 'unit.updated',
          entityType: 'unit',
          entityId: after.id,
          before,
          after,
        });
        return after;
      }),
    );

    const rows = await platform.auditLog.findMany({
      where: { entityId: unit.id, action: 'unit.updated' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: tenant.organizationId,
      actorType: 'owner',
      actorId: tenant.ownerId,
      impersonatorId: null,
      entityType: 'unit',
      deviceId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      ip: '200.150.10.1',
      requestId: 'req-audit-1',
      changes: { before: { lateAfterMinutes: 15 }, after: { lateAfterMinutes: 20 } },
    });
  });

  it('records the platform admin of an "entrar como" session (RN-02.20)', async () => {
    const adminId = crypto.randomUUID();
    await asRequest({ ...tenant.ownerAuth, impersonatorId: adminId }, () =>
      prisma.transaction((tx) =>
        audit.record(tx, {
          action: 'unit.viewed_report',
          entityType: 'unit',
          entityId: tenant.unitId,
        }),
      ),
    );
    const row = await platform.auditLog.findFirst({ where: { impersonatorId: adminId } });
    expect(row).toMatchObject({
      actorType: 'owner',
      actorId: tenant.ownerId,
      impersonatorId: adminId,
    });
  });

  it('rolls back with the action: no audit row for an action that did not happen', async () => {
    const entityId = crypto.randomUUID();
    await expect(
      asTenant(tenant.auth, () =>
        prisma.transaction(async (tx) => {
          await audit.record(tx, { action: 'tab.canceled', entityType: 'tab', entityId });
          throw new Error('action failed after the audit row');
        }),
      ),
    ).rejects.toThrow('action failed');
    expect(await platform.auditLog.count({ where: { entityId } })).toBe(0);
  });

  it('is insert-only: the database rejects UPDATE and DELETE', async () => {
    const entityId = crypto.randomUUID();
    await asTenant(tenant.auth, () =>
      prisma.transaction((tx) =>
        audit.record(tx, { action: 'tab.opened', entityType: 'tab', entityId }),
      ),
    );
    await expect(
      platform.auditLog.updateMany({ where: { entityId }, data: { action: 'tab.forged' } }),
    ).rejects.toThrow(/insert-only/);
    await expect(platform.auditLog.deleteMany({ where: { entityId } })).rejects.toThrow(
      /insert-only/,
    );
    expect(await platform.auditLog.count({ where: { entityId, action: 'tab.opened' } })).toBe(1);
  });

  it('uses the system actor outside a request (jobs, scripts)', async () => {
    const entityId = crypto.randomUUID();
    await audit.record(platform, {
      action: 'email.sent',
      entityType: 'email_log',
      entityId,
      organizationId: tenant.organizationId,
    });
    const row = await platform.auditLog.findFirst({ where: { entityId } });
    expect(row).toMatchObject({
      actorType: 'system',
      actorId: null,
      organizationId: tenant.organizationId,
    });
  });

  it('refuses an entry for another organization than the context', async () => {
    const other = await createTenant(platform, 'Outra');
    await expect(
      asTenant(tenant.auth, () =>
        prisma.transaction((tx) =>
          audit.record(tx, {
            action: 'unit.updated',
            entityType: 'unit',
            entityId: other.unitId,
            organizationId: other.organizationId,
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(AuditError);
  });

  it('stores extra facts of the action in changes.metadata', async () => {
    const entityId = crypto.randomUUID();
    await runWithContext(systemContext(), () =>
      audit.record(platform, {
        action: 'organization.status_changed',
        entityType: 'organization',
        entityId,
        before: { subscriptionStatus: 'pilot' },
        after: { subscriptionStatus: 'suspended' },
        metadata: { reason: 'Inadimplência' },
      }),
    );
    const row = await platform.auditLog.findFirst({ where: { entityId } });
    expect(row?.changes).toEqual({
      before: { subscriptionStatus: 'pilot' },
      after: { subscriptionStatus: 'suspended' },
      metadata: { reason: 'Inadimplência' },
    });
  });
});
