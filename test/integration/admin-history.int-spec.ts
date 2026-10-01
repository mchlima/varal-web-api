import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { Env } from '../../src/config/env.js';
import { requireOrganizationId } from '../../src/context/request-context.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { type AdminClient, adminClient } from '../support/admin-kit.js';
import {
  createTenant,
  describeTenantIsolation,
  type IsolationContext,
} from '../support/isolation-kit.js';
import { createTestApp } from '../support/test-app.js';

const databaseUrl = inject('databaseUrl');
const API = '/api/v1';

describe.skipIf(!databaseUrl)(
  'e-mails, audit and metrics of the admin (spec 02, sections 6 and 8)',
  () => {
    let app: NestExpressApplication;
    let platform: PlatformPrismaService;
    let admin: AdminClient;

    beforeAll(async () => {
      app = await createTestApp({ auth: 'real', databaseUrl: databaseUrl ?? '' });
      platform = app.get(PlatformPrismaService);
      admin = await adminClient(app, platform);
    });

    afterAll(async () => {
      await app.close();
      vi.unstubAllEnvs();
    });

    it('lists e-mails newest first, filtered by type, situation, organization and period, with the error', async () => {
      const tenant = await createTenant(platform, 'E-mails');
      const old = await platform.emailLog.create({
        data: {
          organizationId: tenant.organizationId,
          to: 'a@teste.local',
          type: 'owner_invite',
          status: 'sent',
          createdAt: new Date('2020-05-01T12:00:00Z'),
        },
      });
      const failed = await platform.emailLog.create({
        data: {
          organizationId: tenant.organizationId,
          to: 'b@teste.local',
          type: 'owner_password_reset',
          status: 'failed',
          error: 'SMTP recusou',
        },
      });
      const all = await admin
        .call('get', `${API}/admin/emails?organizationId=${tenant.organizationId}`)
        .expect(200);
      expect((all.body as { data: { id: string }[] }).data.map((row) => row.id)).toEqual([
        failed.id,
        old.id,
      ]);
      const onlyFailed = await admin
        .call(
          'get',
          `${API}/admin/emails?organizationId=${tenant.organizationId}&status=failed&type=owner_password_reset`,
        )
        .expect(200);
      expect(onlyFailed.body).toMatchObject({
        data: [{ id: failed.id, error: 'SMTP recusou', status: 'failed' }],
        nextCursor: null,
      });
      const period = await admin
        .call(
          'get',
          `${API}/admin/emails?organizationId=${tenant.organizationId}&from=${encodeURIComponent('2020-05-01T00:00:00-03:00')}&to=${encodeURIComponent('2020-05-02T00:00:00-03:00')}`,
        )
        .expect(200);
      expect((period.body as { data: { id: string }[] }).data.map((row) => row.id)).toEqual([
        old.id,
      ]);
      await admin.call('get', `${API}/admin/emails?status=lido`).expect(400);
    });

    it('searches the audit by organization, actor, action (prefix) and entity, with the changes', async () => {
      const created = await admin
        .call('post', `${API}/admin/organizations`, {
          name: 'Auditada',
          unitName: 'Feira',
          owner: { name: 'Dona', email: `auditada.${crypto.randomUUID()}@teste.local` },
        })
        .expect(201);
      const organizationId = (created.body as { id: string }).id;
      await admin
        .call('post', `${API}/admin/organizations/${organizationId}/suspend`, {
          reason: 'Teste da auditoria',
        })
        .expect(200);
      const byPrefix = await admin
        .call(
          'get',
          `${API}/admin/audit-logs?organizationId=${organizationId}&action=organization.&actorId=${admin.id}`,
        )
        .expect(200);
      const rows = (byPrefix.body as { data: { action: string; changes: object }[] }).data;
      expect(rows.map((row) => row.action)).toEqual([
        'organization.suspended',
        'organization.created',
      ]);
      expect(rows[0]?.changes).toMatchObject({
        after: { subscriptionStatus: 'suspended' },
        metadata: { reason: 'Teste da auditoria' },
      });
      const byEntity = await admin
        .call(
          'get',
          `${API}/admin/audit-logs?entityType=organization&entityId=${organizationId}&action=organization.created`,
        )
        .expect(200);
      expect((byEntity.body as { data: unknown[] }).data).toHaveLength(1);
    });

    it('metrics: organizations by situation and the usage table (shifts and tabs come with spec 04)', async () => {
      const tenant = await createTenant(platform, 'Métricas');
      await platform.session.create({
        data: {
          subjectType: 'owner',
          subjectId: tenant.ownerId,
          organizationId: tenant.organizationId,
          deviceId: crypto.randomUUID(),
          refreshTokenHash: crypto.randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
          lastUsedAt: new Date('2026-09-15T12:00:00Z'),
        },
      });
      const overview = await admin
        .call('get', `${API}/admin/metrics/overview?from=2026-09-01&to=2026-09-30`)
        .expect(200);
      const counts = await platform.organization.groupBy({
        by: ['subscriptionStatus'],
        _count: { _all: true },
      });
      expect(overview.body).toMatchObject({
        period: { from: '2026-09-01', to: '2026-09-30', timeZone: 'America/Sao_Paulo' },
        organizationsByStatus: Object.fromEntries(
          counts.map((row) => [row.subscriptionStatus, row._count._all]),
        ),
        shifts: { total: 0 },
        tabs: 0,
        soldCents: 0,
        averageTicketCents: 0,
      });
      expect((overview.body as { shifts: { byWeek: unknown[] } }).shifts.byWeek).toHaveLength(5);

      const usage = await admin
        .call('get', `${API}/admin/metrics/organizations?sort=lastAccessAt&order=desc`)
        .expect(200);
      const row = (
        usage.body as { data: { organizationId: string; lastAccessAt: string }[] }
      ).data.find((item) => item.organizationId === tenant.organizationId);
      expect(row).toMatchObject({ lastAccessAt: '2026-09-15T12:00:00.000Z', shifts: 0 });
      await admin
        .call('get', `${API}/admin/metrics/overview?from=2026-10-01&to=2026-09-01`)
        .expect(400);
    });
  },
);

