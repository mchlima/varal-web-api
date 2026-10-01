import { hash } from '@node-rs/argon2';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { AUTH_COOKIES } from '../../src/auth/auth-area.js';
import { AuthEvents, type SessionsRevokedEvent } from '../../src/auth/auth-events.js';
import { AuthService } from '../../src/auth/auth.service.js';
import { LOGIN_MAX_FAILURES } from '../../src/auth/login-throttle.service.js';
import { ARGON2_OPTIONS, verifyPassword } from '../../src/auth/password-hasher.js';
import { PasswordLinkService } from '../../src/auth/password-link.service.js';
import { RateLimiter } from '../../src/auth/rate-limit.js';
import { REFRESH_REUSE_GRACE_MS } from '../../src/auth/session.service.js';
import { runWithContext, systemContext } from '../../src/context/request-context.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import {
  createPlatformAdmin,
  credentialsOf,
  grantUnit,
  loginAdmin,
  loginOwner,
  loginStaff,
  newDeviceId,
  parseSetCookies,
  setPassword,
  TEST_PASSWORD,
} from '../support/auth-kit.js';
import { errorOf } from '../support/http.js';
import {
  createTenant,
  expectNotFoundForOtherTenant,
  type Tenant,
} from '../support/isolation-kit.js';
import { createTestApp } from '../support/test-app.js';
import { InfrastructureTestModule } from '../support/test-routes.js';

const databaseUrl = inject('databaseUrl');
const API = '/api/v1';
/** Stations arrive with spec 03; `station_ids` has no foreign key yet. */
const STATION_ID = '01922f2c-7a3b-7c00-8000-0000000000e1';
const STATION_ID_B = '01922f2c-7a3b-7c00-8000-0000000000e2';

