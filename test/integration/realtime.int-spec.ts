import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import { AccessTokenService } from '../../src/auth/access-token.service.js';
import { ACCESS_TOKEN_TTL_SECONDS, AUTH_COOKIES } from '../../src/auth/auth-area.js';
import { AuthService } from '../../src/auth/auth.service.js';
import { RateLimiter } from '../../src/auth/rate-limit.js';
import { runWithContext, systemContext } from '../../src/context/request-context.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  defineRealtimeEvent,
  EventSessionExpiredSchema,
  EventSessionRevokedSchema,
  type RealtimeRoomAck,
} from '../../src/realtime/realtime.contracts.js';
import { RealtimeService } from '../../src/realtime/realtime.service.js';
import {
  credentialsOf,
  type LoggedIn,
  loginOwner,
  loginStaff,
  setPassword,
  TEST_PASSWORD,
} from '../support/auth-kit.js';
import { createTenant, type Tenant } from '../support/isolation-kit.js';
import {
  connect,
  connectFailure,
  listen,
  nextDisconnect,
  nextEvent,
  recordEvents,
  request as ask,
  settle,
} from '../support/socket-kit.js';
import { createTestApp } from '../support/test-app.js';

const databaseUrl = inject('databaseUrl');
const API = '/api/v1';
/** Fixed ids of the stations created in `beforeAll` (A1 and B1 active, A2 in an inactive unit). */
const STATION_A1 = '01922f2c-7a3b-7c00-8000-00000000a001';
const STATION_A2 = '01922f2c-7a3b-7c00-8000-00000000a002';
const STATION_B1 = '01922f2c-7a3b-7c00-8000-00000000b001';

/** Test-only event: no business event exists in phase 1c. */
const TestPing = defineRealtimeEvent('EventTestPing', 'test.ping', z.object({ n: z.int() }));