describe.skipIf(!databaseUrl)('tenant isolation of the spec 02 tables (CA-01.02)', () => {
  const platform = new PlatformPrismaService({ DATABASE_URL: databaseUrl ?? '' } as Env);
  const prisma = new PrismaService(platform);
  let ctx: IsolationContext;
  let adminId: string;
  const context = () => ctx;

  beforeAll(async () => {
    ctx = {
      prisma,
      tenantA: await createTenant(platform, 'Iso A'),
      tenantB: await createTenant(platform, 'Iso B'),
    };
    adminId = (
      await platform.platformAdmin.create({
        data: { name: 'Admin Iso', email: `iso.${crypto.randomUUID()}@teste.local` },
      })
    ).id;
  });

  afterAll(async () => {
    await platform.$disconnect();
  });

  async function announcement(): Promise<string> {
    return (
      await platform.announcement.create({
        data: {
          title: 'T',
          body: 'B',
          audienceType: 'selected',
          status: 'published',
          createdById: adminId,
        },
      })
    ).id;
  }

  describeTenantIsolation('AnnouncementRead', {
    context,
    delegate: (db) => db.announcementRead,
    create: async (db, tenant) =>
      db.announcementRead.create({
        data: {
          announcementId: await announcement(),
          organizationId: requireOrganizationId(),
          userId: tenant.ownerId,
        },
      }),
    update: { readAt: new Date('2020-01-01T00:00:00Z') },
  });

  describeTenantIsolation('AnnouncementTarget', {
    context,
    delegate: (db) => db.announcementTarget,
    create: async (db) =>
      db.announcementTarget.create({
        data: { announcementId: await announcement(), organizationId: requireOrganizationId() },
      }),
    update: { createdAt: new Date('2020-01-01T00:00:00Z') },
  });

  describeTenantIsolation('ImpersonationSession', {
    context,
    delegate: (db) => db.impersonationSession,
    create: (db, tenant) =>
      db.impersonationSession.create({
        data: {
          organizationId: requireOrganizationId(),
          platformAdminId: adminId,
          ownerId: tenant.ownerId,
          reason: 'Motivo do teste',
          startedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    update: { reason: 'Motivo trocado por B' },
  });
});