describe.skipIf(!databaseUrl)('authentication (spec 01, section 7)', () => {
  let app: NestExpressApplication;
  let platform: PlatformPrismaService;
  let tenantA: Tenant;
  let tenantB: Tenant;
  let a: { accessCode: string; username: string; email: string };
  let b: { accessCode: string; username: string; email: string };
  let admin: { id: string; email: string };

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({
      auth: 'real',
      imports: [InfrastructureTestModule],
      databaseUrl: databaseUrl ?? '',
    });
    platform = app.get(PlatformPrismaService);
    tenantA = await createTenant(platform, 'Auth A');
    tenantB = await createTenant(platform, 'Auth B');
    await setPassword(platform, { owner: tenantA.ownerId, staff: tenantA.staffMemberId });
    await setPassword(platform, { owner: tenantB.ownerId, staff: tenantB.staffMemberId });
    // Staff of A and B work in their unit, with one station released.
    for (const [tenant, stationId] of [
      [tenantA, STATION_ID],
      [tenantB, STATION_ID_B],
    ] as const) {
      await platform.station.create({
        data: {
          id: stationId,
          organizationId: tenant.organizationId,
          unitId: tenant.unitId,
          name: 'Cozinha',
          kind: 'queue',
          sortOrder: 1,
        },
      });
      await platform.staffUnitPermission.create({
        data: {
          organizationId: tenant.organizationId,
          staffMemberId: tenant.staffMemberId,
          unitId: tenant.unitId,
          stationIds: [stationId],
        },
      });
    }
    a = await credentialsOf(platform, tenantA);
    b = await credentialsOf(platform, tenantB);
    admin = await createPlatformAdmin(platform);
  });

  beforeEach(() => {
    // The per-IP limit is in memory; every test here comes from 127.0.0.1.
    app.get(RateLimiter).reset();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  describe('login and cookies', () => {
    it('opens an owner session with httpOnly, Secure, SameSite=Strict cookies and no Domain (7.2)', async () => {
      const deviceId = newDeviceId();
      const response = await http()
        .post(`${API}/auth/owner/login`)
        .set('X-Device-Id', deviceId)
        .send({ email: a.email.toUpperCase(), password: TEST_PASSWORD })
        .expect(200);

      const cookies = parseSetCookies(response);
      const access = cookies.find((cookie) => cookie.name === AUTH_COOKIES.panel.access);
      const refresh = cookies.find((cookie) => cookie.name === AUTH_COOKIES.panel.refresh);
      for (const cookie of [access, refresh]) {
        expect(cookie?.attributes).toMatchObject({
          httponly: true,
          secure: true,
          samesite: 'Strict',
        });
        expect(cookie?.attributes.domain).toBeUndefined();
      }
      expect(access?.attributes.path).toBe('/');
      expect(refresh?.attributes.path).toBe('/api/v1/auth');
      expect(Number(access?.attributes['max-age'])).toBeLessThanOrEqual(15 * 60);
      expect(Number(refresh?.attributes['max-age'])).toBe(30 * 24 * 60 * 60);

      expect(response.body).toMatchObject({
        subject: { type: 'owner', id: tenantA.ownerId },
        organization: { id: tenantA.organizationId },
        session: { deviceId },
      });
      const session = await platform.session.findFirstOrThrow({
        where: { subjectId: tenantA.ownerId, deviceId },
      });
      expect(session).toMatchObject({
        subjectType: 'owner',
        organizationId: tenantA.organizationId,
      });
      // Only the hash of the refresh token is stored.
      expect(session.refreshTokenHash).not.toContain(refresh?.value.split('.')[1] ?? '-');
    });

    it('requires X-Device-Id to log in (7.2)', async () => {
      const response = await http()
        .post(`${API}/auth/owner/login`)
        .send({ email: a.email, password: TEST_PASSWORD })
        .expect(400);
      expect(errorOf(response).code).toBe('DEVICE_ID_REQUIRED');
    });

    it('gives the same answer for unknown user, wrong password and inactive user (7.3)', async () => {
      const inactive = await createTenant(platform, 'Inativo');
      await setPassword(platform, { owner: inactive.ownerId });
      const inactiveEmail = (await credentialsOf(platform, inactive)).email;
      await platform.user.update({ where: { id: inactive.ownerId }, data: { active: false } });

      const attempts = [
        { email: 'ninguem@teste.local', password: TEST_PASSWORD },
        { email: a.email, password: 'senha-errada' },
        { email: inactiveEmail, password: TEST_PASSWORD },
      ];
      const bodies = [];
      for (const attempt of attempts) {
        const response = await http()
          .post(`${API}/auth/owner/login`)
          .set('X-Device-Id', newDeviceId())
          .send(attempt)
          .expect(401);
        expect(parseSetCookies(response)).toEqual([]);
        bodies.push(response.body);
      }
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
      expect(errorOf({ body: bodies[0] }).code).toBe('INVALID_CREDENTIALS');
    });

    it('CA-01.03: staff logs in with the establishment code, username and password', async () => {
      const lookup = await http()
        .get(`${API}/auth/access-code/${a.accessCode.toLowerCase()}`)
        .expect(200);
      const organization = await platform.organization.findUniqueOrThrow({
        where: { id: tenantA.organizationId },
      });
      expect(lookup.body).toEqual({ organizationName: organization.name });

      const { body } = await loginStaff(app, {
        accessCode: a.accessCode.toLowerCase(),
        username: a.username.toUpperCase(),
      });
      expect(body).toMatchObject({
        subject: { type: 'staff', id: tenantA.staffMemberId, username: a.username },
        organization: { id: tenantA.organizationId, accessCode: a.accessCode },
        units: [
          {
            id: tenantA.unitId,
            allStations: false,
            stationIds: [STATION_ID],
            stations: [{ id: STATION_ID, name: 'Cozinha', kind: 'queue' }],
            lateAfterMinutes: 15,
          },
        ],
      });
    });

    it('answers 404 for an unknown establishment code', async () => {
      const response = await http().get(`${API}/auth/access-code/000000`).expect(404);
      expect(errorOf(response).code).toBe('NOT_FOUND');
    });

    it('refuses staff of another organization with the code of A', async () => {
      const response = await http()
        .post(`${API}/auth/staff/login`)
        .set('X-Device-Id', newDeviceId())
        .send({ accessCode: a.accessCode, username: b.username, password: TEST_PASSWORD })
        .expect(401);
      expect(errorOf(response).code).toBe('INVALID_STAFF_CREDENTIALS');
    });

    it('lets suspended and canceled organizations log in: RN-01.01 only blocks opening shifts', async () => {
      const suspended = await createTenant(platform, 'Suspensa');
      await setPassword(platform, { owner: suspended.ownerId });
      await platform.organization.update({
        where: { id: suspended.organizationId },
        data: { subscriptionStatus: 'suspended' },
      });
      const { body } = await loginOwner(app, (await credentialsOf(platform, suspended)).email);
      expect(body).toMatchObject({ organization: { subscriptionStatus: 'suspended' } });
    });

    it('rehashes the password on login when the argon2 parameters changed (plan 2.1)', async () => {
      const tenant = await createTenant(platform, 'Rehash');
      const oldHash = await hash(TEST_PASSWORD, { ...ARGON2_OPTIONS, timeCost: 3 });
      await platform.user.update({
        where: { id: tenant.ownerId },
        data: { passwordHash: oldHash },
      });
      await loginOwner(app, (await credentialsOf(platform, tenant)).email);
      const { passwordHash } = await platform.user.findUniqueOrThrow({
        where: { id: tenant.ownerId },
      });
      expect(passwordHash).not.toBe(oldHash);
      expect(passwordHash).toContain('$argon2id$v=19$m=19456,t=2,p=1$');
      await expect(verifyPassword(passwordHash, TEST_PASSWORD)).resolves.toBe(true);
    });

    it('audits login and logout with actor, device and session (spec 01, section 8)', async () => {
      const { jar, deviceId } = await loginOwner(app, a.email);
      await http()
        .post(`${API}/auth/logout`)
        .set('Cookie', jar.header())
        .set('X-Device-Id', deviceId)
        .expect(204);
      const rows = await platform.auditLog.findMany({
        where: {
          actorId: tenantA.ownerId,
          deviceId,
          action: { in: ['auth.login', 'auth.logout'] },
        },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((row) => row.action)).toEqual(['auth.login', 'auth.logout']);
      expect(rows.every((row) => row.organizationId === tenantA.organizationId)).toBe(true);
      expect(rows.every((row) => row.actorType === 'owner' && row.entityType === 'session')).toBe(
        true,
      );
    });
  });

  describe('lock after 10 wrong attempts in a row (7.3)', () => {
    it('locks the identifier for 15 minutes, even with the right password, and unlocks after', async () => {
      const tenant = await createTenant(platform, 'Bloqueio');
      await setPassword(platform, { owner: tenant.ownerId });
      const { email } = await credentialsOf(platform, tenant);
      const attempt = (password: string) =>
        http()
          .post(`${API}/auth/owner/login`)
          .set('X-Device-Id', newDeviceId())
          .send({ email, password });

      for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
        expect((await attempt('errada')).status).toBe(401);
      }
      const locked = await attempt(TEST_PASSWORD).expect(429);
      expect(errorOf(locked).code).toBe('LOGIN_TEMPORARILY_LOCKED');
      expect(errorOf(locked).details).toMatchObject({
        retryAfterSeconds: expect.any(Number) as number,
      });

      // 15 minutes later (moved in the database).
      await platform.loginThrottle.updateMany({
        where: { lockedUntil: { not: null } },
        data: { lockedUntil: new Date(Date.now() - 60 * 60_000) },
      });
      await attempt(TEST_PASSWORD).expect(200);
    });

    it('locks unknown identifiers the same way, so the lock does not reveal who exists', async () => {
      const email = `nao-existe.${crypto.randomUUID().slice(0, 8)}@teste.local`;
      for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
        await http()
          .post(`${API}/auth/owner/login`)
          .set('X-Device-Id', newDeviceId())
          .send({ email, password: 'x' })
          .expect(401);
      }
      const response = await http()
        .post(`${API}/auth/owner/login`)
        .set('X-Device-Id', newDeviceId())
        .send({ email, password: 'x' })
        .expect(429);
      expect(errorOf(response).code).toBe('LOGIN_TEMPORARILY_LOCKED');
    });

    it('resets the count after a successful login ("seguidas")', async () => {
      const tenant = await createTenant(platform, 'Reinicia');
      await setPassword(platform, { owner: tenant.ownerId });
      const { email } = await credentialsOf(platform, tenant);
      const attempt = (password: string) =>
        http()
          .post(`${API}/auth/owner/login`)
          .set('X-Device-Id', newDeviceId())
          .send({ email, password });
      for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) {
        await attempt('errada').expect(401);
      }
      await attempt(TEST_PASSWORD).expect(200);
      for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) {
        await attempt('errada').expect(401);
      }
      await attempt(TEST_PASSWORD).expect(200);
    });

    it('limits logins per IP in memory (RATE_LIMITED)', async () => {
      let last = 0;
      for (let i = 0; i < 21; i++) {
        last = (
          await http()
            .post(`${API}/auth/owner/login`)
            .set('X-Device-Id', newDeviceId())
            .send({ email: `limite${i}@teste.local`, password: 'x' })
        ).status;
      }
      expect(last).toBe(429);
    });
  });

  describe('separate contexts (CA-01.04)', () => {
    it('refuses a panel session on admin routes', async () => {
      const { jar } = await loginOwner(app, a.email);
      await http().get(`${API}/auth/me`).set('Cookie', jar.header()).expect(200);
      for (const path of ['/admin/auth/me', '/admin/emails/usage', '/ADMIN/auth/me']) {
        const response = await http().get(`${API}${path}`).set('Cookie', jar.header()).expect(401);
        expect(errorOf(response).code).toBe('UNAUTHENTICATED');
      }
      // The panel token under the admin cookie name: other secret and audience.
      await http()
        .get(`${API}/admin/auth/me`)
        .set('Cookie', `${AUTH_COOKIES.admin.access}=${jar.access ?? ''}`)
        .expect(401);
    });

    it('refuses an admin session on panel routes', async () => {
      const { jar } = await loginAdmin(app, admin.email);
      const me = await http().get(`${API}/admin/auth/me`).set('Cookie', jar.header()).expect(200);
      expect(me.body).toMatchObject({ admin: { id: admin.id, email: admin.email } });
      await http().get(`${API}/auth/me`).set('Cookie', jar.header()).expect(401);
      await http()
        .get(`${API}/auth/me`)
        .set('Cookie', `${AUTH_COOKIES.panel.access}=${jar.access ?? ''}`)
        .expect(401);
      // The admin refresh token does not renew a panel session either.
      await http()
        .post(`${API}/auth/refresh`)
        .set('Cookie', `${AUTH_COOKIES.panel.refresh}=${jar.refresh ?? ''}`)
        .expect(401);
    });

    it('does not let an owner or staff log in to the admin, nor an admin to the panel', async () => {
      await http()
        .post(`${API}/admin/auth/login`)
        .set('X-Device-Id', newDeviceId())
        .send({ email: a.email, password: TEST_PASSWORD })
        .expect(401);
      await http()
        .post(`${API}/auth/owner/login`)
        .set('X-Device-Id', newDeviceId())
        .send({ email: admin.email, password: TEST_PASSWORD })
        .expect(401);
    });
  });

  describe('isolation between organizations over HTTP (CA-01.02)', () => {
    it('GET /auth/me shows only the organization of the token', async () => {
      const { jar } = await loginStaff(app, { accessCode: b.accessCode, username: b.username });
      const response = await http().get(`${API}/auth/me`).set('Cookie', jar.header()).expect(200);
      expect(response.body).toMatchObject({
        organization: { id: tenantB.organizationId },
        units: [{ id: tenantB.unitId }],
      });
      expect(JSON.stringify(response.body)).not.toContain(tenantA.organizationId);
      expect(JSON.stringify(response.body)).not.toContain(tenantA.unitId);
    });

    it('a staff member of B with a valid session gets 404 for a unit of A', async () => {
      const { jar, deviceId } = await loginStaff(app, {
        accessCode: b.accessCode,
        username: b.username,
      });
      await expectNotFoundForOtherTenant(app, {
        method: 'get',
        path: `${API}/test/units/${tenantA.unitId}`,
        headers: { Cookie: jar.header(), 'X-Device-Id': deviceId },
      });
      await http()
        .get(`${API}/test/units/${tenantB.unitId}`)
        .set('Cookie', jar.header())
        .expect(200);
    });

    it('protected routes need a session', async () => {
      await http().get(`${API}/test/units/${tenantA.unitId}`).expect(401);
      await http().get(`${API}/auth/me`).expect(401);
    });

    it('refuses a session cookie used from another device', async () => {
      const { jar } = await loginOwner(app, a.email);
      await http()
        .get(`${API}/auth/me`)
        .set('Cookie', jar.header())
        .set('X-Device-Id', newDeviceId())
        .expect(401);
    });
  });

  describe('refresh rotation (7.2)', () => {
    it('rotates the refresh token and keeps the session', async () => {
      const { jar } = await loginOwner(app, a.email);
      const before = jar.refresh;
      const response = await http()
        .post(`${API}/auth/refresh`)
        .set('Cookie', jar.header())
        .expect(200);
      jar.store(response);
      expect(jar.refresh).toBeDefined();
      expect(jar.refresh).not.toBe(before);
      await http().get(`${API}/auth/me`).set('Cookie', jar.header()).expect(200);
    });

    it('refuses a rotated token right after the rotation without ending the session (concurrent refresh)', async () => {
      const { jar } = await loginOwner(app, a.email);
      const old = jar.clone();
      jar.store(await http().post(`${API}/auth/refresh`).set('Cookie', jar.header()).expect(200));
      await http().post(`${API}/auth/refresh`).set('Cookie', old.header()).expect(401);
      // The current token still works.
      await http().post(`${API}/auth/refresh`).set('Cookie', jar.header()).expect(200);
    });

    it('revokes the session when a rotated token is reused later (theft)', async () => {
      const events: SessionsRevokedEvent[] = [];
      const stop = app.get(AuthEvents).onSessionsRevoked((event) => events.push(event));
      try {
        const { jar } = await loginOwner(app, a.email);
        const stolen = jar.clone();
        jar.store(await http().post(`${API}/auth/refresh`).set('Cookie', jar.header()).expect(200));
        const sessionId = (jar.refresh ?? '').split('.')[0] ?? '';
        // The grace window has passed.
        await platform.session.update({
          where: { id: sessionId },
          data: { refreshedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 1000) },
        });

        await http().post(`${API}/auth/refresh`).set('Cookie', stolen.header()).expect(401);

        const session = await platform.session.findUniqueOrThrow({ where: { id: sessionId } });
        expect(session.revokedReason).toBe('refresh_token_reused');
        // Both the legitimate device and the thief are out.
        await http().get(`${API}/auth/me`).set('Cookie', jar.header()).expect(401);
        await http().post(`${API}/auth/refresh`).set('Cookie', jar.header()).expect(401);
        expect(events).toContainEqual(
          expect.objectContaining({ sessionIds: [sessionId], reason: 'refresh_token_reused' }),
        );
        await expect(
          platform.auditLog.count({
            where: { action: 'auth.sessions_revoked', entityId: tenantA.ownerId },
          }),
        ).resolves.toBeGreaterThan(0);
      } finally {
        stop();
      }
    });

    it('clears the cookies when the refresh fails', async () => {
      const response = await http()
        .post(`${API}/auth/refresh`)
        .set('Cookie', `${AUTH_COOKIES.panel.refresh}=lixo`)
        .expect(401);
      const cleared = parseSetCookies(response).map((cookie) => cookie.name);
      expect(cleared).toEqual(
        expect.arrayContaining([AUTH_COOKIES.panel.access, AUTH_COOKIES.panel.refresh]),
      );
    });

    it('a new login on the same device replaces the previous session', async () => {
      const deviceId = newDeviceId();
      const first = await loginOwner(app, a.email, TEST_PASSWORD, deviceId);
      await loginOwner(app, a.email, TEST_PASSWORD, deviceId);
      await http().get(`${API}/auth/me`).set('Cookie', first.jar.header()).expect(401);
    });
  });

  describe('logout (7.2)', () => {
    it('ends only the session of this device', async () => {
      const phone = await loginOwner(app, a.email);
      const tablet = await loginOwner(app, a.email);
      const response = await http()
        .post(`${API}/auth/logout`)
        .set('Cookie', phone.jar.header())
        .expect(204);
      phone.jar.store(response);
      expect(phone.jar.access).toBeUndefined();
      await http().get(`${API}/auth/me`).set('Cookie', phone.jar.header()).expect(401);
      await http().get(`${API}/auth/me`).set('Cookie', tablet.jar.header()).expect(200);
    });

    it('works with only the refresh token (access already expired) and without any cookie', async () => {
      const { jar } = await loginOwner(app, a.email);
      await http()
        .post(`${API}/auth/logout`)
        .set('Cookie', `${AUTH_COOKIES.panel.refresh}=${jar.refresh ?? ''}`)
        .expect(204);
      await http().post(`${API}/auth/refresh`).set('Cookie', jar.header()).expect(401);
      await http().post(`${API}/auth/logout`).expect(204);
    });

    it('admin logout ends the admin session', async () => {
      const { jar } = await loginAdmin(app, admin.email);
      await http().post(`${API}/admin/auth/logout`).set('Cookie', jar.header()).expect(204);
      await http().get(`${API}/admin/auth/me`).set('Cookie', jar.header()).expect(401);
    });
  });

  describe('password change and reset end every session (CA-01.05)', () => {
    it('change: other devices are logged out at once and their refresh is refused; this device continues', async () => {
      const tenant = await createTenant(platform, 'Troca');
      await setPassword(platform, { owner: tenant.ownerId });
      const { email } = await credentialsOf(platform, tenant);
      const other = await loginOwner(app, email);
      const current = await loginOwner(app, email);

      const wrong = await http()
        .post(`${API}/auth/password/change`)
        .set('Cookie', current.jar.header())
        .send({ currentPassword: 'errada', newPassword: 'nova-senha-123' })
        .expect(400);
      expect(errorOf(wrong).code).toBe('WRONG_CURRENT_PASSWORD');

      const changed = await http()
        .post(`${API}/auth/password/change`)
        .set('Cookie', current.jar.header())
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'nova-senha-123' })
        .expect(200);
      const renewed = current.jar.clone().store(changed);

      await http().get(`${API}/auth/me`).set('Cookie', other.jar.header()).expect(401);
      await http().post(`${API}/auth/refresh`).set('Cookie', other.jar.header()).expect(401);
      await http().get(`${API}/auth/me`).set('Cookie', current.jar.header()).expect(401);
      await http().get(`${API}/auth/me`).set('Cookie', renewed.header()).expect(200);
      await loginOwner(app, email, 'nova-senha-123');
      await expect(
        platform.auditLog.count({
          where: { action: 'auth.password_changed', entityId: tenant.ownerId },
        }),
      ).resolves.toBe(1);
    });

    it('change: rejects a new password shorter than 8 characters (7.3)', async () => {
      const { jar } = await loginOwner(app, a.email);
      const response = await http()
        .post(`${API}/auth/password/change`)
        .set('Cookie', jar.header())
        .send({ currentPassword: TEST_PASSWORD, newPassword: '1234567' })
        .expect(400);
      expect(errorOf(response)).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { fields: [{ path: 'newPassword' }] },
      });
    });

    it('owner resets a staff password: the staff sessions end, refresh is refused, the link works once', async () => {
      const tenant = await createTenant(platform, 'Reset colaborador');
      await grantUnit(platform, tenant);
      await setPassword(platform, { owner: tenant.ownerId, staff: tenant.staffMemberId });
      const credentials = await credentialsOf(platform, tenant);
      const staffSession = await loginStaff(app, credentials);
      const events: SessionsRevokedEvent[] = [];
      const stop = app.get(AuthEvents).onSessionsRevoked((event) => events.push(event));
      try {
        // As the owner of the organization (the endpoint arrives with spec 03).
        const issued = await runWithContext(systemContext({ auth: tenant.ownerAuth }), () =>
          app
            .get(PasswordLinkService)
            .issueStaffPasswordReset(tenant.staffMemberId, { sendEmail: false }),
        );
        expect(issued.link).toMatch(
          /^http:\/\/localhost:3100\/definir-senha#token=[A-Za-z0-9_-]{43}&tipo=redefinicao$/,
        );
        expect(issued.emailLogId).toBeNull();
        // The session still works until the new password is defined.
        await http().get(`${API}/auth/me`).set('Cookie', staffSession.jar.header()).expect(200);

        const token = /token=([^&]+)/.exec(new URL(issued.link).hash)?.[1] ?? '';
        await http()
          .post(`${API}/auth/password/reset`)
          .send({ token, password: 'outra-senha-123' })
          .expect(204);

        await http().get(`${API}/auth/me`).set('Cookie', staffSession.jar.header()).expect(401);
        await http()
          .post(`${API}/auth/refresh`)
          .set('Cookie', staffSession.jar.header())
          .expect(401);
        expect(events).toContainEqual(
          expect.objectContaining({ subjectId: tenant.staffMemberId, reason: 'password_reset' }),
        );
        await loginStaff(app, credentials, 'outra-senha-123');

        // Single use (CA-03.08).
        const reused = await http()
          .post(`${API}/auth/password/reset`)
          .send({ token, password: 'terceira-senha' })
          .expect(400);
        expect(errorOf(reused).code).toBe('INVALID_PASSWORD_TOKEN');
      } finally {
        stop();
      }
    });

    it('deactivating a staff member ends the sessions at once (RN-03.17, service for spec 03)', async () => {
      const tenant = await createTenant(platform, 'Desativa');
      await grantUnit(platform, tenant);
      await setPassword(platform, { staff: tenant.staffMemberId });
      const staffSession = await loginStaff(app, await credentialsOf(platform, tenant));
      const events: SessionsRevokedEvent[] = [];
      const stop = app.get(AuthEvents).onSessionsRevoked((event) => events.push(event));
      try {
        const { notify, sessionIds } = await platform.$transaction(async (tx) => {
          await tx.staffMember.update({
            where: { id: tenant.staffMemberId },
            data: { active: false },
          });
          return app.get(AuthService).revokeSessionsInTransaction(
            tx,
            {
              subjectType: 'staff',
              subjectId: tenant.staffMemberId,
              organizationId: tenant.organizationId,
            },
            'staff_deactivated',
          );
        });
        notify();
        expect(sessionIds).toHaveLength(1);
        await http().get(`${API}/auth/me`).set('Cookie', staffSession.jar.header()).expect(401);
        await http()
          .post(`${API}/auth/refresh`)
          .set('Cookie', staffSession.jar.header())
          .expect(401);
        expect(events).toContainEqual(
          expect.objectContaining({ sessionIds, reason: 'staff_deactivated' }),
        );
      } finally {
        stop();
      }
    });

    it('staff reset of another organization is a 404 (CA-01.02)', async () => {
      await expect(
        runWithContext(systemContext({ auth: tenantB.ownerAuth }), () =>
          app
            .get(PasswordLinkService)
            .issueStaffPasswordReset(tenantA.staffMemberId, { sendEmail: false }),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a new link invalidates the previous one of the same purpose (7.4)', async () => {
      const tenant = await createTenant(platform, 'Link novo');
      const issue = () =>
        runWithContext(systemContext({ auth: tenant.ownerAuth }), () =>
          app
            .get(PasswordLinkService)
            .issueStaffPasswordReset(tenant.staffMemberId, { sendEmail: false }),
        );
      const tokenOf = (link: string) => /token=([^&]+)/.exec(new URL(link).hash)?.[1] ?? '';
      const first = tokenOf((await issue()).link);
      const second = tokenOf((await issue()).link);
      await http()
        .post(`${API}/auth/password/reset`)
        .send({ token: first, password: 'senha-nova-1' })
        .expect(400);
      await http()
        .post(`${API}/auth/password/reset`)
        .send({ token: second, password: 'senha-nova-1' })
        .expect(204);
    });

    it('RN-01.02: at most 3 reset links per user per hour', async () => {
      const tenant = await createTenant(platform, 'Limite links');
      const issue = () =>
        runWithContext(systemContext({ auth: tenant.ownerAuth }), () =>
          app
            .get(PasswordLinkService)
            .issueStaffPasswordReset(tenant.staffMemberId, { sendEmail: false }),
        );
      await issue();
      await issue();
      await issue();
      await expect(issue()).rejects.toMatchObject({ code: 'PASSWORD_RESET_LIMIT_REACHED' });
      // An hour later it works again.
      await platform.passwordToken.updateMany({
        where: { subjectId: tenant.staffMemberId },
        data: { createdAt: new Date(Date.now() - 61 * 60 * 1000) },
      });
      await expect(issue()).resolves.toMatchObject({ link: expect.any(String) as string });
    });

    it('panel reset refuses admin tokens and expired tokens', async () => {
      const service = app.get(PasswordLinkService);
      const adminLink = await platform.$transaction((tx) => service.issueAdminInvite(tx, admin.id));
      const adminToken = /token=([^&]+)/.exec(new URL(adminLink.link).hash)?.[1] ?? '';
      expect(adminLink.link.startsWith('http://localhost:3200/definir-senha#token=')).toBe(true);
      await http()
        .post(`${API}/auth/password/reset`)
        .send({ token: adminToken, password: 'senha-nova-1' })
        .expect(400);

      const ownerLink = await platform.$transaction((tx) =>
        service.issueOwnerInvite(tx, tenantB.ownerId),
      );
      const ownerToken = /token=([^&]+)/.exec(new URL(ownerLink.link).hash)?.[1] ?? '';
      await platform.passwordToken.updateMany({
        where: { subjectId: tenantB.ownerId, usedAt: null },
        data: { expiresAt: new Date(Date.now() - 60 * 60_000) },
      });
      await http()
        .post(`${API}/auth/password/reset`)
        .send({ token: ownerToken, password: 'senha-nova-1' })
        .expect(400);
      // Back to the original password for the other tests.
      await setPassword(platform, { owner: tenantB.ownerId });
    });
  });

  describe('"Esqueci a senha" (RN-01.03)', () => {
    it('answers the same for an existing and an unknown e-mail', async () => {
      const tenant = await createTenant(platform, 'Esqueci');
      const { email } = await credentialsOf(platform, tenant);
      const known = await http().post(`${API}/auth/password/forgot`).send({ email }).expect(202);
      const unknown = await http()
        .post(`${API}/auth/password/forgot`)
        .send({ email: 'ninguem.mesmo@teste.local' })
        .expect(202);
      expect(unknown.body).toEqual(known.body);
      expect(known.body).toEqual({
        message: expect.stringContaining('Se este e-mail estiver cadastrado') as string,
      });
      await expect(
        platform.passwordToken.count({ where: { subjectId: tenant.ownerId, purpose: 'reset' } }),
      ).resolves.toBe(1);
      await expect(
        platform.emailLog.count({
          where: { organizationId: tenant.organizationId, type: 'owner_password_reset' },
        }),
      ).resolves.toBe(1);
    });

    it('keeps answering the same after the 3 links of the hour (RN-01.02), without a 4th link', async () => {
      const tenant = await createTenant(platform, 'Esqueci 4x');
      const { email } = await credentialsOf(platform, tenant);
      for (let i = 0; i < 4; i++) {
        await http().post(`${API}/auth/password/forgot`).send({ email }).expect(202);
      }
      await expect(
        platform.passwordToken.count({ where: { subjectId: tenant.ownerId } }),
      ).resolves.toBe(3);
    });

    it('admin forgot works the same in the admin context', async () => {
      const response = await http()
        .post(`${API}/admin/auth/password/forgot`)
        .send({ email: 'ninguem@teste.local' })
        .expect(202);
      expect(response.body).toHaveProperty('message');
    });
  });

  describe('GET /admin/emails/usage', () => {
    it('needs the admin session', async () => {
      await http().get(`${API}/admin/emails/usage`).expect(401);
      const { jar } = await loginAdmin(app, admin.email);
      const response = await http()
        .get(`${API}/admin/emails/usage`)
        .set('Cookie', jar.header())
        .expect(200);
      expect(response.body).toMatchObject({ limit: 10_000, warningThreshold: 8_000 });
      await http()
        .get(`${API}/admin/emails/usage?month=2026-13`)
        .set('Cookie', jar.header())
        .expect(400);
    });
  });
});
