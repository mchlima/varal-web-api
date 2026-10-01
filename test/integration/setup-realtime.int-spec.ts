import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { RateLimiter } from '../../src/auth/rate-limit.js';
import type { PanelMe } from '../../src/auth/auth.schemas.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import {
  EventSessionAccessChangedSchema,
  EventSessionRevokedSchema,
} from '../../src/realtime/realtime.contracts.js';
import { RealtimeService } from '../../src/realtime/realtime.service.js';
import {
  MenuUpdated,
  ProductSoldOutChanged,
  UnitConfigUpdated,
} from '../../src/units/setup-events.js';
import {
  credentialsOf,
  grantUnit,
  type LoggedIn,
  loginOwner,
  loginStaff,
  setPassword,
  TEST_PASSWORD,
} from '../support/auth-kit.js';
import { errorOf } from '../support/http.js';
import { createTenant, type Tenant } from '../support/isolation-kit.js';
import { connect, listen, nextDisconnect, nextEvent } from '../support/socket-kit.js';
import { type TemplateStations, withTemplate } from '../support/setup-kit.js';
import { createTestApp } from '../support/test-app.js';

const databaseUrl = inject('databaseUrl');
const API = '/api/v1';

/**
 * Real authentication and sockets: login rules of RN-03.16, sessions of RN-03.17/18/19, `/auth/me`
 * with stations, and the real-time effects of the unit setup (CA-03.05, spec 01 section 10).
 */
