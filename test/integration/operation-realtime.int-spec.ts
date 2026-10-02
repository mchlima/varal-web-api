import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { hashPassword } from '../../src/auth/password-hasher.js';
import { RateLimiter } from '../../src/auth/rate-limit.js';
import { todayInSaoPaulo } from '../../src/common/time.js';
import type { CashRegisterDto, PaymentResultDto } from '../../src/operation/cash.schemas.js';
import {
  CashRegisterClosed,
  CashRegisterOpened,
  CashRegisterUpdated,
  OrderCompleted,
  OrderCreated,
  OrderItemCanceled,
  OrderItemStageChanged,
  ContractedEventUpdated,
  TabCreated,
  TabUpdated,
  UnitOperationUpdated,
} from '../../src/operation/operation-events.js';
import type { ContractedEventDto } from '../../src/operation/events.schemas.js';
import type {
  ItemChangeDto,
  OrderDto,
  TabDto,
  TabSummaryDto,
} from '../../src/operation/operation.schemas.js';
import type { UnitOperationDto } from '../../src/operation/unit-operation.schemas.js';
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

  /** Opens "Caixa 1" of the unit (spec 05, RN-05.23). */
  function openRegister(f: Floor, login: LoggedIn = f.owner, float = 0): Promise<CashRegisterDto> {
    return post<CashRegisterDto>(login, `/cash-registers/${f.setup.register}/open`, {
      openingFloatCents: float,
    });
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

    const opened = nextEvent<Envelope<UnitOperationDto>>(
      counter.socket,
      UnitOperationUpdated.type,
      2_000,
    );
    const register = await openRegister(f);
    await expect(opened).resolves.toMatchObject({
      type: 'unit.operation_updated',
      organizationId: setup.tenant.organizationId,
      unitId: setup.tenant.unitId,
      data: {
        unitId: setup.tenant.unitId,
        inOperation: true,
        cashRegisters: [{ id: register.id, session: { status: 'open' } }],
      },
    });

    const tabCreated = nextEvent<Envelope<TabDto>>(counter.socket, TabCreated.type, 2_000);
    const tab = await post<TabDto>(f.counter, `/units/${setup.tenant.unitId}/tabs`, {
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
    await openRegister(f);
    const tab = await post<TabDto>(f.counter, `/units/${f.setup.tenant.unitId}/tabs`, {
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

  /** The last `name` event received, after the events of the last action settled. */
  async function latest<T>(events: Received[], name: string): Promise<Envelope<T>> {
    await settle(300);
    const found = named<T>(events, name).at(-1);
    if (!found) {
      throw new Error(`no "${name}" event`);
    }
    return found;
  }

  it('phase 5 adjustment: a stage change that moves the ready or late counters emits tab.updated', async () => {
    const f = await floor('Contadores');
    const counter = await open(f.counter);
    await openRegister(f);
    const tab = await post<TabDto>(f.counter, `/units/${f.setup.tenant.unitId}/tabs`, {
      customerName: 'Dona Marta',
    });
    const order = await post<OrderDto>(f.counter, `/tabs/${tab.id}/orders`, {
      items: [
        {
          productId: f.setup.products.skewer,
          quantity: 2,
          modifierIds: [f.setup.modifiers.medium],
        },
      ],
    });
    await settle(200);
    const tabUpdates = () => named<TabSummaryDto>(counter.events, TabUpdated.type);
    const before = tabUpdates().length;
    const item = order.items[0];
    if (!item) {
      throw new Error('no item');
    }
    // Recebido → Preparando: no counter changes, no tab.updated.
    const preparing = await post<ItemChangeDto>(f.kitchen, `/order-items/${item.id}/advance`, {
      version: item.version,
    });
    await settle(200);
    expect(tabUpdates()).toHaveLength(before);
    // Preparando → Pronto: ready to deliver.
    const ready = await post<ItemChangeDto>(f.kitchen, `/order-items/${item.id}/advance`, {
      version: preparing.changed.version,
    });
    const readyEvent = await latest<TabSummaryDto>(counter.events, TabUpdated.type);
    expect(readyEvent.data).toMatchObject({ id: tab.id, readyItemCount: 2, lateItemCount: 0 });
    expect(readyEvent.version).toBeGreaterThan(tab.version);
    // Pronto → Entregue (the counter delivers): the counter goes back to zero.
    await post<ItemChangeDto>(f.counter, `/order-items/${item.id}/advance`, {
      version: ready.changed.version,
    });
    const delivered = await latest<TabSummaryDto>(counter.events, TabUpdated.type);
    expect(delivered.data).toMatchObject({ readyItemCount: 0 });
    expect(delivered.version).toBeGreaterThan(readyEvent.version);
  });

  it('CA-04.10 and spec 05 events: "paga antes" reaches the kitchen only with its payment; payments and registers are announced', async () => {
    const f = await floor('Paga antes em tempo real');
    const counter = await open(f.counter);
    const kitchen = await open(f.kitchen);
    const register = await openRegister(f, f.counter, 5000);
    const opened = await latest<CashRegisterDto>(counter.events, CashRegisterOpened.type);
    expect(opened.data).toMatchObject({
      id: register.id,
      name: 'Caixa 1',
      session: { status: 'open', openingFloatCents: 5000 },
    });

    const items = [
      { productId: f.setup.products.skewer, quantity: 1, modifierIds: [f.setup.modifiers.medium] },
    ];
    const refused = await http()
      .post(`${API}/units/${f.setup.tenant.unitId}/tabs/pay-first`)
      .set(headers(f.counter))
      .send({ customerName: 'Lucas', items, payments: [{ method: 'pix', amountCents: 100 }] });
    expect(refused.status).toBe(409);
    await settle(300);
    expect(named(kitchen.events, OrderCreated.type)).toHaveLength(0);
    expect(named(counter.events, TabCreated.type)).toHaveLength(0);

    const tab = await post<TabDto>(f.counter, `/units/${f.setup.tenant.unitId}/tabs/pay-first`, {
      customerName: 'Lucas',
      items,
      payments: [{ method: 'cash', tenderedCents: 2000 }],
    });
    const sent = await latest<OrderDto>(kitchen.events, OrderCreated.type);
    expect(sent.data.tabId).toBe(tab.id);
    const created = await latest<TabSummaryDto>(counter.events, TabCreated.type);
    expect(created.data).toMatchObject({ id: tab.id, status: 'paid', balanceCents: 0 });
    const cashUpdate = await latest<CashRegisterDto>(counter.events, CashRegisterUpdated.type);
    expect(cashUpdate.data.session?.cash.paymentsCents).toBe(1200);

    // Reversal: tab.updated (back to closing) and cash_register.updated.
    const payment = tab.payments[0];
    if (!payment) {
      throw new Error('no payment');
    }
    await post<PaymentResultDto>(f.counter, `/payments/${payment.id}/reverse`, {
      reason: 'Cobrado errado',
    });
    const reopened = await latest<TabSummaryDto>(counter.events, TabUpdated.type);
    expect(reopened.data).toMatchObject({ id: tab.id, status: 'closing', balanceCents: 1200 });
    await settle(200);
    expect(named(counter.events, CashRegisterUpdated.type)).toHaveLength(2);

    const operationClosed = nextEvent<Envelope<UnitOperationDto>>(
      counter.socket,
      UnitOperationUpdated.type,
      2_000,
    );
    await post<CashRegisterDto>(
      f.counter,
      `/cash-register-sessions/${register.session?.id ?? ''}/close`,
      {
        counts: ['cash', 'pix', 'credit_card', 'debit_card'].map((method) => ({
          method,
          informedCents: method === 'cash' ? 5000 : 0,
        })),
      },
    );
    const closed = await latest<CashRegisterDto>(counter.events, CashRegisterClosed.type);
    expect(closed.data.session).toMatchObject({ status: 'closed', pendingTabsCount: 1 });
    await expect(operationClosed).resolves.toMatchObject({ data: { inOperation: false } });
  });

  it('RN-04.31, RN-04.34: changing the current list and starting an event reach every counter (unit.operation_updated, event.updated)', async () => {
    const f = await floor('Tabela em tempo real');
    const counter = await open(f.counter);
    const kitchen = await open(f.kitchen, [`unit:${f.setup.tenant.unitId}`]);
    const list = await post<{ id: string }>(
      f.owner,
      `/units/${f.setup.tenant.unitId}/price-lists`,
      {
        name: 'Evento',
      },
    );
    const changed = nextEvent<Envelope<UnitOperationDto>>(
      counter.socket,
      UnitOperationUpdated.type,
      2_000,
    );
    const response = await http()
      .put(`${API}/units/${f.setup.tenant.unitId}/current-price-list`)
      .set(headers(f.counter))
      .send({ priceListId: list.id });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const operation = response.body as UnitOperationDto;
    await expect(changed).resolves.toMatchObject({
      version: operation.version,
      data: { currentPriceList: { id: list.id, name: 'Evento' } },
    });

    const event = await post<ContractedEventDto>(
      f.owner,
      `/units/${f.setup.tenant.unitId}/events`,
      {
        contractorName: 'Festa',
        startsOn: todayInSaoPaulo().toString(),
        modality: 'other',
      },
    );
    const updated = nextEvent<Envelope<ContractedEventDto>>(
      counter.socket,
      ContractedEventUpdated.type,
      2_000,
    );
    const started = nextEvent<Envelope<UnitOperationDto>>(
      counter.socket,
      UnitOperationUpdated.type,
      2_000,
    );
    await post(f.counter, `/events/${event.id}/start`);
    await expect(updated).resolves.toMatchObject({
      type: 'event.updated',
      data: { id: event.id, status: 'in_progress' },
    });
    await expect(started).resolves.toMatchObject({
      data: { eventInProgress: { id: event.id }, effectivePriceList: null },
    });
    await settle(200);
    // Unit events never reach a station room.
    expect(named(kitchen.events, UnitOperationUpdated.type)).toHaveLength(0);
  });
});
