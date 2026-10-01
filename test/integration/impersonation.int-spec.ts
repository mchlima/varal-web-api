import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { AdminTasksJob } from '../../src/admin/admin-tasks.job.js';
import { AUTH_COOKIES } from '../../src/auth/auth-area.js';
import { AuthEvents, type SessionsRevokedEvent } from '../../src/auth/auth-events.js';
import { RateLimiter } from '../../src/auth/rate-limit.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { UnitTemplateService } from '../../src/units/unit-template.service.js';
import { type AdminClient, adminClient } from '../support/admin-kit.js';
import {
  CookieJar,
  credentialsOf,
  loginOwner,
  loginStaff,
  newDeviceId,
  parseSetCookies,
  setPassword,
} from '../support/auth-kit.js';
import { errorOf } from '../support/http.js';
import { createTenant, type Tenant } from '../support/isolation-kit.js';
import { createTestApp } from '../support/test-app.js';

const databaseUrl = inject('databaseUrl');
const API = '/api/v1';

interface Started {
  impersonation: { id: string; expiresAt: string; active: boolean };
  handoffUrl: string;
}

/** The panel of the admin's browser: own device id, the admin cookies of the same browser. */
interface PanelTab {
  jar: CookieJar;
  deviceId: string;
}

describe.skipIf(!databaseUrl)('"entrar como" (spec 02, section 7)', () => {
  let app: NestExpressApplication;
  let platform: PlatformPrismaService;
  let support: AdminClient;
  let tenant: Tenant;
  let otherTenant: Tenant;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({
      auth: 'real',
      databaseUrl: databaseUrl ?? '',
    });
    platform = app.get(PlatformPrismaService);
    support = await adminClient(app, platform, { roles: ['support'] });
    tenant = await createTenant(platform, 'Entrar como');
    otherTenant = await createTenant(platform, 'Outra');
    await setPassword(platform, { owner: tenant.ownerId, staff: tenant.staffMemberId });
    await setPassword(platform, { owner: otherTenant.ownerId });
    // Stations of spec 03, so the owner can change the menu.
    await app.get(UnitTemplateService).applyDefaultTemplate(platform, {
      organizationId: tenant.organizationId,
      unitId: tenant.unitId,
    });
  });

  beforeEach(() => {
    app.get(RateLimiter).reset();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  async function start(admin = support, organizationId = tenant.organizationId): Promise<Started> {
    const response = await admin
      .call('post', `${API}/admin/impersonations`, {
        organizationId,
        reason: 'Ajuda para cadastrar o cardápio',
      })
      .expect(201);
    return response.body as Started;
  }

  function tokenOf(started: Started): string {
    const url = new URL(started.handoffUrl);
    expect(url.pathname).toBe('/entrar-como');
    return /token=([\w-]+)/.exec(url.hash)?.[1] ?? '';
  }

  /** Opens the panel with the link, in the browser where `admin` is logged in. */
  async function openPanel(
    started: Started,
    admin = support,
  ): Promise<PanelTab & { body: unknown }> {
    const deviceId = newDeviceId();
    const response = await http()
      .post(`${API}/auth/impersonation`)
      .set('Cookie', admin.jar.header())
      .set('X-Device-Id', deviceId)
      .send({ token: tokenOf(started) })
      .expect(200);
    return { jar: new CookieJar('panel').store(response), deviceId, body: response.body };
  }

  function asPanel(tab: PanelTab, method: 'get' | 'post', path: string) {
    return http()[method](path).set('Cookie', tab.jar.header()).set('X-Device-Id', tab.deviceId);
  }

  it('opens a panel session as the owner, with the banner data (RN-02.18, RN-02.19, RN-02.21)', async () => {
    const started = await start();
    expect(started.impersonation.active).toBe(true);
    expect(new Date(started.impersonation.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(
      60 * 60 * 1000,
    );
    const tab = await openPanel(started);
    expect(tab.body).toMatchObject({
      subject: { type: 'owner', id: tenant.ownerId },
      organization: { id: tenant.organizationId },
      impersonation: { id: started.impersonation.id, adminName: support.name },
    });
    const me = await asPanel(tab, 'get', `${API}/auth/me`).expect(200);
    expect(me.body).toMatchObject({ impersonation: { id: started.impersonation.id } });

    // Its own cookie of the customers' app, never valid in the admin (RN-02.21, CA-01.04).
    expect(tab.jar.access).toBeDefined();
    await http()
      .get(`${API}/admin/organizations`)
      .set('Cookie', `${AUTH_COOKIES.panel.access}=${tab.jar.access ?? ''}`)
      .expect(401);
  });

  it('the link is single-use, short-lived and only for the admin who started it, in the same browser', async () => {
    const started = await start();
    const token = tokenOf(started);
    // Without the admin session in this browser.
    const anonymous = await http()
      .post(`${API}/auth/impersonation`)
      .set('X-Device-Id', newDeviceId())
      .send({ token })
      .expect(401);
    expect(errorOf(anonymous).code).toBe('UNAUTHENTICATED');
    // Another admin's browser.
    const other = await adminClient(app, platform, { roles: ['support'] });
    const stolen = await http()
      .post(`${API}/auth/impersonation`)
      .set('Cookie', other.jar.header())
      .set('X-Device-Id', newDeviceId())
      .send({ token })
      .expect(400);
    expect(errorOf(stolen).code).toBe('INVALID_IMPERSONATION_TOKEN');
    await openPanel(started);
    // Used.
    await http()
      .post(`${API}/auth/impersonation`)
      .set('Cookie', support.jar.header())
      .set('X-Device-Id', newDeviceId())
      .send({ token })
      .expect(400);
    // Expired link.
    const late = await start();
    await platform.impersonationSession.update({
      where: { id: late.impersonation.id },
      data: { handoffExpiresAt: new Date(Date.now() - 1_000) },
    });
    await http()
      .post(`${API}/auth/impersonation`)
      .set('Cookie', support.jar.header())
      .set('X-Device-Id', newDeviceId())
      .send({ token: tokenOf(late) })
      .expect(400);
  });

  it('CA-02.07: a menu change made during the session is audited with the admin in impersonator_id (RN-02.20)', async () => {
    const started = await start();
    const tab = await openPanel(started);
    const response = await asPanel(tab, 'post', `${API}/categories`)
      .send({ unitId: tenant.unitId, name: `Espetos ${crypto.randomUUID().slice(0, 6)}` })
      .expect(201);
    const categoryId = (response.body as { id: string }).id;
    const row = await platform.auditLog.findFirstOrThrow({
      where: { action: 'category.created', entityId: categoryId },
    });
    expect(row).toMatchObject({
      organizationId: tenant.organizationId,
      actorType: 'owner',
      actorId: tenant.ownerId,
      impersonatorId: support.id,
      impersonationId: started.impersonation.id,
      deviceId: tab.deviceId,
    });
    // The start, the opening of the session and the end are audited too.
    await expect(
      platform.auditLog.findFirst({
        where: { action: 'impersonation.started', entityId: started.impersonation.id },
      }),
    ).resolves.toMatchObject({ actorId: support.id, organizationId: tenant.organizationId });
    await expect(
      platform.auditLog.findFirst({
        where: {
          action: 'impersonation.session_opened',
          impersonationId: started.impersonation.id,
        },
      }),
    ).resolves.toMatchObject({ actorType: 'owner', impersonatorId: support.id });
    // The owner's own sessions are untouched and have no impersonator.
    const owner = await loginOwner(app, (await credentialsOf(platform, tenant)).email);
    const own = await http()
      .post(`${API}/categories`)
      .set('Cookie', owner.jar.header())
      .set('X-Device-Id', owner.deviceId)
      .send({ unitId: tenant.unitId, name: `Bebidas ${crypto.randomUUID().slice(0, 6)}` })
      .expect(201);
    const ownRow = await platform.auditLog.findFirstOrThrow({
      where: { action: 'category.created', entityId: (own.body as { id: string }).id },
    });
    expect(ownRow).toMatchObject({ impersonatorId: null, impersonationId: null });
  });

  it('CA-02.08: the session expires in 60 minutes; then that cookie is refused and refresh does not extend it', async () => {
    const started = await start();
    const tab = await openPanel(started);
    const session = await platform.session.findFirstOrThrow({
      where: { impersonationId: started.impersonation.id },
    });
    expect(session.expiresAt.toISOString()).toBe(started.impersonation.expiresAt);
    // Refresh keeps the end of the impersonation.
    const refreshed = await http()
      .post(`${API}/auth/refresh`)
      .set('Cookie', tab.jar.header())
      .set('X-Device-Id', tab.deviceId)
      .expect(200);
    tab.jar.store(refreshed);
    expect(refreshed.body).toMatchObject({ expiresAt: started.impersonation.expiresAt });
    const refreshCookie = parseSetCookies(refreshed).find(
      (cookie) => cookie.name === AUTH_COOKIES.panel.refresh,
    );
    expect(Number(refreshCookie?.attributes['max-age'])).toBeLessThanOrEqual(60 * 60);

    // 60 minutes later.
    const past = new Date(Date.now() - 1_000);
    await platform.impersonationSession.update({
      where: { id: started.impersonation.id },
      data: { startedAt: new Date(past.getTime() - 60 * 60 * 1000), expiresAt: past },
    });
    await platform.session.update({ where: { id: session.id }, data: { expiresAt: past } });
    await asPanel(tab, 'get', `${API}/auth/me`).expect(401);
    await http()
      .post(`${API}/auth/refresh`)
      .set('Cookie', tab.jar.header())
      .set('X-Device-Id', tab.deviceId)
      .expect(401);

    // The job records the end for the owner's list.
    const result = await app.get(AdminTasksJob).run();
    expect(result.impersonationsExpired).toBeGreaterThanOrEqual(1);
    await expect(
      platform.impersonationSession.findUniqueOrThrow({ where: { id: started.impersonation.id } }),
    ).resolves.toMatchObject({ endedBy: 'expired', endedAt: past });
  });

  it('the access token never outlives the impersonation, even if the session row did', async () => {
    const started = await start();
    const tab = await openPanel(started);
    // The impersonation ends (expires) while the session row would still be valid.
    await platform.impersonationSession.update({
      where: { id: started.impersonation.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await asPanel(tab, 'get', `${API}/auth/me`).expect(401);
  });

  it('the admin ends it: the panel session stops at once and the socket is told (RN-02.17)', async () => {
    const started = await start();
    const tab = await openPanel(started);
    await asPanel(tab, 'get', `${API}/auth/me`).expect(200);
    const events: SessionsRevokedEvent[] = [];
    const off = app.get(AuthEvents).onSessionsRevoked((event) => events.push(event));
    try {
      const other = await adminClient(app, platform, { roles: ['support'] });
      await other
        .call('post', `${API}/admin/impersonations/${started.impersonation.id}/end`)
        .expect(403);
      const ended = await support
        .call('post', `${API}/admin/impersonations/${started.impersonation.id}/end`)
        .expect(200);
      expect(ended.body).toMatchObject({ active: false, endedBy: 'admin' });
      await asPanel(tab, 'get', `${API}/auth/me`).expect(401);
      expect(events).toEqual([
        expect.objectContaining({ subjectId: tenant.ownerId, reason: 'impersonation_ended' }),
      ]);
      const again = await support
        .call('post', `${API}/admin/impersonations/${started.impersonation.id}/end`)
        .expect(409);
      expect(errorOf(again).code).toBe('IMPERSONATION_NOT_ACTIVE');
    } finally {
      off();
    }
  });

  it('"Encerrar acesso" in the panel (logout) ends the impersonation too', async () => {
    const started = await start();
    const tab = await openPanel(started);
    await asPanel(tab, 'post', `${API}/auth/logout`).expect(204);
    await expect(
      platform.impersonationSession.findUniqueOrThrow({ where: { id: started.impersonation.id } }),
    ).resolves.toMatchObject({ endedBy: 'admin', endedAt: expect.any(Date) as Date });
    const listed = await support
      .call('get', `${API}/admin/impersonations?mine=true&active=false&limit=100`)
      .expect(200);
    expect((listed.body as { data: { id: string }[] }).data.map((item) => item.id)).toContain(
      started.impersonation.id,
    );
  });

  it('the owner password is never changed during an "entrar como"', async () => {
    const tab = await openPanel(await start());
    const response = await asPanel(tab, 'post', `${API}/auth/password/change`)
      .send({ currentPassword: 'qualquer', newPassword: 'nova-senha-123' })
      .expect(403);
    expect(errorOf(response).code).toBe('NOT_ALLOWED_DURING_IMPERSONATION');
  });

  it('an announcement read during the session is not recorded for the owner', async () => {
    const announcement = await platform.announcement.create({
      data: {
        title: 'Aviso',
        body: 'Texto',
        audienceType: 'all',
        status: 'published',
        publishAt: new Date(),
        publishedAt: new Date(),
        createdById: support.id,
      },
    });
    const tab = await openPanel(await start());
    await asPanel(tab, 'post', `${API}/announcements/${announcement.id}/read`).expect(204);
    await expect(
      platform.announcementRead.count({ where: { announcementId: announcement.id } }),
    ).resolves.toBe(0);
  });

  it('CA-02.09: the owner sees the support accesses with admin, reason and times (RN-02.22)', async () => {
    const started = await start();
    await openPanel(started);
    const owner = await loginOwner(app, (await credentialsOf(platform, tenant)).email);
    const list = await http()
      .get(`${API}/support-access?limit=100`)
      .set('Cookie', owner.jar.header())
      .set('X-Device-Id', owner.deviceId)
      .expect(200);
    const items = (list.body as { data: { id: string }[] }).data;
    expect(items[0]).toMatchObject({
      id: started.impersonation.id,
      adminName: support.name,
      reason: 'Ajuda para cadastrar o cardápio',
      startedAt: expect.any(String) as string,
      endedAt: null,
      active: true,
    });
    // Another organization never sees them (CA-01.02).
    const other = await loginOwner(app, (await credentialsOf(platform, otherTenant)).email);
    const otherList = await http()
      .get(`${API}/support-access?limit=100`)
      .set('Cookie', other.jar.header())
      .set('X-Device-Id', other.deviceId)
      .expect(200);
    expect((otherList.body as { data: unknown[] }).data).toEqual([]);
    // Staff members do not see the list.
    // RN-03.16: a staff member logs in only with an active unit.
    await platform.staffUnitPermission.create({
      data: {
        organizationId: tenant.organizationId,
        staffMemberId: tenant.staffMemberId,
        unitId: tenant.unitId,
      },
    });
    const staff = await loginStaff(app, await credentialsOf(platform, tenant));
    await http()
      .get(`${API}/support-access`)
      .set('Cookie', staff.jar.header())
      .set('X-Device-Id', staff.deviceId)
      .expect(403);
  });

  it('requires an organization with an active owner and a reason of at least 10 characters', async () => {
    const short = await support
      .call('post', `${API}/admin/impersonations`, {
        organizationId: tenant.organizationId,
        reason: 'curto',
      })
      .expect(400);
    expect(errorOf(short).code).toBe('VALIDATION_FAILED');
    await support
      .call('post', `${API}/admin/impersonations`, {
        organizationId: crypto.randomUUID(),
        reason: 'Motivo comprido o bastante',
      })
      .expect(404);
  });
});
