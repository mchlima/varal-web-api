import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AdminTasksJob } from '../../src/admin/admin-tasks.job.js';
import { RateLimiter } from '../../src/auth/rate-limit.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { type AdminClient, adminClient } from '../support/admin-kit.js';
import {
  type CookieJar,
  credentialsOf,
  loginOwner,
  loginStaff,
  setPassword,
} from '../support/auth-kit.js';
import { errorOf } from '../support/http.js';
import {
  createTenant,
  expectNotFoundForOtherTenant,
  type Tenant,
} from '../support/isolation-kit.js';
import { createTestApp } from '../support/test-app.js';

const databaseUrl = inject('databaseUrl');
const API = '/api/v1';

interface AnnouncementBody {
  id: string;
  status: string;
  readCount: number;
  audienceOwnerCount: number;
  publishAt: string | null;
  publishedAt: string | null;
}

describe.skipIf(!databaseUrl)('announcements (spec 02, section 5)', () => {
  let app: NestExpressApplication;
  let platform: PlatformPrismaService;
  let admin: AdminClient;
  let tenantA: Tenant;
  let tenantB: Tenant;
  let ownerA: { jar: CookieJar; deviceId: string };
  let ownerB: { jar: CookieJar; deviceId: string };

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({ auth: 'real', databaseUrl: databaseUrl ?? '' });
    platform = app.get(PlatformPrismaService);
    admin = await adminClient(app, platform);
    tenantA = await createTenant(platform, 'Comunicado A');
    tenantB = await createTenant(platform, 'Comunicado B');
    await platform.organization.update({
      where: { id: tenantB.organizationId },
      data: { subscriptionStatus: 'suspended' },
    });
    for (const tenant of [tenantA, tenantB]) {
      await setPassword(platform, { owner: tenant.ownerId, staff: tenant.staffMemberId });
    }
    app.get(RateLimiter).reset();
    ownerA = await loginOwner(app, (await credentialsOf(platform, tenantA)).email);
    ownerB = await loginOwner(app, (await credentialsOf(platform, tenantB)).email);
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  function asOwner(
    owner: { jar: CookieJar; deviceId: string },
    method: 'get' | 'post',
    path: string,
  ) {
    return http()
      [method](path)
      .set('Cookie', owner.jar.header())
      .set('X-Device-Id', owner.deviceId);
  }

  async function unreadIds(owner: { jar: CookieJar; deviceId: string }): Promise<string[]> {
    const response = await asOwner(owner, 'get', `${API}/announcements/unread`).expect(200);
    return (response.body as { data: { id: string }[] }).data.map((item) => item.id);
  }

  async function createDraft(body: object): Promise<AnnouncementBody> {
    const response = await admin
      .call('post', `${API}/admin/announcements`, {
        title: 'Novidade',
        body: 'Agora o **Varal** tem relatórios.',
        ...body,
      })
      .expect(201);
    return response.body as AnnouncementBody;
  }

  it('a draft is not visible; publishing now shows it to the owners of the audience', async () => {
    const draft = await createDraft({ audienceType: 'all' });
    expect(draft.status).toBe('draft');
    await expect(unreadIds(ownerA)).resolves.not.toContain(draft.id);
    const published = await admin
      .call('post', `${API}/admin/announcements/${draft.id}/publish`, {})
      .expect(200);
    expect(published.body).toMatchObject({ status: 'published' });
    await expect(unreadIds(ownerA)).resolves.toContain(draft.id);
    await expect(unreadIds(ownerB)).resolves.toContain(draft.id);
  });

  it('CA-02.06: scheduled for all appears on the date and leaves the banner once read', async () => {
    const draft = await createDraft({ audienceType: 'all', title: 'Agendado' });
    const publishAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const scheduled = await admin
      .call('post', `${API}/admin/announcements/${draft.id}/publish`, { publishAt })
      .expect(200);
    expect(scheduled.body).toMatchObject({ status: 'scheduled', publishAt, publishedAt: null });
    await expect(unreadIds(ownerA)).resolves.not.toContain(draft.id);

    // The date arrives (moved to the past instead of waiting).
    const arrived = new Date(Date.now() - 1_000);
    await platform.announcement.update({ where: { id: draft.id }, data: { publishAt: arrived } });
    await expect(unreadIds(ownerA)).resolves.toContain(draft.id);
    const shown = await admin.call('get', `${API}/admin/announcements/${draft.id}`).expect(200);
    expect(shown.body).toMatchObject({ status: 'published' });

    // The job of the minute records the publication.
    const result = await app.get(AdminTasksJob).run();
    expect(result.announcementsPublished).toBeGreaterThanOrEqual(1);
    await expect(
      platform.announcement.findUniqueOrThrow({ where: { id: draft.id } }),
    ).resolves.toMatchObject({ status: 'published', publishedAt: arrived });

    await asOwner(ownerA, 'post', `${API}/announcements/${draft.id}/read`).expect(204);
    await asOwner(ownerA, 'post', `${API}/announcements/${draft.id}/read`).expect(204);
    await expect(unreadIds(ownerA)).resolves.not.toContain(draft.id);
    await expect(unreadIds(ownerB)).resolves.toContain(draft.id);
    const counted = await admin.call('get', `${API}/admin/announcements/${draft.id}`).expect(200);
    expect((counted.body as AnnouncementBody).readCount).toBe(1);
    expect((counted.body as AnnouncementBody).audienceOwnerCount).toBeGreaterThanOrEqual(2);
  });

  it('RN-02.14: by situation and chosen organizations; another audience is a 404 (CA-01.02)', async () => {
    const suspendedOnly = await createDraft({
      audienceType: 'by_status',
      audienceStatuses: ['suspended'],
    });
    const onlyA = await createDraft({
      audienceType: 'selected',
      organizationIds: [tenantA.organizationId],
    });
    for (const item of [suspendedOnly, onlyA]) {
      await admin.call('post', `${API}/admin/announcements/${item.id}/publish`, {}).expect(200);
    }
    await expect(unreadIds(ownerA)).resolves.toEqual(expect.arrayContaining([onlyA.id]));
    await expect(unreadIds(ownerA)).resolves.not.toContain(suspendedOnly.id);
    await expect(unreadIds(ownerB)).resolves.toContain(suspendedOnly.id);
    await expect(unreadIds(ownerB)).resolves.not.toContain(onlyA.id);

    await expectNotFoundForOtherTenant(app, {
      method: 'post',
      path: `${API}/announcements/${onlyA.id}/read`,
      headers: { Cookie: ownerB.jar.header(), 'X-Device-Id': ownerB.deviceId },
    });
    await expect(
      platform.announcementRead.count({ where: { announcementId: onlyA.id } }),
    ).resolves.toBe(0);
    const detail = await admin.call('get', `${API}/admin/announcements/${onlyA.id}`).expect(200);
    expect(detail.body).toMatchObject({
      organizationIds: [tenantA.organizationId],
      audienceOwnerCount: 1,
    });
  });

  it('RN-02.15: published only archives; archived leaves the banner', async () => {
    const item = await createDraft({ audienceType: 'all', title: 'Arquivar' });
    await admin
      .call('patch', `${API}/admin/announcements/${item.id}`, { title: 'Título novo' })
      .expect(200);
    await admin.call('post', `${API}/admin/announcements/${item.id}/publish`, {}).expect(200);
    const edit = await admin
      .call('patch', `${API}/admin/announcements/${item.id}`, { body: 'Outro texto' })
      .expect(409);
    expect(errorOf(edit).code).toBe('ANNOUNCEMENT_NOT_EDITABLE');
    const republish = await admin
      .call('post', `${API}/admin/announcements/${item.id}/publish`, {})
      .expect(409);
    expect(errorOf(republish).code).toBe('ANNOUNCEMENT_INVALID_TRANSITION');
    await expect(unreadIds(ownerA)).resolves.toContain(item.id);
    await admin.call('post', `${API}/admin/announcements/${item.id}/archive`).expect(200);
    await expect(unreadIds(ownerA)).resolves.not.toContain(item.id);
    const actions = await platform.auditLog.findMany({
      where: { entityId: item.id },
      orderBy: { id: 'asc' },
      select: { action: true },
    });
    expect(actions.map((row) => row.action)).toEqual([
      'announcement.created',
      'announcement.updated',
      'announcement.published',
      'announcement.archived',
    ]);
  });

  it('validates RN-02.13 and RN-02.14', async () => {
    const response = await admin
      .call('post', `${API}/admin/announcements`, {
        title: 'x'.repeat(81),
        body: 'y'.repeat(2001),
        audienceType: 'by_status',
      })
      .expect(400);
    const paths = (errorOf(response).details.fields as { path: string }[]).map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['title', 'body', 'audienceStatuses']));
    await admin
      .call('post', `${API}/admin/announcements`, {
        title: 'Escolhidas',
        body: 'Texto',
        audienceType: 'selected',
        organizationIds: [crypto.randomUUID()],
      })
      .expect(400);
  });

  it('lists by situation for the admin', async () => {
    const draft = await createDraft({ audienceType: 'all', title: 'Rascunho da lista' });
    const response = await admin
      .call('get', `${API}/admin/announcements?status=draft&limit=100`)
      .expect(200);
    const items = (response.body as { data: AnnouncementBody[] }).data;
    expect(items.map((item) => item.id)).toContain(draft.id);
    expect(items.every((item) => item.status === 'draft')).toBe(true);
  });

  it('the banner is for the owner only: a staff member gets 403', async () => {
    // RN-03.16: a staff member logs in only with an active unit.
    await platform.staffUnitPermission.create({
      data: {
        organizationId: tenantA.organizationId,
        staffMemberId: tenantA.staffMemberId,
        unitId: tenantA.unitId,
      },
    });
    app.get(RateLimiter).reset();
    const staff = await loginStaff(app, await credentialsOf(platform, tenantA));
    await http()
      .get(`${API}/announcements/unread`)
      .set('Cookie', staff.jar.header())
      .set('X-Device-Id', staff.deviceId)
      .expect(403);
  });
});