describe.skipIf(!databaseUrl)('real time (spec 01, section 10)', () => {
  let app: NestExpressApplication;
  let url: string;
  let platform: PlatformPrismaService;
  let realtime: RealtimeService;
  let tenantA: Tenant;
  let tenantB: Tenant;
  /** Second active unit of A (no staff permission) and an inactive one. */
  let unitA2: string;
  let unitA3Inactive: string;
  const sockets: Socket[] = [];

  const http = () => request(app.getHttpServer());

  /** Connects with the session of a login, as the app would. */
  async function open(login: LoggedIn): Promise<Socket> {
    const socket = await connect(url, { cookie: login.jar.header(), deviceId: login.deviceId });
    sockets.push(socket);
    return socket;
  }

  function sessionIdOf(login: LoggedIn): string {
    return (login.body as { session: { id: string } }).session.id;
  }

  async function roomsOf(login: LoggedIn): Promise<string[]> {
    const [rooms = []] = await realtime.roomsOfSession(sessionIdOf(login));
    return rooms;
  }

  beforeAll(async () => {
    app = await createTestApp({ auth: 'real', databaseUrl: databaseUrl ?? '' });
    url = await listen(app);
    platform = app.get(PlatformPrismaService);
    realtime = app.get(RealtimeService);
    tenantA = await createTenant(platform, 'Realtime A');
    tenantB = await createTenant(platform, 'Realtime B');
    unitA2 = (
      await platform.unit.create({
        data: { organizationId: tenantA.organizationId, name: `A2 ${crypto.randomUUID()}` },
      })
    ).id;
    unitA3Inactive = (
      await platform.unit.create({
        data: {
          organizationId: tenantA.organizationId,
          name: `A3 ${crypto.randomUUID()}`,
          active: false,
        },
      })
    ).id;
    for (const tenant of [tenantA, tenantB]) {
      await setPassword(platform, { owner: tenant.ownerId, staff: tenant.staffMemberId });
    }
    await platform.station.createMany({
      data: [
        {
          id: STATION_A1,
          organizationId: tenantA.organizationId,
          unitId: tenantA.unitId,
          name: 'Cozinha',
          kind: 'queue',
          sortOrder: 1,
        },
        {
          id: STATION_A2,
          organizationId: tenantA.organizationId,
          unitId: unitA3Inactive,
          name: 'Cozinha',
          kind: 'queue',
          sortOrder: 1,
        },
        {
          id: STATION_B1,
          organizationId: tenantB.organizationId,
          unitId: tenantB.unitId,
          name: 'Cozinha',
          kind: 'queue',
          sortOrder: 1,
        },
      ],
    });
    // Staff of A: unit A1 with station A1; also a permission on the inactive unit (ignored).
    await platform.staffUnitPermission.createMany({
      data: [
        {
          organizationId: tenantA.organizationId,
          staffMemberId: tenantA.staffMemberId,
          unitId: tenantA.unitId,
          stationIds: [STATION_A1],
        },
        {
          organizationId: tenantA.organizationId,
          staffMemberId: tenantA.staffMemberId,
          unitId: unitA3Inactive,
          stationIds: [STATION_A2],
        },
        {
          organizationId: tenantB.organizationId,
          staffMemberId: tenantB.staffMemberId,
          unitId: tenantB.unitId,
          stationIds: [STATION_B1],
        },
      ],
    });
  });

  beforeEach(() => {
    app.get(RateLimiter).reset();
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) {
      socket.close();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  async function ownerOf(tenant: Tenant): Promise<LoggedIn> {
    return loginOwner(app, (await credentialsOf(platform, tenant)).email);
  }

  async function staffOf(tenant: Tenant): Promise<LoggedIn> {
    return loginStaff(app, await credentialsOf(platform, tenant));
  }

  describe('handshake', () => {
    it('accepts the session cookie with the device of the session', async () => {
      const owner = await ownerOf(tenantA);
      const socket = await open(owner);
      expect(socket.connected).toBe(true);
    });

    it('refuses another device id than the one of the session', async () => {
      const owner = await ownerOf(tenantA);
      const failure = await connectFailure(url, {
        cookie: owner.jar.header(),
        deviceId: crypto.randomUUID(),
      });
      expect(failure.data?.error?.code).toBe('UNAUTHENTICATED');
    });

    it('refuses a revoked session (logout) even with an unexpired token', async () => {
      const owner = await ownerOf(tenantA);
      await http().post(`${API}/auth/logout`).set('Cookie', owner.jar.header()).expect(204);
      const failure = await connectFailure(url, {
        cookie: owner.jar.header(),
        deviceId: owner.deviceId,
      });
      expect(failure.data?.error?.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('rooms', () => {
    it('owner joins every active unit and station of the organization, nothing of others', async () => {
      const owner = await ownerOf(tenantA);
      await open(owner);
      // Spec 03: the owner opens any station, so it is in every active station of the active units
      // (not in A2, whose unit is inactive).
      expect(await roomsOf(owner)).toEqual(
        [`station:${STATION_A1}`, `unit:${tenantA.unitId}`, `unit:${unitA2}`].sort(),
      );
    });

    it('staff joins only the active units of its permissions and their stations', async () => {
      const staff = await staffOf(tenantA);
      await open(staff);
      expect(await roomsOf(staff)).toEqual([`station:${STATION_A1}`, `unit:${tenantA.unitId}`]);
    });

    it('a room of another organization is refused (CA-01.02)', async () => {
      const staff = await staffOf(tenantA);
      const socket = await open(staff);
      for (const room of [`unit:${tenantB.unitId}`, `station:${STATION_B1}`]) {
        const ack = await ask<RealtimeRoomAck>(socket, 'rooms.join', { room });
        expect(ack).toEqual({
          ok: false,
          error: {
            code: 'ROOM_FORBIDDEN',
            message: 'Você não tem acesso a esta sala.',
            details: {},
          },
        });
      }
      const owner = await ownerOf(tenantA);
      const ownerSocket = await open(owner);
      const ack = await ask<RealtimeRoomAck>(ownerSocket, 'rooms.join', {
        room: `unit:${tenantB.unitId}`,
      });
      expect(ack.ok).toBe(false);
      expect(await roomsOf(owner)).not.toContain(`unit:${tenantB.unitId}`);
    });

    it('staff cannot join units or stations of its organization without permission', async () => {
      const staff = await staffOf(tenantA);
      const socket = await open(staff);
      for (const room of [`unit:${unitA2}`, `unit:${unitA3Inactive}`, `station:${STATION_A2}`]) {
        const ack = await ask<RealtimeRoomAck>(socket, 'rooms.join', { room });
        expect(ack).toMatchObject({ ok: false, error: { code: 'ROOM_FORBIDDEN' } });
      }
    });

    it('leaves and joins back an allowed room; validates the request', async () => {
      const staff = await staffOf(tenantA);
      const socket = await open(staff);
      const left = await ask<RealtimeRoomAck>(socket, 'rooms.leave', {
        room: `station:${STATION_A1}`,
      });
      expect(left).toEqual({ ok: true, rooms: [`unit:${tenantA.unitId}`] });
      const joined = await ask<RealtimeRoomAck>(socket, 'rooms.join', {
        room: `station:${STATION_A1.toUpperCase()}`,
      });
      expect(joined).toEqual({
        ok: true,
        rooms: [`station:${STATION_A1}`, `unit:${tenantA.unitId}`],
      });
      for (const body of [
        { room: `session:${sessionIdOf(staff)}` },
        { room: 'unit:nao-e-uuid' },
        { sala: 'x' },
        'unit',
        null,
      ]) {
        const ack = await ask<RealtimeRoomAck>(socket, 'rooms.join', body);
        expect(ack).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      }
    });
  });

  describe('emission', () => {
    function asTenant<T>(tenant: Tenant, fn: () => Promise<T> | T): Promise<T> {
      return runWithContext(systemContext({ auth: tenant.ownerAuth }), async () => await fn());
    }

    it('an event reaches only the sockets in its room, with the envelope', async () => {
      const ownerA = await ownerOf(tenantA);
      const staffA = await staffOf(tenantA);
      const ownerB = await ownerOf(tenantB);
      const [ownerSocket, staffSocket, otherSocket] = [
        await open(ownerA),
        await open(staffA),
        await open(ownerB),
      ];
      const received = [ownerSocket, staffSocket, otherSocket].map(recordEvents);

      const arrival = nextEvent(staffSocket, 'test.ping');
      await asTenant(tenantA, () => {
        realtime.emitToUnit(TestPing, { unitId: tenantA.unitId, version: 3, data: { n: 1 } });
      });
      const envelope = await arrival;
      expect(envelope).toEqual({
        type: 'test.ping',
        organizationId: tenantA.organizationId,
        unitId: tenantA.unitId,
        occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/) as unknown,
        version: 3,
        data: { n: 1 },
      });

      // Unit A2: only the owner of A. Station A1: the staff of A and the owner (who opens any
      // station, spec 03).
      await asTenant(tenantA, () => {
        realtime.emitToUnit(TestPing, { unitId: unitA2, version: 1, data: { n: 2 } });
        realtime.emitToStation(STATION_A1, TestPing, {
          unitId: tenantA.unitId,
          version: 1,
          data: { n: 3 },
        });
      });
      await settle();
      const numbers = received.map((events) =>
        events
          .filter((event) => event.name === 'test.ping')
          .map((event) => (event.payload as { data: { n: number } }).data.n),
      );
      expect(numbers).toEqual([[1, 2, 3], [1, 3], []]);
    });

    it('validates the payload with the event schema', async () => {
      await expect(
        asTenant(tenantA, () => {
          realtime.emitToUnit(TestPing, {
            unitId: tenantA.unitId,
            version: 1,
            data: { n: 'um' } as unknown as { n: number },
          });
        }),
      ).rejects.toThrow();
    });

    it('emits only after the commit; a rolled-back transaction emits nothing', async () => {
      const owner = await ownerOf(tenantA);
      const socket = await open(owner);
      const events = recordEvents(socket);
      const prisma = app.get(PrismaService);

      await expect(
        asTenant(tenantA, () =>
          prisma.transaction(async (tx) => {
            await tx.unit.update({ where: { id: unitA2 }, data: { lateAfterMinutes: 20 } });
            realtime.emitToUnit(TestPing, { unitId: unitA2, version: 2, data: { n: 10 } });
            throw new Error('desfaz');
          }),
        ),
      ).rejects.toThrow('desfaz');
      await settle();
      expect(events).toEqual([]);

      await asTenant(tenantA, () =>
        prisma.transaction(async (tx) => {
          await tx.unit.update({ where: { id: unitA2 }, data: { lateAfterMinutes: 25 } });
          realtime.emitToUnit(TestPing, { unitId: unitA2, version: 3, data: { n: 11 } });
          await settle();
          // Still inside the transaction: nothing was sent yet.
          expect(events).toEqual([]);
        }),
      );
      await settle();
      expect(events.map((event) => event.name)).toEqual(['test.ping']);
    });
  });

  describe('disconnection (CA-01.05)', () => {
    it('logout: the socket gets session.revoked and is disconnected at once', async () => {
      const owner = await ownerOf(tenantA);
      const socket = await open(owner);
      const revoked = nextEvent(socket, 'session.revoked');
      const disconnected = nextDisconnect(socket);
      await http().post(`${API}/auth/logout`).set('Cookie', owner.jar.header()).expect(204);
      expect(EventSessionRevokedSchema.parse(await revoked).data.reason).toBe('logout');
      expect(await disconnected).toBe('io server disconnect');
    });

    it('password change disconnects every socket of the user; other users stay', async () => {
      const tenant = await createTenant(platform, 'Realtime troca de senha');
      await setPassword(platform, { owner: tenant.ownerId, staff: tenant.staffMemberId });
      await platform.staffUnitPermission.create({
        data: {
          organizationId: tenant.organizationId,
          staffMemberId: tenant.staffMemberId,
          unitId: tenant.unitId,
        },
      });
      const phone = await ownerOf(tenant);
      const tablet = await ownerOf(tenant);
      const staff = await staffOf(tenant);
      const [phoneSocket, tabletSocket, staffSocket] = [
        await open(phone),
        await open(tablet),
        await open(staff),
      ];
      const reasons = [phoneSocket, tabletSocket].map((socket) =>
        nextEvent(socket, 'session.revoked'),
      );
      const disconnections = [phoneSocket, tabletSocket].map((socket) => nextDisconnect(socket));

      await http()
        .post(`${API}/auth/password/change`)
        .set('Cookie', phone.jar.header())
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'nova-senha-123' })
        .expect(200);

      for (const reason of await Promise.all(reasons)) {
        expect(EventSessionRevokedSchema.parse(reason).data.reason).toBe('password_changed');
      }
      expect(await Promise.all(disconnections)).toEqual([
        'io server disconnect',
        'io server disconnect',
      ]);
      await settle();
      expect(staffSocket.connected).toBe(true);
    });

    it('deactivation (revokeSessionsInTransaction) disconnects the staff sockets', async () => {
      const staff = await staffOf(tenantB);
      const socket = await open(staff);
      const revoked = nextEvent(socket, 'session.revoked');
      const disconnected = nextDisconnect(socket);
      const auth = app.get(AuthService);
      const notify = await platform.$transaction(async (tx) => {
        const result = await auth.revokeSessionsInTransaction(
          tx,
          {
            subjectType: 'staff',
            subjectId: tenantB.staffMemberId,
            organizationId: tenantB.organizationId,
          },
          'staff_deactivated',
        );
        return result.notify;
      });
      notify();
      expect(EventSessionRevokedSchema.parse(await revoked).data.reason).toBe('staff_deactivated');
      expect(await disconnected).toBe('io server disconnect');
    });

    it('expired access token: session.expired, then disconnection', async () => {
      const owner = await ownerOf(tenantA);
      const sessionId = sessionIdOf(owner);
      // A token of this session that expires in about one second.
      const almostExpired = await app.get(AccessTokenService).issue(
        'panel',
        {
          subjectId: tenantA.ownerId,
          subjectType: 'owner',
          sessionId,
          organizationId: tenantA.organizationId,
        },
        new Date(Date.now() - (ACCESS_TOKEN_TTL_SECONDS - 1) * 1000),
      );
      const socket = await connect(url, {
        cookie: `${AUTH_COOKIES.panel.access}=${almostExpired.token}`,
        deviceId: owner.deviceId,
      });
      sockets.push(socket);
      const expired = nextEvent(socket, 'session.expired', 4_000);
      const disconnected = nextDisconnect(socket, 4_000);
      const payload = EventSessionExpiredSchema.parse(await expired);
      expect(payload.data.expiredAt).toBe(almostExpired.expiresAt.toISOString());
      expect(await disconnected).toBe('io server disconnect');

      // The app renews by REST and reconnects with the new cookie.
      const refreshed = await http()
        .post(`${API}/auth/refresh`)
        .set('Cookie', owner.jar.header())
        .expect(200);
      owner.jar.store(refreshed);
      const again = await open(owner);
      expect(again.connected).toBe(true);
    });
  });
});
