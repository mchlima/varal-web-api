import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { Env } from '../../src/config/env.js';
import { requireOrganizationId } from '../../src/context/request-context.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { type AdminClient, adminClient } from '../support/admin-kit.js';
import { setupOperation } from '../support/operation-kit.js';
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

    it('metrics: organizations by situation, days of operation (spec 02, section 6) and the usage table', async () => {
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
      // A period of 2020, far from the data of the other tests: two registers open on 06/01 (one
      // day of operation) and one on 15/01, and a tab of R$ 12,00 paid on 15/01.
      const { organizationId, unitId } = tenant;
      const setup = await setupOperation(platform, tenant);
      const second = await platform.cashRegister.create({
        data: { organizationId, unitId, name: 'Balcão', sortOrder: 2 },
      });
      const day = (value: string) => new Date(`${value}T00:00:00Z`);
      for (const [registerId, businessDate] of [
        [setup.register, '2020-01-06'],
        [second.id, '2020-01-06'],
        [setup.register, '2020-01-15'],
      ] as const) {
        await platform.cashRegisterSession.create({
          data: {
            organizationId,
            unitId,
            cashRegisterId: registerId,
            businessDate: day(businessDate),
            status: 'closed',
            openingFloatCents: 0,
            openedByType: 'system',
            openedAt: new Date(`${businessDate}T20:00:00Z`),
            closedByType: 'system',
            closedAt: new Date(`${businessDate}T23:00:00Z`),
          },
        });
      }
      const tab = await platform.tab.create({
        data: {
          organizationId,
          unitId,
          number: 1,
          businessDate: day('2020-01-15'),
          closedBusinessDate: day('2020-01-15'),
          customerName: 'Mesa',
          mode: 'open_tab',
          status: 'paid',
          openedByType: 'system',
          closedAt: new Date('2020-01-15T22:00:00Z'),
        },
      });
      const order = await platform.order.create({
        data: {
          organizationId,
          tabId: tab.id,
          numberInTab: 1,
          status: 'completed',
          createdByType: 'system',
          sentAt: new Date('2020-01-15T21:00:00Z'),
          completedAt: new Date('2020-01-15T21:30:00Z'),
        },
      });
      await platform.orderItem.create({
        data: {
          organizationId,
          orderId: order.id,
          tabId: tab.id,
          unitId,
          productId: setup.products.soda,
          productName: 'Refrigerante',
          unitPriceCents: 600,
          quantity: 2,
          position: 0,
          prepStationId: setup.stations.delivery,
          stageId: setup.stages.delivered,
          stageEnteredAt: new Date('2020-01-15T21:30:00Z'),
        },
      });

      const overview = await admin
        .call('get', `${API}/admin/metrics/overview?from=2020-01-01&to=2020-01-31`)
        .expect(200);
      const counts = await platform.organization.groupBy({
        by: ['subscriptionStatus'],
        _count: { _all: true },
      });
      expect(overview.body).toMatchObject({
        period: { from: '2020-01-01', to: '2020-01-31', timeZone: 'America/Sao_Paulo' },
        organizationsByStatus: Object.fromEntries(
          counts.map((row) => [row.subscriptionStatus, row._count._all]),
        ),
        activeOrganizations: 1,
        operationDays: { total: 2 },
        tabs: 1,
        soldCents: 1200,
        averageTicketCents: 1200,
      });
      const byWeek = (overview.body as { operationDays: { byWeek: unknown[] } }).operationDays
        .byWeek;
      // Weeks of January 2020 by Monday: 30/12, 06/01, 13/01, 20/01, 27/01.
      expect(byWeek).toEqual([
        { weekStart: '2019-12-30', count: 0 },
        { weekStart: '2020-01-06', count: 1 },
        { weekStart: '2020-01-13', count: 1 },
        { weekStart: '2020-01-20', count: 0 },
        { weekStart: '2020-01-27', count: 0 },
      ]);

      const usage = await admin
        .call(
          'get',
          `${API}/admin/metrics/organizations?from=2020-01-01&to=2020-01-31&sort=operationDays&order=desc`,
        )
        .expect(200);
      const rows = (
        usage.body as {
          data: { organizationId: string; lastAccessAt: string; operationDays: number }[];
        }
      ).data;
      expect(rows[0]).toMatchObject({
        organizationId: tenant.organizationId,
        lastAccessAt: '2026-09-15T12:00:00.000Z',
        operationDays: 2,
        tabs: 1,
        soldCents: 1200,
      });
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
