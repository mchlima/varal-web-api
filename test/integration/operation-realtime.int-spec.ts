import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { hashPassword } from '../../src/auth/password-hasher.js';
import { RateLimiter } from '../../src/auth/rate-limit.js';
import {
  OrderCompleted,
  OrderCreated,
  OrderItemCanceled,
  OrderItemStageChanged,
  ShiftOpened,
  TabCreated,
  TabUpdated,
} from '../../src/operation/operation-events.js';
import type {
  ItemChangeDto,
  OrderDto,
  ShiftDto,
  TabDto,
} from '../../src/operation/operation.schemas.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import {
  credentialsOf,
  type LoggedIn,
  loginOwner,
  loginStaff,
  setPassword,
  TEST_PASSWORD,
} from '../support/auth-kit.js';
import { createTenant } from '../support/isolation-kit.js';
import { createStaff, type OperationSetup, setupOperation } from '../support/operation-kit.js';
import {
  connect,
  listen,
  nextEvent,
  recordEvents,
  request as ask,
  settle,
} from '../support/socket-kit.js';
import { createTestApp } from '../support/test-app.js';

const databaseUrl = inject('databaseUrl');
const API = '/api/v1';

interface Received {
  name: string;
  payload: unknown;
}

interface Envelope<T> {
  type: string;
  organizationId: string;
  unitId: string;
  version: number;
  data: T;
}

/**
 * Real-time of the operation (spec 04, section 7.1) with real sessions: each event reaches only the
 * right rooms, after the commit, within the 2 seconds of CA-04.03 and CA-04.04.
 */