describe.skipIf(!databaseUrl)('unit setup with real sessions and real time (spec 03)', () => {
  let app: NestExpressApplication;
  let url: string;
  let platform: PlatformPrismaService;
  let realtime: RealtimeService;
  const sockets: Socket[] = [];

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({ databaseUrl: databaseUrl ?? '', auth: 'real' });
    url = await listen(app);
    platform = app.get(PlatformPrismaService);
    realtime = app.get(RealtimeService);
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

  interface Setup {
    tenant: Tenant;
    stations: TemplateStations;
  }

  async function setup(label: string): Promise<Setup> {
    const tenant = await createTenant(platform, label);
    const stations = await withTemplate(platform, tenant);
    await setPassword(platform, { owner: tenant.ownerId, staff: tenant.staffMemberId });
    return { tenant, stations };
  }

  async function owner(tenant: Tenant): Promise<LoggedIn> {
    return loginOwner(app, (await credentialsOf(platform, tenant)).email);
  }

  async function staff(tenant: Tenant, password = TEST_PASSWORD): Promise<LoggedIn> {
    return loginStaff(app, await credentialsOf(platform, tenant), password);
  }

  async function open(login: LoggedIn): Promise<Socket> {
    const socket = await connect(url, { cookie: login.jar.header(), deviceId: login.deviceId });
    sockets.push(socket);
    return socket;
  }

  function sessionIdOf(login: LoggedIn): string {
    return (login.body as PanelMe).session.id;
  }

  async function roomsOf(login: LoggedIn): Promise<string[]> {
    const [rooms = []] = await realtime.roomsOfSession(sessionIdOf(login));
    return rooms;
  }

  function cookie(login: LoggedIn): Record<string, string> {
    return { Cookie: login.jar.header(), 'X-Device-Id': login.deviceId };
  }

  it('RN-03.16: a staff member without any active unit cannot log in; with one, logs in', async () => {
    const { tenant, stations } = await setup('Sem unidade');
    const credentials = await credentialsOf(platform, tenant);
    const refused = await http()
      .post(`${API}/auth/staff/login`)
      .set('X-Device-Id', crypto.randomUUID())
      .send({ ...credentials, password: TEST_PASSWORD })
      .expect(403);
    expect(errorOf(refused).code).toBe('STAFF_WITHOUT_UNIT');
    // A wrong password still gets the usual answer: nothing is revealed before the password.
    const wrong = await http()
      .post(`${API}/auth/staff/login`)
      .set('X-Device-Id', crypto.randomUUID())
      .send({ ...credentials, password: 'senha-errada-123' })
      .expect(401);
    expect(errorOf(wrong).code).toBe('INVALID_STAFF_CREDENTIALS');

    await grantUnit(platform, tenant, [stations.kitchen]);
    const login = await staff(tenant);
    expect((login.body as PanelMe).units).toEqual([
      expect.objectContaining({
        id: tenant.unitId,
        allStations: false,
        stationIds: [stations.kitchen],
        stations: [{ id: stations.kitchen, name: 'Cozinha', kind: 'queue' }],
        canOperateCash: false,
        lateAfterMinutes: 15,
      }),
    ]);
  });

  it('/auth/me: the owner gets every active station of each active unit, with name and kind', async () => {
    const { tenant, stations } = await setup('Me do dono');
    const login = await owner(tenant);
    const me = await http().get(`${API}/auth/me`).set(cookie(login)).expect(200);
    expect((me.body as PanelMe).units).toEqual([
      expect.objectContaining({
        id: tenant.unitId,
        allStations: true,
        stations: [
          { id: stations.counter, name: 'Balcão', kind: 'counter' },
          { id: stations.kitchen, name: 'Cozinha', kind: 'queue' },
          { id: stations.delivery, name: 'Balcão de entrega', kind: 'queue' },
        ],
      }),
    ]);
  });

  it('CA-03.05: sold-out marked on the kitchen phone reaches the counter in under 2 s', async () => {
    const { tenant, stations } = await setup('Esgotado');
    const ownerLogin = await owner(tenant);
    const category = await http()
      .post(`${API}/categories`)
      .set(cookie(ownerLogin))
      .send({ unitId: tenant.unitId, name: 'Espetos' })
      .expect(201);
    const product = await http()
      .post(`${API}/products`)
      .set(cookie(ownerLogin))
      .send({ categoryId: (category.body as { id: string }).id, name: 'Carne', priceCents: 1200 })
      .expect(201);
    const productId = (product.body as { id: string }).id;

    // The counter (owner's device here) listens to the unit room; the kitchen staff marks it.
    const counter = await open(ownerLogin);
    await grantUnit(platform, tenant, [stations.kitchen]);
    const kitchen = await staff(tenant);
    const arrival = nextEvent(counter, ProductSoldOutChanged.type, 2_000);
    const started = performance.now();
    const marked = await http()
      .post(`${API}/products/${productId}/sold-out`)
      .set(cookie(kitchen))
      .expect(200);
    const event = ProductSoldOutChanged.schema.parse(await arrival);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(event).toMatchObject({
      type: 'product.sold_out_changed',
      organizationId: tenant.organizationId,
      unitId: tenant.unitId,
      version: (marked.body as { version: number }).version,
      data: { productId, soldOut: true },
    });

    // Any other change: `menu.updated` with the menu version.
    const updated = nextEvent(counter, MenuUpdated.type);
    await http()
      .patch(`${API}/products/${productId}`)
      .set(cookie(ownerLogin))
      .send({ priceCents: 1300 })
      .expect(200);
    const menuEvent = MenuUpdated.schema.parse(await updated);
    const unit = await platform.unit.findUniqueOrThrow({ where: { id: tenant.unitId } });
    expect(menuEvent.data).toEqual({ unitId: tenant.unitId, version: unit.menuVersion });
  });

  it('spec 01 section 10: a permission change reconnects the staff sockets with the new rooms at once', async () => {
    const { tenant, stations } = await setup('Permissão');
    await grantUnit(platform, tenant, [stations.kitchen]);
    const ownerLogin = await owner(tenant);
    const staffLogin = await staff(tenant);
    const socket = await open(staffLogin);
    expect(await roomsOf(staffLogin)).toEqual(
      [`station:${stations.kitchen}`, `unit:${tenant.unitId}`].sort(),
    );

    const changed = nextEvent(socket, EventSessionAccessChangedSchema.shape.type.value);
    const disconnected = nextDisconnect(socket);
    await http()
      .put(`${API}/staff/${tenant.staffMemberId}/permissions`)
      .set(cookie(ownerLogin))
      .send({
        units: [{ unitId: tenant.unitId, stationIds: [stations.counter, stations.delivery] }],
      })
      .expect(200);
    expect(EventSessionAccessChangedSchema.parse(await changed).data.reason).toBe(
      'permissions_changed',
    );
    expect(await disconnected).toBe('io server disconnect');

    // The session is still valid: reconnecting gives the rooms of the new permissions.
    await http().get(`${API}/auth/me`).set(cookie(staffLogin)).expect(200);
    const reconnected = await open(staffLogin);
    expect(await roomsOf(staffLogin)).toEqual(
      [
        `station:${stations.counter}`,
        `station:${stations.delivery}`,
        `unit:${tenant.unitId}`,
      ].sort(),
    );

    // Removing every unit ends the sessions (RN-03.16).
    const revoked = nextEvent(reconnected, 'session.revoked');
    await http()
      .put(`${API}/staff/${tenant.staffMemberId}/permissions`)
      .set(cookie(ownerLogin))
      .send({ units: [] })
      .expect(200);
    expect(EventSessionRevokedSchema.parse(await revoked).data.reason).toBe('staff_access_removed');
    await http().get(`${API}/auth/me`).set(cookie(staffLogin)).expect(401);
  });

  it('a new station: the owner reconnects and joins its room; `unit.config_updated` reaches the unit', async () => {
    const { tenant } = await setup('Nova estação');
    const ownerLogin = await owner(tenant);
    const socket = await open(ownerLogin);
    const config = nextEvent(socket, UnitConfigUpdated.type);
    const changed = nextEvent(socket, 'session.access_changed');
    const created = await http()
      .post(`${API}/units/${tenant.unitId}/stations`)
      .set(cookie(ownerLogin))
      .send({ name: 'Fritadeira', kind: 'queue' })
      .expect(201);
    const configEvent = UnitConfigUpdated.schema.parse(await config);
    expect(configEvent.data.unitId).toBe(tenant.unitId);
    expect(EventSessionAccessChangedSchema.parse(await changed).data.reason).toBe(
      'stations_changed',
    );
    await open(ownerLogin);
    expect(await roomsOf(ownerLogin)).toContain(`station:${(created.body as { id: string }).id}`);
  });

  it('RN-03.17: deactivating a staff member ends the sessions at once (HTTP and socket)', async () => {
    const { tenant } = await setup('Desativar');
    await grantUnit(platform, tenant);
    const ownerLogin = await owner(tenant);
    const staffLogin = await staff(tenant);
    const socket = await open(staffLogin);
    const revoked = nextEvent(socket, 'session.revoked');
    await http()
      .patch(`${API}/staff/${tenant.staffMemberId}`)
      .set(cookie(ownerLogin))
      .send({ active: false })
      .expect(200);
    expect(EventSessionRevokedSchema.parse(await revoked).data.reason).toBe('staff_deactivated');
    await http().get(`${API}/auth/me`).set(cookie(staffLogin)).expect(401);
    // Still listed (history and audit keep it).
    const list = await http().get(`${API}/staff?limit=100`).set(cookie(ownerLogin)).expect(200);
    expect(
      (list.body as { data: { id: string; active: boolean }[] }).data.find(
        (row) => row.id === tenant.staffMemberId,
      ),
    ).toMatchObject({ active: false });
  });

  it('RN-03.19: the owner sets the password directly; the old sessions end and the new password works', async () => {
    const { tenant } = await setup('Senha direta');
    await grantUnit(platform, tenant);
    const ownerLogin = await owner(tenant);
    const staffLogin = await staff(tenant);
    await http()
      .put(`${API}/staff/${tenant.staffMemberId}/password`)
      .set(cookie(ownerLogin))
      .send({ password: 'nova-senha-456' })
      .expect(204);
    await http().get(`${API}/auth/me`).set(cookie(staffLogin)).expect(401);
    await staff(tenant, 'nova-senha-456');
    const audit = await platform.auditLog.findFirstOrThrow({
      where: { action: 'staff_member.password_set', entityId: tenant.staffMemberId },
    });
    expect(JSON.stringify(audit.changes)).not.toContain('argon2');
  });

  it('CA-03.08: the reset link generated by the owner sets a new password and works only once', async () => {
    const { tenant } = await setup('Link de redefinição');
    await grantUnit(platform, tenant);
    const ownerLogin = await owner(tenant);
    const response = await http()
      .post(`${API}/staff/${tenant.staffMemberId}/password-reset`)
      .set(cookie(ownerLogin))
      .send({ sendEmail: false })
      .expect(200);
    const link = (response.body as { link: string }).link;
    const token = new URLSearchParams(link.slice(link.indexOf('#') + 1)).get('token') ?? '';
    await http()
      .post(`${API}/auth/password/reset`)
      .send({ token, password: 'senha-do-link-789' })
      .expect(204);
    const again = await http()
      .post(`${API}/auth/password/reset`)
      .send({ token, password: 'outra-senha-789' })
      .expect(400);
    expect(errorOf(again).code).toBe('INVALID_PASSWORD_TOKEN');
    await staff(tenant, 'senha-do-link-789');
  });
});