describe.skipIf(!databaseUrl)('operation in real time (spec 04, section 7.1)', () => {
  let app: NestExpressApplication;
  let url: string;
  let platform: PlatformPrismaService;
  const sockets: Socket[] = [];

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({ databaseUrl: databaseUrl ?? '', auth: 'real' });
    url = await listen(app);
    platform = app.get(PlatformPrismaService);
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

  function headers(login: LoggedIn): Record<string, string> {
    return { Cookie: login.jar.header(), 'X-Device-Id': login.deviceId };
  }

  async function post<T>(login: LoggedIn, path: string, body: object = {}): Promise<T> {
    const response = await http().post(`${API}${path}`).set(headers(login)).send(body);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    return response.body as T;
  }

  async function open(
    login: LoggedIn,
    leave: string[] = [],
  ): Promise<{ socket: Socket; events: Received[] }> {
    const socket = await connect(url, { cookie: login.jar.header(), deviceId: login.deviceId });
    sockets.push(socket);
    for (const room of leave) {
      await expect(ask(socket, 'rooms.leave', { room })).resolves.toMatchObject({ ok: true });
    }
    return { socket, events: recordEvents(socket) };
  }

  interface Floor {
    setup: OperationSetup;
    owner: LoggedIn;
    counter: LoggedIn;
    kitchen: LoggedIn;
    fryer: LoggedIn;
    delivery: LoggedIn;
  }

  async function floor(label: string): Promise<Floor> {
    const tenant = await createTenant(platform, label);
    const setup = await setupOperation(platform, tenant);
    await setPassword(platform, { owner: tenant.ownerId });
    const passwordHash = await hashPassword(TEST_PASSWORD);
    const { accessCode, email } = await credentialsOf(platform, tenant);
    const staff = async (stationIds: string[], canOperateCash = false) => {
      const member = await createStaff(platform, tenant, stationIds, {
        canOperateCash,
        passwordHash,
      });
      return loginStaff(app, { accessCode, username: member.username });
    };
    const { stations } = setup;
    return {
      setup,
      owner: await loginOwner(app, email),
      counter: await staff([stations.counter, stations.delivery], true),
      kitchen: await staff([stations.kitchen]),
      fryer: await staff([stations.fryer]),
      delivery: await staff([stations.delivery]),
    };
  }

  function named<T>(events: Received[], name: string): Envelope<T>[] {
    return events
      .filter((event) => event.name === name)
      .map((event) => event.payload as Envelope<T>);
  }

  it('CA-04.03/CA-04.04: each station gets only its items; stage changes reach origin, destination and counter', async () => {
    const f = await floor('Tempo real');
    const other = await floor('Tempo real outra');
    const { setup } = f;
    const unitRoom = `unit:${setup.tenant.unitId}`;

    const counter = await open(f.counter);
    // Station devices without the unit room, to see exactly what the station rooms get.
    const kitchen = await open(f.kitchen, [unitRoom]);
    const fryer = await open(f.fryer, [unitRoom]);
    const delivery = await open(f.delivery, [unitRoom]);
    const stranger = await open(other.owner);

    const opened = nextEvent<Envelope<ShiftDto>>(counter.socket, ShiftOpened.type, 2_000);
    const shift = await post<ShiftDto>(f.owner, `/units/${setup.tenant.unitId}/shifts`, {
      type: 'direct_sale',
    });
    await expect(opened).resolves.toMatchObject({
      type: 'shift.opened',
      organizationId: setup.tenant.organizationId,
      unitId: setup.tenant.unitId,
      version: shift.version,
      data: { id: shift.id, status: 'open' },
    });

    const tabCreated = nextEvent<Envelope<TabDto>>(counter.socket, TabCreated.type, 2_000);
    const tab = await post<TabDto>(f.counter, `/shifts/${shift.id}/tabs`, {
      customerName: 'Dona Marta',
    });
    await expect(tabCreated).resolves.toMatchObject({
      data: { id: tab.id, number: 1, totalCents: 0 },
    });

    // CA-04.03: skewer to the Cozinha, pastry to the Fritadeira, the whole order to the counter.
    const kitchenOrder = nextEvent<Envelope<OrderDto>>(kitchen.socket, OrderCreated.type, 2_000);
    const fryerOrder = nextEvent<Envelope<OrderDto>>(fryer.socket, OrderCreated.type, 2_000);
    const counterOrder = nextEvent<Envelope<OrderDto>>(counter.socket, OrderCreated.type, 2_000);
    const tabUpdated = nextEvent<Envelope<TabDto>>(counter.socket, TabUpdated.type, 2_000);
    const order = await post<OrderDto>(f.counter, `/tabs/${tab.id}/orders`, {
      items: [
        { productId: setup.products.skewer, quantity: 3, modifierIds: [setup.modifiers.medium] },
        { productId: setup.products.pastry, quantity: 1 },
      ],
    });
    const [skewer, pastry] = order.items;
    if (!skewer || !pastry) {
      throw new Error('items missing');
    }
    expect((await kitchenOrder).data.items.map((item) => item.id)).toEqual([skewer.id]);
    expect((await fryerOrder).data.items.map((item) => item.id)).toEqual([pastry.id]);
    expect((await counterOrder).data.items.map((item) => item.id)).toEqual([skewer.id, pastry.id]);
    await expect(tabUpdated).resolves.toMatchObject({
      version: tab.version + 1,
      data: { id: tab.id, totalCents: 3 * 1200 + 800, itemCount: 4 },
    });

    // CA-04.04: the kitchen advances 2 of 3 to Pronto: the counter and the delivery counter see it.
    const preparing = await post<ItemChangeDto>(f.kitchen, `/order-items/${skewer.id}/advance`, {
      version: skewer.version,
    });
    const atDelivery = nextEvent<Envelope<{ item: { id: string; stationId: string } }>>(
      delivery.socket,
      OrderItemStageChanged.type,
      2_000,
    );
    const atCounter = nextEvent<Envelope<unknown>>(
      counter.socket,
      OrderItemStageChanged.type,
      2_000,
    );
    const ready = await post<ItemChangeDto>(f.kitchen, `/order-items/${skewer.id}/advance`, {
      version: preparing.changed.version,
      quantity: 2,
    });
    await expect(atDelivery).resolves.toMatchObject({
      version: ready.changed.version,
      data: {
        item: { id: ready.changed.id, quantity: 2, stationId: setup.stations.delivery },
        previousStationId: setup.stations.kitchen,
        remaining: { id: skewer.id, quantity: 1 },
      },
    });
    await atCounter;

    // The fryer cancels its pastry (first stage: no waste).
    const canceled = nextEvent<Envelope<{ item: { id: string; wasted: boolean } }>>(
      fryer.socket,
      OrderItemCanceled.type,
      2_000,
    );
    await post(f.fryer, `/order-items/${pastry.id}/cancel`, {
      version: pastry.version,
      reason: 'Acabou a massa',
    });
    await expect(canceled).resolves.toMatchObject({
      data: { item: { id: pastry.id, wasted: false } },
    });

    // The rest of the skewers are delivered: the order is completed.
    const rest = await post<ItemChangeDto>(f.kitchen, `/order-items/${skewer.id}/advance`, {
      version: ready.remaining?.version,
    });
    const restDelivered = await post<ItemChangeDto>(
      f.counter,
      `/order-items/${rest.changed.id}/advance`,
      {
        version: rest.changed.version,
      },
    );
    expect(restDelivered.changed.stageIsFinal).toBe(true);
    const completed = nextEvent<Envelope<{ orderId: string; tabId: string }>>(
      counter.socket,
      OrderCompleted.type,
      2_000,
    );
    await post(f.counter, `/order-items/${ready.changed.id}/advance`, {
      version: ready.changed.version,
    });
    await expect(completed).resolves.toMatchObject({ data: { orderId: order.id, tabId: tab.id } });

    await settle(300);
    // Only the station rooms of each item.
    expect(named(kitchen.events, OrderCreated.type)).toHaveLength(1);
    expect(named(fryer.events, OrderCreated.type)).toHaveLength(1);
    expect(named(delivery.events, OrderCreated.type)).toHaveLength(0);
    expect(named(fryer.events, OrderItemStageChanged.type)).toHaveLength(0);
    expect(named(kitchen.events, OrderItemCanceled.type)).toHaveLength(0);
    // The kitchen saw the lines leave it (origin) and nothing of the delivery counter afterwards.
    expect(
      named<{ item: { stationId: string | null } }>(kitchen.events, OrderItemStageChanged.type).map(
        (event) => event.data.item.stationId,
      ),
    ).toEqual([setup.stations.kitchen, setup.stations.delivery, setup.stations.delivery]);
    // Unit-only events never reach the station rooms.
    expect(named(kitchen.events, TabUpdated.type)).toHaveLength(0);
    expect(named(kitchen.events, OrderCompleted.type)).toHaveLength(0);
    // The counter (unit room and delivery station) gets each stage change once.
    expect(named(counter.events, OrderCreated.type)).toHaveLength(1);
    expect(named(counter.events, OrderItemStageChanged.type)).toHaveLength(5);
    // Another organization gets nothing (CA-01.02).
    expect(stranger.events).toEqual([]);
  });

  it('events leave only after the commit: a refused order emits nothing', async () => {
    const f = await floor('Sem commit');
    const counter = await open(f.counter);
    const kitchen = await open(f.kitchen);
    const shift = await post<ShiftDto>(f.owner, `/units/${f.setup.tenant.unitId}/shifts`, {
      type: 'direct_sale',
    });
    const tab = await post<TabDto>(f.counter, `/shifts/${shift.id}/tabs`, {
      customerName: 'Seu João',
    });
    await settle(200);
    const before = counter.events.length;
    const refused = await http()
      .post(`${API}/tabs/${tab.id}/orders`)
      .set(headers(f.counter))
      .send({ items: [{ productId: f.setup.products.skewer, quantity: 1 }] });
    expect(refused.status).toBe(409);
    await settle(300);
    expect(counter.events.slice(before)).toEqual([]);
    expect(named(kitchen.events, OrderCreated.type)).toHaveLength(0);
  });
});
