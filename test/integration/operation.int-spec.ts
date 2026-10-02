import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { todayInSaoPaulo } from '../../src/common/time.js';
import { type AuthContext, requireOrganizationId } from '../../src/context/request-context.js';
import type { PriceListDto } from '../../src/menu/menu.schemas.js';
import type {
  CashRegisterDto,
  CashRegisterSessionDetailDto,
  ClosePreviewDto,
} from '../../src/operation/cash.schemas.js';
import type { ContractedEventDto } from '../../src/operation/events.schemas.js';
import type {
  AdvanceOrderResultDto,
  ItemChangeDto,
  OrderDto,
  OrderItemDto,
  StationOrderDto,
  StationQueueDto,
  TabDto,
  TabSummaryDto,
} from '../../src/operation/operation.schemas.js';
import type { UnitOperationDto } from '../../src/operation/unit-operation.schemas.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { errorOf } from '../support/http.js';
import {
  createTenant,
  describeTenantIsolation,
  expectNotFoundForOtherTenant,
  type IsolationContext,
  type Tenant,
} from '../support/isolation-kit.js';
import {
  createStaff,
  type OperationSetup,
  setupOperation,
  type TestStaff,
} from '../support/operation-kit.js';
import { authHeaders } from '../support/stub-auth.js';
import { createTestApp } from '../support/test-app.js';

const databaseUrl = inject('databaseUrl');
const API = '/api/v1';

interface Crew {
  setup: OperationSetup;
  owner: AuthContext;
  /** Balcão + Balcão de entrega, operates cash. */
  counter: TestStaff;
  /** Cozinha only. */
  kitchen: TestStaff;
  /** Fritadeira only. */
  fryer: TestStaff;
}

const METHODS = ['cash', 'pix', 'credit_card', 'debit_card'] as const;

describe.skipIf(!databaseUrl)('operation: day, tabs, orders, items and events (spec 04)', () => {
  let app: NestExpressApplication;
  let platform: PlatformPrismaService;

  const http = () => request(app.getHttpServer());
  const as = (auth: AuthContext) => authHeaders(auth);

  beforeAll(async () => {
    app = await createTestApp({ databaseUrl: databaseUrl ?? '' });
    platform = app.get(PlatformPrismaService);
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  async function crew(label: string): Promise<Crew> {
    const tenant = await createTenant(platform, label);
    const setup = await setupOperation(platform, tenant);
    const { stations } = setup;
    return {
      setup,
      owner: tenant.ownerAuth,
      counter: await createStaff(platform, tenant, [stations.counter, stations.delivery], {
        canOperateCash: true,
      }),
      kitchen: await createStaff(platform, tenant, [stations.kitchen]),
      fryer: await createStaff(platform, tenant, [stations.fryer]),
    };
  }

  async function ok<T>(
    method: 'get' | 'post' | 'put' | 'patch',
    path: string,
    auth: AuthContext,
    body?: object,
    status = method === 'post' ? 201 : 200,
  ): Promise<T> {
    let call = http()[method](`${API}${path}`).set(as(auth));
    if (body !== undefined) {
      call = call.send(body);
    }
    const response = await call;
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return response.body as T;
  }

  /** Opens "Caixa 1" (or another register) of the unit (spec 05, RN-05.23). */
  function openRegister(
    c: Crew,
    options: { auth?: AuthContext; register?: string; startEventId?: string } = {},
  ): Promise<CashRegisterDto> {
    return ok<CashRegisterDto>(
      'post',
      `/cash-registers/${options.register ?? c.setup.register}/open`,
      options.auth ?? c.owner,
      {
        openingFloatCents: 0,
        ...(options.startEventId === undefined ? {} : { startEventId: options.startEventId }),
      },
    );
  }

  /** Closes the open session of a register with the expected values (no difference). */
  async function closeRegister(
    c: Crew,
    register: CashRegisterDto,
    options: { finishPendingItems?: boolean; finishEvent?: boolean } = {},
  ): Promise<CashRegisterDto> {
    const sessionId = register.session?.id;
    if (!sessionId) {
      throw new Error('register not open');
    }
    const session = await ok<CashRegisterSessionDetailDto>(
      'get',
      `/cash-register-sessions/${sessionId}`,
      c.owner,
    );
    return ok<CashRegisterDto>(
      'post',
      `/cash-register-sessions/${sessionId}/close`,
      c.owner,
      {
        counts: METHODS.map((method) => ({
          method,
          informedCents: session.expected.find((row) => row.method === method)?.expectedCents ?? 0,
        })),
        ...options,
      },
      200,
    );
  }

  function openTab(c: Crew, customerName = 'Dona Marta'): Promise<TabDto> {
    return ok<TabDto>('post', `/units/${c.setup.tenant.unitId}/tabs`, c.counter.auth, {
      customerName,
    });
  }

  function sendOrder(c: Crew, tabId: string, items: object[]): Promise<OrderDto> {
    return ok<OrderDto>('post', `/tabs/${tabId}/orders`, c.counter.auth, { items });
  }

  function operation(c: Crew, auth: AuthContext = c.owner): Promise<UnitOperationDto> {
    return ok<UnitOperationDto>('get', `/units/${c.setup.tenant.unitId}/operation`, auth);
  }

  function listTabs(c: Crew, auth: AuthContext = c.counter.auth): Promise<TabSummaryDto[]> {
    return ok<{ data: TabSummaryDto[] }>('get', `/units/${c.setup.tenant.unitId}/tabs`, auth).then(
      (body) => body.data,
    );
  }

  function queue(
    c: Crew,
    stationId: string,
    auth: AuthContext = c.owner,
  ): Promise<StationQueueDto> {
    return ok<StationQueueDto>('get', `/stations/${stationId}/queue`, auth);
  }

  function skewer(c: Crew, quantity = 1, extra: string[] = []): object {
    return {
      productId: c.setup.products.skewer,
      quantity,
      modifierIds: [c.setup.modifiers.medium, ...extra],
    };
  }

  function advance(
    auth: AuthContext,
    item: { id: string; version: number },
    quantity?: number,
  ): Promise<ItemChangeDto> {
    return ok<ItemChangeDto>(
      'post',
      `/order-items/${item.id}/advance`,
      auth,
      { version: item.version, ...(quantity === undefined ? {} : { quantity }) },
      200,
    );
  }

  function firstItem(order: OrderDto, index = 0): OrderItemDto {
    const item = order.items[index];
    if (!item) {
      throw new Error(`item ${index} not found`);
    }
    return item;
  }

  function card(q: StationQueueDto, orderId: string): StationOrderDto {
    const found = q.orders.find((order) => order.orderId === orderId);
    if (!found) {
      throw new Error(`card of ${orderId} not found`);
    }
    return found;
  }

  async function auditActions(entityId: string): Promise<string[]> {
    const rows = await platform.auditLog.findMany({
      where: { entityId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => row.action);
  }

  /**
   * The clock is real: "yesterday" is simulated by moving the day of operation of the unit, of its
   * sessions and of its tabs `days` back.
   */
  async function moveDaysBack(c: Crew, days: number): Promise<void> {
    const unitId = c.setup.tenant.unitId;
    await platform.$executeRaw`UPDATE units SET business_date = business_date - ${days}::int WHERE id = ${unitId}::uuid`;
    await platform.$executeRaw`UPDATE cash_register_sessions SET business_date = business_date - ${days}::int WHERE unit_id = ${unitId}::uuid`;
    await platform.$executeRaw`UPDATE tabs SET business_date = business_date - ${days}::int, closed_business_date = closed_business_date - ${days}::int WHERE unit_id = ${unitId}::uuid`;
  }

  const today = () => todayInSaoPaulo().toString();
  const daysAgo = (days: number) => todayInSaoPaulo().subtract({ days }).toString();

  async function createPriceList(
    c: Crew,
    name: string,
    prices: { productId: string; priceCents: number | null }[],
  ): Promise<PriceListDto> {
    const list = await ok<PriceListDto>(
      'post',
      `/units/${c.setup.tenant.unitId}/price-lists`,
      c.owner,
      { name },
    );
    await ok('put', `/price-lists/${list.id}/prices`, c.owner, { prices });
    return list;
  }

  function createEvent(
    c: Crew,
    body: Partial<{ contractorName: string; startsOn: string; priceListId: string | null }> = {},
  ): Promise<ContractedEventDto> {
    return ok<ContractedEventDto>('post', `/units/${c.setup.tenant.unitId}/events`, c.owner, {
      contractorName: 'Casamento Ana e Leo',
      startsOn: today(),
      modality: 'fixed_fee',
      agreedQuantity: 500,
      ...body,
    });
  }

  // ----------------------------------------------------------------------------------------------
  // Operation of the unit
  // ----------------------------------------------------------------------------------------------

  describe('operation of the unit (spec 04, section 3)', () => {
    it('CA-04.01, RN-04.02: without a register open, no new tab nor order; items and the bill of existing tabs still move', async () => {
      const c = await crew('Sem caixa');
      const closedBefore = await http()
        .post(`${API}/units/${c.setup.tenant.unitId}/tabs`)
        .set(as(c.counter.auth))
        .send({ customerName: 'Cedo demais' })
        .expect(409);
      expect(errorOf(closedBefore).code).toBe('NO_CASH_REGISTER_OPEN');

      const register = await openRegister(c);
      const tab = await openTab(c);
      const order = await sendOrder(c, tab.id, [skewer(c)]);
      await closeRegister(c, register, { finishPendingItems: false });

      const newTab = await http()
        .post(`${API}/units/${c.setup.tenant.unitId}/tabs`)
        .set(as(c.counter.auth))
        .send({ customerName: 'Tarde demais' })
        .expect(409);
      expect(errorOf(newTab).code).toBe('NO_CASH_REGISTER_OPEN');
      const newOrder = await http()
        .post(`${API}/tabs/${tab.id}/orders`)
        .set(as(c.counter.auth))
        .send({ items: [skewer(c)] })
        .expect(409);
      expect(errorOf(newOrder).code).toBe('NO_CASH_REGISTER_OPEN');
      const payFirst = await http()
        .post(`${API}/units/${c.setup.tenant.unitId}/tabs/pay-first`)
        .set(as(c.counter.auth))
        .send({ customerName: 'Lucas', items: [skewer(c)], payments: [] })
        .expect(409);
      expect(errorOf(payFirst).code).toBe('NO_CASH_REGISTER_OPEN');

      const moved = await advance(c.kitchen.auth, firstItem(order));
      expect(moved.changed.stageName).toBe('Preparando');
      const closing = await ok<TabDto>(
        'post',
        `/tabs/${tab.id}/request-bill`,
        c.counter.auth,
        {},
        200,
      );
      expect(closing.status).toBe('closing');
    });

    it('CA-01.18: the operation shows no register open, then the open register, without reloading (version)', async () => {
      const c = await crew('Operação');
      const before = await operation(c, c.kitchen.auth);
      expect(before).toMatchObject({
        unitId: c.setup.tenant.unitId,
        businessDate: null,
        inOperation: false,
        currentPriceList: null,
        effectivePriceList: null,
        eventInProgress: null,
        eventsToday: [],
        openTabs: { count: 0, totalCents: 0, fromEarlierDaysCount: 0 },
        staleTabs: [],
        itemsInProgress: 0,
      });
      expect(before.cashRegisters).toEqual([
        expect.objectContaining({ id: c.setup.register, name: 'Caixa 1', session: null }),
      ]);

      const register = await openRegister(c, { auth: c.counter.auth });
      expect(register.session).toMatchObject({
        status: 'open',
        businessDate: today(),
        openedBy: { type: 'staff', id: c.counter.id },
        openSinceEarlierDay: false,
      });
      const after = await operation(c);
      expect(after).toMatchObject({ businessDate: today(), inOperation: true });
      expect(after.version).toBeGreaterThan(before.version);
      expect(after.cashRegisters[0]?.session).toMatchObject({
        id: register.session?.id,
        openedByName: expect.any(String) as string,
      });
      const tab = await openTab(c);
      await sendOrder(c, tab.id, [skewer(c, 2)]);
      await expect(operation(c)).resolves.toMatchObject({
        openTabs: { count: 1, totalCents: 2400 },
        itemsInProgress: 2,
      });
    });

    it('CA-01.19, RN-01.28: a tab open since 3 days before shows in staleTabs until it is paid', async () => {
      const c = await crew('Comandas antigas');
      await openRegister(c);
      const tab = await openTab(c, 'Comanda velha');
      const recent = await openTab(c, 'Comanda nova');
      const order = await sendOrder(c, tab.id, [skewer(c)]);
      await platform.tab.update({
        where: { id: tab.id },
        data: { businessDate: new Date(`${daysAgo(3)}T00:00:00.000Z`) },
      });
      await platform.tab.update({
        where: { id: recent.id },
        data: { businessDate: new Date(`${daysAgo(2)}T00:00:00.000Z`) },
      });
      const stale = await operation(c, c.counter.auth);
      expect(stale.staleTabs).toEqual([
        {
          id: tab.id,
          number: tab.number,
          customerName: 'Comanda velha',
          totalCents: 1200,
          businessDate: daysAgo(3),
          openedAt: tab.openedAt,
        },
      ]);
      expect(stale.openTabs.fromEarlierDaysCount).toBe(2);

      await ok('post', `/tabs/${tab.id}/request-bill`, c.counter.auth, {}, 200);
      await ok('post', `/tabs/${tab.id}/payments`, c.counter.auth, {
        method: 'pix',
        amountCents: firstItem(order).totalCents,
      });
      await expect(operation(c)).resolves.toMatchObject({ staleTabs: [] });
    });

    it('CA-04.16, RN-04.29: a fair past midnight keeps its day; a register opened on a new day starts the day and the numbering', async () => {
      const c = await crew('Dia de operação');
      const register = await openRegister(c);
      const first = await openTab(c, 'Às 18h');
      expect(first).toMatchObject({ number: 1, businessDate: today() });
      // The register was opened "yesterday at 18h" and is still open after midnight.
      await moveDaysBack(c, 1);
      const late = await openTab(c, 'À 0h30');
      expect(late).toMatchObject({ number: 2, businessDate: daysAgo(1) });
      await ok('post', `/tabs/${first.id}/cancel`, c.counter.auth, {}, 200);
      await ok('post', `/tabs/${late.id}/cancel`, c.counter.auth, {}, 200);
      await closeRegister(c, register);

      // Opened at 17h of "today": a new day of operation, numbering from 1.
      const reopened = await openRegister(c);
      expect(reopened.session?.businessDate).toBe(today());
      const next = await openTab(c, 'Às 17h');
      expect(next).toMatchObject({ number: 1, businessDate: today() });

      // Closing and opening again on the same day (lunch and dinner) keeps the day and numbering.
      await ok('post', `/tabs/${next.id}/cancel`, c.counter.auth, {}, 200);
      await closeRegister(c, reopened);
      const dinner = await openRegister(c);
      expect(dinner.session?.businessDate).toBe(today());
      await expect(openTab(c, 'Jantar')).resolves.toMatchObject({ number: 2 });
      await expect(
        platform.cashRegisterSession.count({ where: { cashRegisterId: c.setup.register } }),
      ).resolves.toBe(3);
    });

    it('CA-04.09, RN-04.07: closing the last register with an open tab is accepted; the next day it is still in the varal with its number and day', async () => {
      const c = await crew('Comanda passa o dia');
      const register = await openRegister(c);
      const tab = await openTab(c, 'Fica pra amanhã');
      await sendOrder(c, tab.id, [skewer(c)]);
      const preview = await ok<ClosePreviewDto>(
        'get',
        `/cash-register-sessions/${register.session?.id ?? ''}/close-preview`,
        c.counter.auth,
      );
      expect(preview).toMatchObject({
        pendingTabs: [
          {
            id: tab.id,
            number: 1,
            customerName: 'Fica pra amanhã',
            status: 'open',
            totalCents: 1200,
            businessDate: today(),
          },
        ],
        pendingTabsTotalCents: 1200,
        lastOpenRegister: true,
        itemsInProgress: 1,
        eventInProgress: null,
      });
      const closed = await closeRegister(c, register);
      expect(closed.session).toMatchObject({
        status: 'closed',
        pendingTabsCount: 1,
        pendingTabsTotalCents: 1200,
      });

      await moveDaysBack(c, 1);
      await openRegister(c);
      const varal = await listTabs(c);
      expect(varal).toEqual([
        expect.objectContaining({
          id: tab.id,
          number: 1,
          status: 'open',
          businessDate: daysAgo(1),
        }),
      ]);
      const op = await operation(c);
      expect(op.openTabs).toMatchObject({ count: 1, fromEarlierDaysCount: 1 });
    });

    it('CA-04.02, RN-04.09: numbers 1, 2, 3… of the day without repeating, with counters at the same time; an open tab of yesterday is skipped', async () => {
      const c = await crew('Numeração');
      const register = await openRegister(c);
      const created = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          http()
            .post(`${API}/units/${c.setup.tenant.unitId}/tabs`)
            .set(as(index % 2 === 0 ? c.counter.auth : c.owner))
            .send({ customerName: `Cliente ${index}` }),
        ),
      );
      expect(created.every((response) => response.status === 201)).toBe(true);
      const tabs = created.map((response) => response.body as TabDto);
      expect(tabs.map((tab) => tab.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect((await listTabs(c, c.kitchen.auth)).map((tab) => tab.number)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);

      // Tab 3 stays open to the next day; the others are canceled.
      for (const tab of tabs.filter((row) => row.number !== 3)) {
        await ok('post', `/tabs/${tab.id}/cancel`, c.counter.auth, {}, 200);
      }
      await closeRegister(c, register);
      await moveDaysBack(c, 1);
      await openRegister(c);
      const numbers: number[] = [];
      for (const name of ['Hoje 1', 'Hoje 2', 'Hoje 3']) {
        numbers.push((await openTab(c, name)).number);
      }
      expect(numbers).toEqual([1, 2, 4]);
      const varal = await listTabs(c);
      expect(varal.map((tab) => [tab.number, tab.businessDate])).toEqual([
        [3, daysAgo(1)],
        [1, today()],
        [2, today()],
        [4, today()],
      ]);
    });

    it('CA-04.19, RN-04.08, RN-05.29: closing the last register takes the items in preparation to the final stage, one audit row each', async () => {
      const c = await crew('Encerrar preparo');
      const second = await ok<CashRegisterDto>(
        'post',
        `/units/${c.setup.tenant.unitId}/cash-registers`,
        c.owner,
        { name: 'Caixa 2' },
      );
      const register = await openRegister(c);
      const other = await openRegister(c, { register: second.id });
      const tab = await openTab(c);
      const order = await sendOrder(c, tab.id, [
        skewer(c, 2),
        { productId: c.setup.products.pastry, quantity: 1 },
      ]);
      // Not the last register: nothing moves.
      const preview = await ok<ClosePreviewDto>(
        'get',
        `/cash-register-sessions/${other.session?.id ?? ''}/close-preview`,
        c.owner,
      );
      expect(preview).toMatchObject({ lastOpenRegister: false, itemsInProgress: 0 });
      await closeRegister(c, other);
      await expect(
        platform.orderItem.count({ where: { orderId: order.id, stationId: { not: null } } }),
      ).resolves.toBe(2);

      const closed = await closeRegister(c, register);
      expect(closed.session?.status).toBe('closed');
      const items = await platform.orderItem.findMany({ where: { orderId: order.id } });
      expect(items.every((item) => item.stageId === c.setup.stages.delivered)).toBe(true);
      expect(items.every((item) => item.stationId === null)).toBe(true);
      await expect(
        platform.order.findUniqueOrThrow({ where: { id: order.id } }),
      ).resolves.toMatchObject({ status: 'completed' });
      for (const item of items) {
        const audit = await platform.auditLog.findMany({
          where: { entityId: item.id, action: 'order_item.stage_changed' },
        });
        expect(audit).toHaveLength(1);
        expect(audit[0]?.changes).toMatchObject({ metadata: { reason: 'cash_register_closed' } });
      }
      await expect(queue(c, c.setup.stations.kitchen)).resolves.toMatchObject({ orders: [] });
      // The tab stays open (RN-04.07).
      await expect(
        platform.tab.findUniqueOrThrow({ where: { id: tab.id } }),
      ).resolves.toMatchObject({ status: 'open' });
    });

    it('RN-04.08: the last register closed with "Encerrar o preparo pendente" unchecked keeps the items in the queue', async () => {
      const c = await crew('Manter preparo');
      const register = await openRegister(c);
      const tab = await openTab(c);
      const order = await sendOrder(c, tab.id, [skewer(c)]);
      await closeRegister(c, register, { finishPendingItems: false });
      const kitchen = await queue(c, c.setup.stations.kitchen);
      expect(kitchen.orders.map((row) => row.orderId)).toEqual([order.id]);
    });
  });

  // ----------------------------------------------------------------------------------------------
  // Current price list and events
  // ----------------------------------------------------------------------------------------------

  describe('current price list (spec 04, section 3.2)', () => {
    it('CA-04.07, CA-03.09, RN-04.18, RN-04.31: with "Evento" current, products of the list use its price and the others the normal one; back to "Normal" for new items only', async () => {
      const c = await crew('Tabela vigente');
      const evento = await createPriceList(c, 'Evento', [
        { productId: c.setup.products.skewer, priceCents: 1000 },
      ]);
      // RN-04.31: the kitchen does not change the list; the counter (cash) does, without a register.
      const refused = await http()
        .put(`${API}/units/${c.setup.tenant.unitId}/current-price-list`)
        .set(as(c.kitchen.auth))
        .send({ priceListId: evento.id })
        .expect(403);
      expect(errorOf(refused).code).toBe('FORBIDDEN');
      const changed = await ok<UnitOperationDto>(
        'put',
        `/units/${c.setup.tenant.unitId}/current-price-list`,
        c.counter.auth,
        { priceListId: evento.id },
      );
      expect(changed).toMatchObject({
        currentPriceList: { id: evento.id, name: 'Evento' },
        effectivePriceList: { id: evento.id, name: 'Evento' },
      });
      expect(await auditActions(c.setup.tenant.unitId)).toContain('unit.price_list_changed');

      await openRegister(c);
      const tab = await openTab(c);
      const order = await sendOrder(c, tab.id, [
        skewer(c, 2, [c.setup.modifiers.garlicBread]),
        { productId: c.setup.products.pastry, quantity: 1 },
      ]);
      expect(order.items.map((item) => [item.unitPriceCents, item.priceListId])).toEqual([
        [1000, evento.id],
        [800, null],
      ]);
      // (1000 + 300) × 2 + 800: modifiers do not change by list (RN-03.21).
      expect(order.items.map((item) => item.totalCents)).toEqual([2600, 800]);

      await ok('put', `/units/${c.setup.tenant.unitId}/current-price-list`, c.owner, {
        priceListId: null,
      });
      const normal = await sendOrder(c, tab.id, [skewer(c)]);
      expect(firstItem(normal)).toMatchObject({ unitPriceCents: 1200, priceListId: null });
      const after = await ok<TabDto>('get', `/tabs/${tab.id}`, c.counter.auth);
      expect(after.orders[0]?.items.map((item) => item.unitPriceCents)).toEqual([1000, 800]);
      expect(after.subtotalCents).toBe(2600 + 800 + 1200);
    });

    it('RN-04.31: only an active list of the unit can be current (INVALID_PRICE_LIST); version conflicts', async () => {
      const c = await crew('Tabela inválida');
      const other = await crew('Tabela de outra');
      const foreign = await createPriceList(other, 'Evento', []);
      const inactive = await createPriceList(c, 'Antiga', []);
      await ok('patch', `/price-lists/${inactive.id}`, c.owner, { active: false });
      for (const priceListId of [foreign.id, inactive.id]) {
        const response = await http()
          .put(`${API}/units/${c.setup.tenant.unitId}/current-price-list`)
          .set(as(c.owner))
          .send({ priceListId })
          .expect(400);
        expect(errorOf(response).code).toBe('INVALID_PRICE_LIST');
      }
      const op = await operation(c);
      const stale = await http()
        .put(`${API}/units/${c.setup.tenant.unitId}/current-price-list`)
        .set(as(c.owner))
        .send({ priceListId: null, version: op.version + 5 })
        .expect(409);
      expect(errorOf(stale).code).toBe('VERSION_CONFLICT');
    });
  });

  describe('contracted events (spec 04, section 3.3)', () => {
    it('CA-04.14, RN-04.32, RN-04.36: during an event new tabs are tied to it and use its list; the current list is locked; after it, back to the current list', async () => {
      const c = await crew('Evento');
      const list = await createPriceList(c, 'Casamento', [
        { productId: c.setup.products.skewer, priceCents: 900 },
      ]);
      await openRegister(c);
      const before = await openTab(c, 'Antes do evento');

      const refusedCreate = await http()
        .post(`${API}/units/${c.setup.tenant.unitId}/events`)
        .set(as(c.counter.auth))
        .send({ contractorName: 'X', startsOn: today(), modality: 'other' })
        .expect(403);
      expect(errorOf(refusedCreate).code).toBe('FORBIDDEN');
      const event = await createEvent(c, { priceListId: list.id });
      expect(event).toMatchObject({
        status: 'scheduled',
        startsOn: today(),
        priceList: { id: list.id, name: 'Casamento' },
        modality: 'fixed_fee',
        agreedQuantity: 500,
      });
      await expect(operation(c)).resolves.toMatchObject({
        eventsToday: [expect.objectContaining({ id: event.id })],
        eventInProgress: null,
      });

      // RN-04.34: the counter (cash operator) starts it.
      const started = await ok<ContractedEventDto>(
        'post',
        `/events/${event.id}/start`,
        c.counter.auth,
        {},
        200,
      );
      expect(started).toMatchObject({
        status: 'in_progress',
        startedBy: { type: 'staff', id: c.counter.id },
      });
      const during = await operation(c);
      expect(during).toMatchObject({
        eventInProgress: { id: event.id },
        effectivePriceList: { id: list.id },
        currentPriceList: null,
      });

      const tab = await openTab(c, 'Convidado');
      expect(tab.eventId).toBe(event.id);
      const order = await sendOrder(c, tab.id, [skewer(c)]);
      expect(firstItem(order)).toMatchObject({ unitPriceCents: 900, priceListId: list.id });
      // RN-04.36: a tab opened before the event does not join it.
      const beforeOrder = await sendOrder(c, before.id, [skewer(c)]);
      expect((await ok<TabDto>('get', `/tabs/${before.id}`, c.owner)).eventId).toBeNull();
      expect(firstItem(beforeOrder).unitPriceCents).toBe(900);

      const locked = await http()
        .put(`${API}/units/${c.setup.tenant.unitId}/current-price-list`)
        .set(as(c.owner))
        .send({ priceListId: null })
        .expect(409);
      expect(errorOf(locked).code).toBe('EVENT_IN_PROGRESS');

      const finished = await ok<ContractedEventDto>(
        'post',
        `/events/${event.id}/finish`,
        c.counter.auth,
        {},
        200,
      );
      expect(finished.status).toBe('finished');
      const afterTab = await openTab(c, 'Depois');
      expect(afterTab.eventId).toBeNull();
      const afterOrder = await sendOrder(c, afterTab.id, [skewer(c)]);
      expect(firstItem(afterOrder)).toMatchObject({ unitPriceCents: 1200, priceListId: null });
      // RN-04.34: a finished event never comes back nor changes (RN-04.37).
      const again = await http()
        .post(`${API}/events/${event.id}/start`)
        .set(as(c.owner))
        .send({})
        .expect(409);
      expect(errorOf(again).code).toBe('EVENT_NOT_SCHEDULED');
      const edit = await http()
        .patch(`${API}/events/${event.id}`)
        .set(as(c.owner))
        .send({ notes: 'Tarde demais' })
        .expect(409);
      expect(errorOf(edit).code).toBe('EVENT_CLOSED');
      expect(await auditActions(event.id)).toEqual([
        'event.created',
        'event.started',
        'event.finished',
      ]);
    });

    it('CA-04.15, RN-04.35: a second event in progress in the unit is refused', async () => {
      const c = await crew('Dois eventos');
      const first = await createEvent(c, { contractorName: 'Primeiro' });
      const second = await createEvent(c, { contractorName: 'Segundo' });
      await ok('post', `/events/${first.id}/start`, c.owner, {}, 200);
      const refused = await http()
        .post(`${API}/events/${second.id}/start`)
        .set(as(c.owner))
        .send({})
        .expect(409);
      expect(errorOf(refused)).toMatchObject({
        code: 'EVENT_ALREADY_IN_PROGRESS',
        details: { eventId: first.id },
      });
      // The kitchen neither starts nor reads events.
      const kitchen = await http()
        .get(`${API}/units/${c.setup.tenant.unitId}/events`)
        .set(as(c.kitchen.auth))
        .expect(403);
      expect(errorOf(kitchen).code).toBe('FORBIDDEN');
      const list = await ok<{ data: ContractedEventDto[] }>(
        'get',
        `/units/${c.setup.tenant.unitId}/events`,
        c.counter.auth,
      );
      expect(list.data.map((event) => [event.id, event.status])).toEqual([
        [first.id, 'in_progress'],
        [second.id, 'scheduled'],
      ]);
      // RN-04.34: only a scheduled event is canceled, by the owner.
      const counterCancel = await http()
        .post(`${API}/events/${second.id}/cancel`)
        .set(as(c.counter.auth))
        .send({})
        .expect(403);
      expect(errorOf(counterCancel).code).toBe('FORBIDDEN');
      await expect(
        ok<ContractedEventDto>('post', `/events/${second.id}/cancel`, c.owner, {}, 200),
      ).resolves.toMatchObject({ status: 'canceled' });
      const cancelRunning = await http()
        .post(`${API}/events/${first.id}/cancel`)
        .set(as(c.owner))
        .send({})
        .expect(409);
      expect(errorOf(cancelRunning).code).toBe('EVENT_NOT_SCHEDULED');
    });

    it('RN-04.35, RN-05.29: the register opens with the event of today and the last one closes finishing it', async () => {
      const c = await crew('Evento com caixa');
      const event = await createEvent(c);
      const register = await openRegister(c, { startEventId: event.id });
      await expect(
        ok<ContractedEventDto>('get', `/events/${event.id}`, c.owner),
      ).resolves.toMatchObject({ status: 'in_progress' });
      const preview = await ok<ClosePreviewDto>(
        'get',
        `/cash-register-sessions/${register.session?.id ?? ''}/close-preview`,
        c.owner,
      );
      expect(preview.eventInProgress).toEqual({
        id: event.id,
        contractorName: 'Casamento Ana e Leo',
      });
      await closeRegister(c, register, { finishEvent: true });
      await expect(
        ok<ContractedEventDto>('get', `/events/${event.id}`, c.owner),
      ).resolves.toMatchObject({ status: 'finished' });
    });

    it('RN-04.05, RN-04.37: the event list must be an active list of the unit; the agreement changes until the end', async () => {
      const c = await crew('Evento acordo');
      const other = await crew('Evento acordo outra');
      const foreign = await createPriceList(other, 'Festa', []);
      const invalid = await http()
        .post(`${API}/units/${c.setup.tenant.unitId}/events`)
        .set(as(c.owner))
        .send({
          contractorName: 'Festa',
          startsOn: today(),
          modality: 'other',
          priceListId: foreign.id,
        })
        .expect(400);
      expect(errorOf(invalid).code).toBe('INVALID_PRICE_LIST');
      const badDates = await http()
        .post(`${API}/units/${c.setup.tenant.unitId}/events`)
        .set(as(c.owner))
        .send({ contractorName: 'Festa', startsOn: today(), endsOn: daysAgo(1), modality: 'other' })
        .expect(400);
      expect(errorOf(badDates).code).toBe('VALIDATION_FAILED');
      const event = await createEvent(c);
      const edited = await ok<ContractedEventDto>('patch', `/events/${event.id}`, c.owner, {
        agreedQuantity: 600,
        limits: '600 espetos',
        version: event.version,
      });
      expect(edited).toMatchObject({ agreedQuantity: 600, limits: '600 espetos' });
      const stale = await http()
        .patch(`${API}/events/${event.id}`)
        .set(as(c.owner))
        .send({ notes: 'x', version: event.version })
        .expect(409);
      expect(errorOf(stale).code).toBe('VERSION_CONFLICT');
    });
  });

  // ----------------------------------------------------------------------------------------------
  // Tabs
  // ----------------------------------------------------------------------------------------------

  describe('tabs (spec 04, section 4)', () => {
    it('RN-04.10: customer name from 1 to 40 characters; only the counter opens tabs', async () => {
      const c = await crew('Nome');
      await openRegister(c);
      for (const customerName of ['', '   ', 'x'.repeat(41)]) {
        const response = await http()
          .post(`${API}/units/${c.setup.tenant.unitId}/tabs`)
          .set(as(c.counter.auth))
          .send({ customerName })
          .expect(400);
        expect(errorOf(response).code).toBe('VALIDATION_FAILED');
      }
      const kitchen = await http()
        .post(`${API}/units/${c.setup.tenant.unitId}/tabs`)
        .set(as(c.kitchen.auth))
        .send({ customerName: 'Seu João' })
        .expect(403);
      expect(errorOf(kitchen).code).toBe('FORBIDDEN');
      const tab = await openTab(c, '  Seu João  ');
      expect(tab).toMatchObject({
        number: 1,
        customerName: 'Seu João',
        mode: 'open_tab',
        status: 'open',
        businessDate: today(),
        closedBusinessDate: null,
        eventId: null,
        subtotalCents: 0,
        totalCents: 0,
        orders: [],
      });
      expect(await auditActions(tab.id)).toEqual(['tab.opened']);
    });

    it('RN-04.12/RN-04.13, RN-04.38: request the bill, refuse orders while closing, reopen, cancel with the day', async () => {
      const c = await crew('Transições');
      await openRegister(c);
      const tab = await openTab(c);
      const order = await sendOrder(c, tab.id, [skewer(c)]);

      const closing = await ok<TabDto>(
        'post',
        `/tabs/${tab.id}/request-bill`,
        c.counter.auth,
        {},
        200,
      );
      expect(closing.status).toBe('closing');
      const refused = await http()
        .post(`${API}/tabs/${tab.id}/orders`)
        .set(as(c.counter.auth))
        .send({ items: [skewer(c)] })
        .expect(409);
      expect(errorOf(refused).code).toBe('TAB_NOT_OPEN');
      const twice = await http()
        .post(`${API}/tabs/${tab.id}/request-bill`)
        .set(as(c.counter.auth))
        .send({})
        .expect(409);
      expect(errorOf(twice).code).toBe('TAB_NOT_OPEN');
      const stale = await http()
        .post(`${API}/tabs/${tab.id}/reopen`)
        .set(as(c.counter.auth))
        .send({ version: tab.version })
        .expect(409);
      expect(errorOf(stale).code).toBe('TAB_CHANGED');

      const reopened = await ok<TabDto>(
        'post',
        `/tabs/${tab.id}/reopen`,
        c.counter.auth,
        { version: closing.version },
        200,
      );
      expect(reopened.status).toBe('open');
      const notClosing = await http()
        .post(`${API}/tabs/${tab.id}/reopen`)
        .set(as(c.counter.auth))
        .send({})
        .expect(409);
      expect(errorOf(notClosing).code).toBe('TAB_NOT_CLOSING');

      const active = await http()
        .post(`${API}/tabs/${tab.id}/cancel`)
        .set(as(c.counter.auth))
        .send({ reason: 'Cliente foi embora' })
        .expect(409);
      expect(errorOf(active)).toMatchObject({
        code: 'TAB_HAS_ACTIVE_ITEMS',
        details: { itemIds: [firstItem(order).id] },
      });
      const item = firstItem(order);
      await ok(
        'post',
        `/order-items/${item.id}/cancel`,
        c.counter.auth,
        { version: item.version, reason: 'Desistiu' },
        200,
      );
      const canceled = await ok<TabDto>(
        'post',
        `/tabs/${tab.id}/cancel`,
        c.counter.auth,
        { reason: 'Cliente foi embora' },
        200,
      );
      expect(canceled).toMatchObject({
        status: 'canceled',
        totalCents: 0,
        closedBusinessDate: today(),
      });
      expect(canceled.closedAt).not.toBeNull();
      const again = await http()
        .post(`${API}/tabs/${tab.id}/request-bill`)
        .set(as(c.counter.auth))
        .send({})
        .expect(409);
      expect(errorOf(again).code).toBe('TAB_CLOSED');
      expect(await auditActions(tab.id)).toEqual([
        'tab.opened',
        'tab.bill_requested',
        'tab.reopened',
        'tab.canceled',
      ]);
    });
  });

  // ----------------------------------------------------------------------------------------------
  // Orders
  // ----------------------------------------------------------------------------------------------

  describe('orders (spec 04, section 5)', () => {
    it('RN-04.18/RN-04.19: each item copies what was sold and enters the first stage at its station', async () => {
      const c = await crew('Pedido');
      await openRegister(c);
      const tab = await openTab(c);
      const order = await sendOrder(c, tab.id, [
        {
          ...skewer(c, 3, [c.setup.modifiers.garlicBread, c.setup.modifiers.farofa]),
          note: '  sem sal ',
        },
        { productId: c.setup.products.pastry, quantity: 2 },
        { productId: c.setup.products.soda, quantity: 1, note: '' },
      ]);
      expect(order).toMatchObject({
        tabId: tab.id,
        numberInTab: 1,
        status: 'sent',
        tabNumber: 1,
        customerName: 'Dona Marta',
        createdBy: { type: 'staff', id: c.counter.id },
      });
      const [carne, pastel, refri] = order.items;
      expect(carne).toMatchObject({
        productName: 'Espeto de carne',
        unitPriceCents: 1200,
        priceListId: null,
        quantity: 3,
        note: 'sem sal',
        modifiers: [
          { groupName: 'Ponto da carne', modifierName: 'Ao ponto', priceDeltaCents: 0 },
          { groupName: 'Acompanhamentos', modifierName: 'Farofa', priceDeltaCents: 0 },
          { groupName: 'Acompanhamentos', modifierName: 'Pão de alho', priceDeltaCents: 300 },
        ],
        totalCents: 4500,
        prepStationId: c.setup.stations.kitchen,
        stationId: c.setup.stations.kitchen,
        stageId: c.setup.stages.received,
        stageName: 'Recebido',
        isLate: false,
        version: 0,
      });
      expect(pastel).toMatchObject({ stationId: c.setup.stations.fryer, stageName: 'Recebido' });
      expect(refri).toMatchObject({ stationId: c.setup.stations.delivery, note: null });

      // RN-03.12: later menu changes do not touch items already sent.
      await platform.product.update({
        where: { id: c.setup.products.skewer },
        data: { name: 'Espeto premium', priceCents: 9999 },
      });
      await platform.modifierGroup.delete({ where: { id: c.setup.groups.sides } });
      const tabAfter = await ok<TabDto>('get', `/tabs/${tab.id}`, c.kitchen.auth);
      expect(tabAfter.orders[0]?.items[0]).toMatchObject({
        productName: 'Espeto de carne',
        unitPriceCents: 1200,
        totalCents: 4500,
      });
      expect(tabAfter.orders[0]?.items[0]?.modifiers).toHaveLength(3);
      expect(tabAfter).toMatchObject({ subtotalCents: 4500 + 1600 + 600, itemCount: 6 });

      const second = await sendOrder(c, tab.id, [
        { productId: c.setup.products.soda, quantity: 1 },
      ]);
      expect(second.numberInTab).toBe(2);
      expect(await auditActions(order.id)).toEqual(['order.created']);
    });

    it('CA-04.06/CA-03.06/RN-04.17: refused items are pointed one by one and nothing is sent', async () => {
      const c = await crew('Recusa');
      await openRegister(c);
      const tab = await openTab(c);
      await platform.product.update({
        where: { id: c.setup.products.pastry },
        data: { soldOut: true },
      });
      await platform.product.update({
        where: { id: c.setup.products.soda },
        data: { active: false },
      });
      const refused = await http()
        .post(`${API}/tabs/${tab.id}/orders`)
        .set(as(c.counter.auth))
        .send({
          items: [
            skewer(c),
            { productId: c.setup.products.pastry, quantity: 1 },
            { productId: c.setup.products.skewer, quantity: 1 },
            { productId: c.setup.products.soda, quantity: 1 },
          ],
        })
        .expect(409);
      expect(errorOf(refused)).toMatchObject({
        code: 'ORDER_REJECTED',
        details: {
          items: [
            {
              index: 1,
              productId: c.setup.products.pastry,
              reason: 'sold_out',
              modifierGroupId: null,
            },
            {
              index: 2,
              productId: c.setup.products.skewer,
              reason: 'modifier_required',
              modifierGroupId: c.setup.groups.doneness,
            },
            {
              index: 3,
              productId: c.setup.products.soda,
              reason: 'product_inactive',
              modifierGroupId: null,
            },
          ],
        },
      });
      await expect(platform.order.count({ where: { tabId: tab.id } })).resolves.toBe(0);
    });

    it('RN-04.16: 1 to 50 items, quantity 1 to 99, note up to 140', async () => {
      const c = await crew('Limites');
      await openRegister(c);
      const tab = await openTab(c);
      const soda = { productId: c.setup.products.soda, quantity: 1 };
      for (const items of [
        [],
        Array.from({ length: 51 }, () => soda),
        [{ ...soda, quantity: 0 }],
        [{ ...soda, quantity: 100 }],
        [{ ...soda, note: 'x'.repeat(141) }],
      ]) {
        const response = await http()
          .post(`${API}/tabs/${tab.id}/orders`)
          .set(as(c.counter.auth))
          .send({ items })
          .expect(400);
        expect(errorOf(response).code).toBe('VALIDATION_FAILED');
      }
      const fifty = await sendOrder(
        c,
        tab.id,
        Array.from({ length: 50 }, () => ({ ...soda, quantity: 99 })),
      );
      expect(fifty.items).toHaveLength(50);
    });

    it('CA-01.06: an order, a stage change and a tab sent again with the same Idempotency-Key are not duplicated', async () => {
      const c = await crew('Idempotência');
      await openRegister(c);
      const tab = await openTab(c);
      const key = crypto.randomUUID();
      const send = () =>
        http()
          .post(`${API}/tabs/${tab.id}/orders`)
          .set(as(c.counter.auth))
          .set('Idempotency-Key', key)
          .send({ items: [skewer(c, 2)] });
      const first = await send().expect(201);
      const replay = await send().expect(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      await expect(platform.order.count({ where: { tabId: tab.id } })).resolves.toBe(1);

      const item = firstItem(first.body as OrderDto);
      const advanceKey = crypto.randomUUID();
      const move = () =>
        http()
          .post(`${API}/order-items/${item.id}/advance`)
          .set(as(c.kitchen.auth))
          .set('Idempotency-Key', advanceKey)
          .send({ version: item.version });
      await move().expect(200);
      const again = await move().expect(200);
      expect(again.headers['idempotent-replayed']).toBe('true');
      await expect(
        platform.orderItem.findUniqueOrThrow({ where: { id: item.id } }),
      ).resolves.toMatchObject({ stageId: c.setup.stages.preparing, version: 1 });

      const tabKey = crypto.randomUUID();
      for (let attempt = 0; attempt < 2; attempt++) {
        await http()
          .post(`${API}/units/${c.setup.tenant.unitId}/tabs`)
          .set(as(c.counter.auth))
          .set('Idempotency-Key', tabKey)
          .send({ customerName: 'Só uma' })
          .expect(201);
      }
      await expect(
        platform.tab.count({ where: { unitId: c.setup.tenant.unitId, customerName: 'Só uma' } }),
      ).resolves.toBe(1);
    });
  });

  // ----------------------------------------------------------------------------------------------
  // Stages and items
  // ----------------------------------------------------------------------------------------------

  describe('stages (spec 04, section 5.1)', () => {
    it('RN-04.20/RN-04.21: each station advances its items; the counter registers the delivery', async () => {
      const c = await crew('Etapas');
      await openRegister(c);
      const tab = await openTab(c);
      const order = await sendOrder(c, tab.id, [skewer(c)]);
      let item = firstItem(order);

      for (const auth of [c.counter.auth, c.fryer.auth]) {
        const response = await http()
          .post(`${API}/order-items/${item.id}/advance`)
          .set(as(auth))
          .send({ version: item.version })
          .expect(403);
        expect(errorOf(response).code).toBe('FORBIDDEN');
      }
      item = (await advance(c.kitchen.auth, item)).changed;
      expect(item).toMatchObject({ stageName: 'Preparando', stationId: c.setup.stations.kitchen });
      item = (await advance(c.kitchen.auth, item)).changed;
      expect(item).toMatchObject({ stageName: 'Pronto', stationId: c.setup.stations.delivery });
      await http()
        .post(`${API}/order-items/${item.id}/advance`)
        .set(as(c.kitchen.auth))
        .send({ version: item.version })
        .expect(403);
      expect((await listTabs(c))[0]?.readyItemCount).toBe(1);

      const delivered = await advance(c.counter.auth, item);
      expect(delivered.changed).toMatchObject({
        stageName: 'Entregue',
        stageIsFinal: true,
        stationId: null,
        lateAt: null,
        attentionAt: null,
      });
      const final = await http()
        .post(`${API}/order-items/${item.id}/advance`)
        .set(as(c.owner))
        .send({ version: delivered.changed.version })
        .expect(409);
      expect(errorOf(final).code).toBe('ITEM_IN_FINAL_STAGE');
      const tabAfter = await ok<TabDto>('get', `/tabs/${tab.id}`, c.counter.auth);
      expect(tabAfter.orders[0]).toMatchObject({ status: 'completed' });
      expect(tabAfter.orders[0]?.completedAt).not.toBeNull();
      expect(await auditActions(order.id)).toEqual(['order.created', 'order.completed']);
      expect(await auditActions(item.id)).toEqual([
        'order_item.stage_changed',
        'order_item.stage_changed',
        'order_item.stage_changed',
      ]);
    });

    it('CA-04.13/RN-04.24: advancing 2 of 3 leaves 1 in the stage and 2 in the next, linked, same total', async () => {
      const c = await crew('Dividir');
      await openRegister(c);
      const tab = await openTab(c);
      const order = await sendOrder(c, tab.id, [skewer(c, 3, [c.setup.modifiers.garlicBread])]);
      const preparing = (await advance(c.kitchen.auth, firstItem(order))).changed;
      const before = await ok<TabDto>('get', `/tabs/${tab.id}`, c.counter.auth);

      const tooMany = await http()
        .post(`${API}/order-items/${preparing.id}/advance`)
        .set(as(c.kitchen.auth))
        .send({ version: preparing.version, quantity: 4 })
        .expect(400);
      expect(errorOf(tooMany).code).toBe('INVALID_QUANTITY');

      const split = await advance(c.kitchen.auth, preparing, 2);
      expect(split.changed).toMatchObject({
        quantity: 2,
        stageName: 'Pronto',
        stationId: c.setup.stations.delivery,
        splitFromId: preparing.id,
        version: 0,
        modifiers: preparing.modifiers,
        unitPriceCents: 1200,
      });
      expect(split.remaining).toMatchObject({
        id: preparing.id,
        quantity: 1,
        stageName: 'Preparando',
        stageEnteredAt: preparing.stageEnteredAt,
        version: preparing.version + 1,
      });
      const after = await ok<TabDto>('get', `/tabs/${tab.id}`, c.counter.auth);
      expect(after.totalCents).toBe(before.totalCents);
      expect(after.totalCents).toBe(3 * 1500);
      expect(after.orders[0]?.items.map((item) => [item.quantity, item.stageName])).toEqual([
        [1, 'Preparando'],
        [2, 'Pronto'],
      ]);

      const back = await ok<ItemChangeDto>(
        'post',
        `/order-items/${split.changed.id}/back`,
        c.counter.auth,
        { version: split.changed.version },
        200,
      );
      expect(back).toMatchObject({
        changed: { stageName: 'Preparando', quantity: 2 },
        remaining: null,
      });
    });

    it('CA-04.05: two devices advancing the same item at once make a single advance; the second gets the state', async () => {
      const c = await crew('Concorrência');
      await openRegister(c);
      const tab = await openTab(c);
      const item = firstItem(await sendOrder(c, tab.id, [skewer(c)]));
      const responses = await Promise.all(
        [c.kitchen.auth, c.owner].map((auth) =>
          http()
            .post(`${API}/order-items/${item.id}/advance`)
            .set(as(auth))
            .send({ version: item.version }),
        ),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const conflict = responses.find((response) => response.status === 409);
      if (!conflict) {
        throw new Error('expected a conflict');
      }
      expect(errorOf(conflict)).toMatchObject({
        code: 'ITEM_CHANGED',
        details: {
          currentVersion: 1,
          item: { id: item.id, stageName: 'Preparando', version: 1 },
        },
      });
      await expect(
        platform.orderItem.findUniqueOrThrow({ where: { id: item.id } }),
      ).resolves.toMatchObject({ stageId: c.setup.stages.preparing, version: 1 });
    });

    it('RN-04.22: going back is audited; never from the first or the final stage', async () => {
      const c = await crew('Voltar');
      await openRegister(c);
      const tab = await openTab(c);
      const item = firstItem(await sendOrder(c, tab.id, [skewer(c)]));
      const first = await http()
        .post(`${API}/order-items/${item.id}/back`)
        .set(as(c.kitchen.auth))
        .send({ version: item.version })
        .expect(409);
      expect(errorOf(first).code).toBe('NO_PREVIOUS_STAGE');

      const ready = (await advance(c.kitchen.auth, (await advance(c.kitchen.auth, item)).changed))
        .changed;
      const undone = await ok<ItemChangeDto>(
        'post',
        `/order-items/${ready.id}/back`,
        c.kitchen.auth,
        { version: ready.version },
        200,
      );
      expect(undone.changed).toMatchObject({
        stageName: 'Preparando',
        stationId: c.setup.stations.kitchen,
      });
      const fryerRefused = await http()
        .post(`${API}/order-items/${ready.id}/back`)
        .set(as(c.fryer.auth))
        .send({ version: undone.changed.version })
        .expect(403);
      expect(errorOf(fryerRefused).code).toBe('FORBIDDEN');

      const delivered = (
        await advance(c.counter.auth, (await advance(c.kitchen.auth, undone.changed)).changed)
      ).changed;
      const fromFinal = await http()
        .post(`${API}/order-items/${item.id}/back`)
        .set(as(c.owner))
        .send({ version: delivered.version })
        .expect(409);
      expect(errorOf(fromFinal).code).toBe('ITEM_IN_FINAL_STAGE');
      const audit = await platform.auditLog.findFirstOrThrow({
        where: { entityId: item.id, action: 'order_item.stage_reverted' },
      });
      expect(audit).toMatchObject({ actorType: 'staff', actorId: c.kitchen.id });
      expect(audit.changes).toMatchObject({
        before: { stageId: c.setup.stages.ready },
        after: { stageId: c.setup.stages.preparing },
      });
    });

    it('CA-04.11/RN-04.23: an item is in attention and late by the limits of its preparation station', async () => {
      const c = await crew('Atraso');
      await platform.station.update({
        where: { id: c.setup.stations.kitchen },
        data: { attentionAfterMinutes: 5, lateAfterMinutes: 10 },
      });
      await openRegister(c);
      const tab = await openTab(c);
      const order = await sendOrder(c, tab.id, [
        skewer(c, 2),
        { productId: c.setup.products.pastry, quantity: 1 },
      ]);
      const skewerLine = firstItem(order);
      expect(skewerLine.isLate).toBe(false);
      expect(Date.parse(skewerLine.attentionAt ?? '') - Date.parse(order.sentAt)).toBe(5 * 60_000);
      expect(Date.parse(skewerLine.lateAt ?? '') - Date.parse(order.sentAt)).toBe(10 * 60_000);
      // The pastry follows the Fritadeira (7 and 15 minutes).
      expect(Date.parse(firstItem(order, 1).lateAt ?? '') - Date.parse(order.sentAt)).toBe(
        15 * 60_000,
      );

      await platform.order.update({
        where: { id: order.id },
        data: { sentAt: new Date(Date.now() - 11 * 60_000) },
      });
      const after = await ok<TabDto>('get', `/tabs/${tab.id}`, c.counter.auth);
      expect(after.orders[0]?.items.map((item) => item.isLate)).toEqual([true, false]);
      expect((await listTabs(c))[0]?.lateItemCount).toBe(2);

      const pastry = firstItem(order, 1);
      const ready = (await advance(c.fryer.auth, (await advance(c.fryer.auth, pastry)).changed))
        .changed;
      const delivered = await advance(c.counter.auth, ready);
      expect(delivered.changed).toMatchObject({ isLate: false, lateAt: null });
    });
  });

  describe('cancellation (spec 04, section 5.3)', () => {
    it('CA-04.08: canceling 1 of 3 skewers in preparation makes a canceled line of 1 (waste) and an active line of 2', async () => {
      const c = await crew('Cancelar');
      await openRegister(c);
      const tab = await openTab(c);
      const order = await sendOrder(c, tab.id, [skewer(c, 3)]);
      const preparing = (await advance(c.kitchen.auth, firstItem(order))).changed;

      const noReason = await http()
        .post(`${API}/order-items/${preparing.id}/cancel`)
        .set(as(c.kitchen.auth))
        .send({ version: preparing.version, quantity: 1 })
        .expect(400);
      expect(errorOf(noReason).code).toBe('VALIDATION_FAILED');
      const fryer = await http()
        .post(`${API}/order-items/${preparing.id}/cancel`)
        .set(as(c.fryer.auth))
        .send({ version: preparing.version, quantity: 1, reason: 'Queimou' })
        .expect(403);
      expect(errorOf(fryer).code).toBe('FORBIDDEN');

      const result = await ok<ItemChangeDto>(
        'post',
        `/order-items/${preparing.id}/cancel`,
        c.kitchen.auth,
        { version: preparing.version, quantity: 1, reason: 'Queimou' },
        200,
      );
      expect(result.changed).toMatchObject({
        quantity: 1,
        wasted: true,
        cancelReason: 'Queimou',
        canceledBy: { type: 'staff', id: c.kitchen.id },
        canceledBusinessDate: today(),
        stationId: null,
        splitFromId: preparing.id,
      });
      expect(result.changed.canceledAt).not.toBeNull();
      expect(result.remaining).toMatchObject({
        id: preparing.id,
        quantity: 2,
        canceledAt: null,
        canceledBusinessDate: null,
        stageName: 'Preparando',
      });
      const after = await ok<TabDto>('get', `/tabs/${tab.id}`, c.counter.auth);
      expect(after).toMatchObject({ subtotalCents: 2 * 1200, itemCount: 2 });
      expect(after.version).toBeGreaterThan(tab.version);
      const audit = await platform.auditLog.findFirstOrThrow({
        where: { entityId: result.changed.id, action: 'order_item.canceled' },
      });
      expect(audit.changes).toMatchObject({ metadata: { reason: 'Queimou', quantity: 1 } });

      const canceledAgain = await http()
        .post(`${API}/order-items/${result.changed.id}/cancel`)
        .set(as(c.counter.auth))
        .send({ version: result.changed.version, reason: 'De novo' })
        .expect(409);
      expect(errorOf(canceledAgain).code).toBe('ITEM_CANCELED');
    });

    it('RN-04.27/RN-04.28: no waste in the first stage; delivered items are waste; closed tabs refuse', async () => {
      const c = await crew('Perda');
      await openRegister(c);
      const tab = await openTab(c);
      const order = await sendOrder(c, tab.id, [
        skewer(c),
        { productId: c.setup.products.soda, quantity: 1 },
      ]);
      const received = await ok<ItemChangeDto>(
        'post',
        `/order-items/${firstItem(order).id}/cancel`,
        c.counter.auth,
        { version: 0, reason: 'Pediu errado' },
        200,
      );
      expect(received.changed).toMatchObject({ wasted: false, quantity: 1 });
      const soda = firstItem(order, 1);
      const ready = (await advance(c.counter.auth, (await advance(c.counter.auth, soda)).changed))
        .changed;
      const delivered = (await advance(c.counter.auth, ready)).changed;
      const returned = await ok<ItemChangeDto>(
        'post',
        `/order-items/${delivered.id}/cancel`,
        c.counter.auth,
        { version: delivered.version, reason: 'Devolveu' },
        200,
      );
      expect(returned.changed).toMatchObject({ wasted: true });

      const other = firstItem(await sendOrder(c, tab.id, [skewer(c)]));
      await platform.tab.update({
        where: { id: tab.id },
        data: { status: 'paid', closedBusinessDate: new Date(`${today()}T00:00:00.000Z`) },
      });
      const paid = await http()
        .post(`${API}/order-items/${other.id}/cancel`)
        .set(as(c.counter.auth))
        .send({ version: other.version, reason: 'Tarde' })
        .expect(409);
      expect(errorOf(paid).code).toBe('TAB_PAID');
      const row = await platform.tab.findUniqueOrThrow({ where: { id: tab.id } });
      const customer = await platform.customer.create({
        data: { organizationId: row.organizationId, unitId: row.unitId, name: 'Cliente' },
      });
      await platform.tab.update({
        where: { id: tab.id },
        data: { status: 'on_credit', customerId: customer.id, creditAt: new Date() },
      });
      const onCredit = await http()
        .post(`${API}/order-items/${other.id}/cancel`)
        .set(as(c.counter.auth))
        .send({ version: other.version, reason: 'Tarde' })
        .expect(409);
      expect(errorOf(onCredit).code).toBe('TAB_CLOSED');
    });
  });

  // ----------------------------------------------------------------------------------------------
  // Station: one order, one card (KDS)
  // ----------------------------------------------------------------------------------------------

  describe('station queue: one order, one card (spec 04, sections 5.2 and 8.2)', () => {
    it('RN-04.40, RN-04.42: one card per order, oldest first, only for who has the station', async () => {
      const c = await crew('Fila');
      await openRegister(c);
      const first = await openTab(c, 'Primeiro');
      const second = await openTab(c, 'Segundo');
      const a = await sendOrder(c, first.id, [
        skewer(c),
        { productId: c.setup.products.pastry, quantity: 1 },
        skewer(c, 2),
      ]);
      const b = await sendOrder(c, second.id, [skewer(c)]);
      await platform.order.update({
        where: { id: b.id },
        data: { sentAt: new Date(Date.now() - 60_000) },
      });

      const kitchen = await queue(c, c.setup.stations.kitchen, c.kitchen.auth);
      expect(kitchen.orders.map((row) => [row.customerName, row.orderId])).toEqual([
        ['Segundo', b.id],
        ['Primeiro', a.id],
      ]);
      expect(card(kitchen, a.id).lines.map((line) => [line.quantity, line.state])).toEqual([
        [1, 'pending'],
        [2, 'pending'],
      ]);
      expect(kitchen.stages.map((stage) => stage.name)).toEqual([
        'Recebido',
        'Preparando',
        'Pronto',
        'Entregue',
      ]);
      const fryerQueue = await queue(c, c.setup.stations.fryer);
      expect(fryerQueue.orders.flatMap((row) => row.lines.map((line) => line.productName))).toEqual(
        ['Pastel'],
      );
      const refused = await http()
        .get(`${API}/stations/${c.setup.stations.kitchen}/queue`)
        .set(as(c.fryer.auth))
        .expect(403);
      expect(errorOf(refused).code).toBe('FORBIDDEN');
    });

    it('CA-04.20, RN-04.41: a line that leaves the station stays on the card as done until the other lines leave', async () => {
      const c = await crew('Cartão');
      await openRegister(c);
      const tab = await openTab(c);
      const order = await sendOrder(c, tab.id, [skewer(c, 2), skewer(c, 1)]);
      const bread = firstItem(order, 1);
      // Recebido → Preparando: still in the Cozinha, with the new stage.
      const preparing = (await advance(c.kitchen.auth, bread)).changed;
      let kitchen = await queue(c, c.setup.stations.kitchen);
      expect(
        card(kitchen, order.id).lines.map((line) => [line.id, line.state, line.stageName]),
      ).toEqual([
        [firstItem(order).id, 'pending', 'Recebido'],
        [bread.id, 'pending', 'Preparando'],
      ]);
      // Preparando → Pronto (Balcão de entrega): done on the card, which stays.
      await advance(c.kitchen.auth, preparing);
      kitchen = await queue(c, c.setup.stations.kitchen);
      expect(card(kitchen, order.id).lines.map((line) => [line.id, line.state])).toEqual([
        [firstItem(order).id, 'pending'],
        [bread.id, 'done'],
      ]);
      // The skewers leave too: the card leaves the station (RN-04.42).
      const skewerLine = firstItem(order);
      await advance(c.kitchen.auth, (await advance(c.kitchen.auth, skewerLine)).changed);
      kitchen = await queue(c, c.setup.stations.kitchen);
      expect(kitchen.orders).toEqual([]);
      // At the delivery counter, the same order is one card with both lines pending.
      const delivery = await queue(c, c.setup.stations.delivery);
      expect(card(delivery, order.id).lines.map((line) => line.state)).toEqual([
        'pending',
        'pending',
      ]);
    });

    it('CA-04.21, RN-04.43: skewer (Cozinha) and pastry (Fritadeira) show "+ 1 item em outra estação" in each', async () => {
      const c = await crew('Outra estação');
      await openRegister(c);
      const tab = await openTab(c);
      const order = await sendOrder(c, tab.id, [
        skewer(c),
        { productId: c.setup.products.pastry, quantity: 1 },
      ]);
      const kitchen = card(await queue(c, c.setup.stations.kitchen), order.id);
      expect(kitchen.lines.map((line) => line.productName)).toEqual(['Espeto de carne']);
      expect(kitchen.otherStationsQuantity).toBe(1);
      const fryer = card(await queue(c, c.setup.stations.fryer), order.id);
      expect(fryer.lines.map((line) => line.productName)).toEqual(['Pastel']);
      expect(fryer.otherStationsQuantity).toBe(1);
    });

    it('CA-04.22, RN-04.44: a second order of the tab is a new card marked as additional; the first does not change', async () => {
      const c = await crew('Adicional');
      await openRegister(c);
      const tab = await openTab(c);
      const first = await sendOrder(c, tab.id, [skewer(c)]);
      const before = card(await queue(c, c.setup.stations.kitchen), first.id);
      const second = await sendOrder(c, tab.id, [skewer(c, 2)]);
      const kitchen = await queue(c, c.setup.stations.kitchen);
      expect(card(kitchen, first.id)).toEqual(before);
      expect(card(kitchen, second.id)).toMatchObject({
        tabNumber: tab.number,
        numberInTab: 2,
        isAdditional: true,
        tabMode: 'open_tab',
      });
      expect(before.isAdditional).toBe(false);
    });

    it('CA-04.23, RN-04.45: a canceled line stays on the card, canceled, with the reason', async () => {
      const c = await crew('Cancelado no cartão');
      await openRegister(c);
      const tab = await openTab(c);
      const order = await sendOrder(c, tab.id, [skewer(c), skewer(c, 2)]);
      const line = firstItem(order);
      await ok(
        'post',
        `/order-items/${line.id}/cancel`,
        c.kitchen.auth,
        { version: line.version, reason: 'Acabou a carne' },
        200,
      );
      const kitchen = card(await queue(c, c.setup.stations.kitchen), order.id);
      expect(kitchen.lines.map((row) => [row.id, row.state, row.cancelReason])).toEqual([
        [line.id, 'canceled', 'Acabou a carne'],
        [firstItem(order, 1).id, 'pending', null],
      ]);
    });

    it('CA-04.17, RN-04.39: advancing the whole order moves its lines at once; a changed line moves none', async () => {
      const c = await crew('Pedido inteiro');
      await openRegister(c);
      const tab = await openTab(c);
      const order = await sendOrder(c, tab.id, [
        skewer(c),
        skewer(c, 2),
        skewer(c, 3),
        { productId: c.setup.products.pastry, quantity: 1 },
      ]);
      const kitchenLines = order.items.filter(
        (item) => item.stationId === c.setup.stations.kitchen,
      );
      const body = {
        stationId: c.setup.stations.kitchen,
        stageId: c.setup.stages.received,
        items: kitchenLines.map((item) => ({ id: item.id, version: item.version })),
      };
      // A line changed on another device: nothing moves.
      const changed = (await advance(c.owner, kitchenLines[0] ?? firstItem(order))).changed;
      await ok<ItemChangeDto>(
        'post',
        `/order-items/${changed.id}/back`,
        c.owner,
        { version: changed.version },
        200,
      );
      const conflict = await http()
        .post(`${API}/orders/${order.id}/advance`)
        .set(as(c.kitchen.auth))
        .send(body)
        .expect(409);
      expect(errorOf(conflict)).toMatchObject({ code: 'ITEM_CHANGED' });
      expect(
        (errorOf(conflict).details as { items: OrderItemDto[] }).items.map((item) => item.id),
      ).toEqual(kitchenLines.map((item) => item.id));
      await expect(
        platform.orderItem.count({
          where: { orderId: order.id, stageId: c.setup.stages.received },
        }),
      ).resolves.toBe(4);
      // A missing line: refused too.
      const fresh = await platform.orderItem.findMany({
        where: { id: { in: kitchenLines.map((item) => item.id) } },
      });
      const missing = await http()
        .post(`${API}/orders/${order.id}/advance`)
        .set(as(c.kitchen.auth))
        .send({
          ...body,
          items: fresh.slice(1).map((item) => ({ id: item.id, version: item.version })),
        })
        .expect(409);
      expect(errorOf(missing).code).toBe('ITEM_CHANGED');
      // The Fritadeira has no access to the Cozinha; no line of the order at the counter.
      const forbidden = await http()
        .post(`${API}/orders/${order.id}/advance`)
        .set(as(c.fryer.auth))
        .send({ ...body, items: fresh.map((item) => ({ id: item.id, version: item.version })) })
        .expect(403);
      expect(errorOf(forbidden).code).toBe('FORBIDDEN');
      const notThere = await http()
        .post(`${API}/orders/${order.id}/advance`)
        .set(as(c.owner))
        .send({
          stationId: c.setup.stations.delivery,
          items: fresh.map((item) => ({ id: item.id, version: item.version })),
        })
        .expect(409);
      expect(errorOf(notThere).code).toBe('ITEM_NOT_AT_STATION');

      const moved = await ok<AdvanceOrderResultDto>(
        'post',
        `/orders/${order.id}/advance`,
        c.kitchen.auth,
        { ...body, items: fresh.map((item) => ({ id: item.id, version: item.version })) },
        200,
      );
      expect(moved.orderId).toBe(order.id);
      expect(moved.items.map((item) => item.stageName)).toEqual([
        'Preparando',
        'Preparando',
        'Preparando',
      ]);
      // The pastry of the Fritadeira did not move.
      await expect(
        platform.orderItem.findUniqueOrThrow({ where: { id: firstItem(order, 3).id } }),
      ).resolves.toMatchObject({ stageId: c.setup.stages.received });
      for (const item of moved.items) {
        expect(await auditActions(item.id)).toContain('order_item.stage_changed');
      }
    });

    it('CA-04.24, RN-03.25, RN-04.46: the card follows the limits of the station; changing them with the register open applies at once', async () => {
      const c = await crew('Limites da estação');
      await openRegister(c);
      const tab = await openTab(c);
      const order = await sendOrder(c, tab.id, [skewer(c)]);
      const sentAt = new Date(Date.now() - 8 * 60_000);
      await platform.order.update({ where: { id: order.id }, data: { sentAt } });
      const limits = await ok<{ attentionAfterMinutes: number; lateAfterMinutes: number }>(
        'patch',
        `/stations/${c.setup.stations.kitchen}`,
        c.owner,
        { attentionAfterMinutes: 7, lateAfterMinutes: 15 },
      );
      expect(limits).toMatchObject({ attentionAfterMinutes: 7, lateAfterMinutes: 15 });
      let kitchen = await queue(c, c.setup.stations.kitchen);
      expect(kitchen).toMatchObject({ attentionAfterMinutes: 7, lateAfterMinutes: 15 });
      let row = card(kitchen, order.id);
      expect(Date.parse(row.attentionAt) - sentAt.getTime()).toBe(7 * 60_000);
      expect(Date.parse(row.lateAt) - sentAt.getTime()).toBe(15 * 60_000);
      // 8 minutes: in attention, not late.
      expect(Date.parse(row.attentionAt)).toBeLessThan(Date.now());
      expect(Date.parse(row.lateAt)).toBeGreaterThan(Date.now());

      await ok('patch', `/stations/${c.setup.stations.kitchen}`, c.owner, {
        attentionAfterMinutes: 10,
      });
      kitchen = await queue(c, c.setup.stations.kitchen);
      row = card(kitchen, order.id);
      expect(Date.parse(row.attentionAt)).toBeGreaterThan(Date.now());

      // Other changes of the station still wait for the register to close (RN-03.07).
      const renamed = await http()
        .patch(`${API}/stations/${c.setup.stations.kitchen}`)
        .set(as(c.owner))
        .send({ name: 'Churrasqueira' })
        .expect(409);
      expect(errorOf(renamed).code).toBe('CASH_REGISTER_OPEN');
      const invalid = await http()
        .patch(`${API}/stations/${c.setup.stations.kitchen}`)
        .set(as(c.owner))
        .send({ attentionAfterMinutes: 15, lateAfterMinutes: 15 })
        .expect(400);
      expect(errorOf(invalid).code).toBe('INVALID_TIME_LIMITS');
    });
  });

  describe('"entrar como" and staff of another unit', () => {
    it('RN-02.20: actions in "entrar como" are the owner\'s, with the admin in the audit', async () => {
      const c = await crew('Entrar como');
      const admin = await platform.platformAdmin.create({
        data: { name: 'Suporte', email: `suporte.${crypto.randomUUID().slice(0, 8)}@teste.local` },
      });
      const impersonated: AuthContext = { ...c.owner, impersonatorId: admin.id };
      await openRegister(c);
      const tab = await ok<TabDto>('post', `/units/${c.setup.tenant.unitId}/tabs`, impersonated, {
        customerName: 'Pelo suporte',
      });
      const audit = await platform.auditLog.findFirstOrThrow({ where: { entityId: tab.id } });
      expect(audit).toMatchObject({
        actorType: 'owner',
        actorId: c.owner.actor.id,
        impersonatorId: admin.id,
      });
    });

    it('staff without the unit get 403 everywhere in it', async () => {
      const c = await crew('Sem unidade');
      await openRegister(c);
      const tab = await openTab(c);
      const order = await sendOrder(c, tab.id, [skewer(c)]);
      const outsider = await platform.staffMember.create({
        data: {
          organizationId: c.setup.tenant.organizationId,
          name: 'Sem acesso',
          username: `fora_${crypto.randomUUID().slice(0, 8)}`,
        },
      });
      const auth: AuthContext = {
        organizationId: c.setup.tenant.organizationId,
        actor: { type: 'staff', id: outsider.id },
      };
      const calls = [
        () => http().get(`${API}/units/${c.setup.tenant.unitId}/operation`),
        () => http().get(`${API}/units/${c.setup.tenant.unitId}/tabs`),
        () => http().get(`${API}/tabs/${tab.id}`),
        () =>
          http()
            .post(`${API}/tabs/${tab.id}/orders`)
            .send({ items: [skewer(c)] }),
        () => http().get(`${API}/stations/${c.setup.stations.kitchen}/queue`),
        () =>
          http()
            .post(`${API}/order-items/${firstItem(order).id}/advance`)
            .send({ version: 0 }),
        () =>
          http()
            .post(`${API}/orders/${order.id}/advance`)
            .send({
              stationId: c.setup.stations.kitchen,
              items: [{ id: firstItem(order).id, version: 0 }],
            }),
      ];
      for (const call of calls) {
        const response = await call().set(as(auth));
        expect(response.status).toBe(403);
        expect(errorOf(response).code).toBe('FORBIDDEN');
      }
    });
  });

  // ----------------------------------------------------------------------------------------------
  // Isolation (CA-01.02)
  // ----------------------------------------------------------------------------------------------

  describe('isolation between organizations (CA-01.02)', () => {
    let a: Crew;
    let b: Crew;
    let tab: TabDto;
    let order: OrderDto;
    let event: ContractedEventDto;
    let ctx: IsolationContext;

    beforeAll(async () => {
      a = await crew('Isolamento A');
      b = await crew('Isolamento B');
      await openRegister(a);
      await openRegister(b);
      tab = await openTab(a);
      order = await sendOrder(a, tab.id, [skewer(a)]);
      event = await createEvent(a);
      ctx = { prisma: app.get(PrismaService), tenantA: a.setup.tenant, tenantB: b.setup.tenant };
    });

    it('every route answers 404 to another organization', async () => {
      const item = firstItem(order);
      const unit = a.setup.tenant.unitId;
      const routes: { method: 'get' | 'post' | 'put' | 'patch'; path: string; body?: object }[] = [
        { method: 'get', path: `/units/${unit}/operation` },
        { method: 'put', path: `/units/${unit}/current-price-list`, body: { priceListId: null } },
        { method: 'get', path: `/units/${unit}/events` },
        {
          method: 'post',
          path: `/units/${unit}/events`,
          body: { contractorName: 'Invasor', startsOn: today(), modality: 'other' },
        },
        { method: 'get', path: `/events/${event.id}` },
        { method: 'patch', path: `/events/${event.id}`, body: { notes: 'Invadido' } },
        { method: 'post', path: `/events/${event.id}/start`, body: {} },
        { method: 'post', path: `/events/${event.id}/finish`, body: {} },
        { method: 'post', path: `/events/${event.id}/cancel`, body: {} },
        { method: 'get', path: `/units/${unit}/tabs` },
        { method: 'post', path: `/units/${unit}/tabs`, body: { customerName: 'Invasor' } },
        { method: 'get', path: `/tabs/${tab.id}` },
        { method: 'post', path: `/tabs/${tab.id}/orders`, body: { items: [skewer(a)] } },
        { method: 'post', path: `/tabs/${tab.id}/request-bill`, body: {} },
        { method: 'post', path: `/tabs/${tab.id}/reopen`, body: {} },
        { method: 'post', path: `/tabs/${tab.id}/cancel`, body: {} },
        { method: 'get', path: `/stations/${a.setup.stations.kitchen}/queue` },
        { method: 'post', path: `/order-items/${item.id}/advance`, body: { version: 0 } },
        { method: 'post', path: `/order-items/${item.id}/back`, body: { version: 0 } },
        {
          method: 'post',
          path: `/order-items/${item.id}/cancel`,
          body: { version: 0, reason: 'x' },
        },
        {
          method: 'post',
          path: `/orders/${order.id}/advance`,
          body: { stationId: a.setup.stations.kitchen, items: [{ id: item.id, version: 0 }] },
        },
      ];
      for (const route of routes) {
        for (const auth of [b.owner, b.counter.auth]) {
          await expectNotFoundForOtherTenant(app, {
            method: route.method,
            path: `${API}${route.path}`,
            as: auth,
            ...(route.body === undefined ? {} : { body: route.body }),
          });
        }
      }
      await expect(platform.tab.count({ where: { unitId: unit } })).resolves.toBe(1);
      await expect(
        platform.orderItem.findUniqueOrThrow({ where: { id: item.id } }),
      ).resolves.toMatchObject({ version: 0, canceledAt: null });
      await expect(
        platform.contractedEvent.findUniqueOrThrow({ where: { id: event.id } }),
      ).resolves.toMatchObject({ status: 'scheduled', notes: null });
    });

    describeTenantIsolation('ContractedEvent', {
      context: () => ctx,
      delegate: (db) => db.contractedEvent,
      create: (db, tenant) =>
        db.contractedEvent.create({
          data: {
            organizationId: requireOrganizationId(),
            unitId: tenant.unitId,
            contractorName: 'Contratante',
            startsOn: new Date(`${today()}T00:00:00.000Z`),
            modality: 'fixed_fee',
          },
        }),
      update: { contractorName: 'Invadido' },
    });

    function tabData(tenant: Tenant, number: number) {
      return {
        organizationId: requireOrganizationId(),
        unitId: tenant.unitId,
        number,
        businessDate: new Date(`${today()}T00:00:00.000Z`),
        customerName: 'Isolada',
        mode: 'open_tab' as const,
        status: 'open' as const,
        openedByType: 'owner' as const,
      };
    }

    describeTenantIsolation('Tab', {
      context: () => ctx,
      delegate: (db) => db.tab,
      create: (db, tenant) =>
        db.tab.create({ data: tabData(tenant, 1000 + Math.floor(Math.random() * 1e6)) }),
      update: { customerName: 'Invadida' },
    });

    describeTenantIsolation('Order', {
      context: () => ctx,
      delegate: (db) => db.order,
      create: (db) =>
        db.order.create({
          data: {
            organizationId: requireOrganizationId(),
            tabId: tab.id,
            numberInTab: 1000 + Math.floor(Math.random() * 1e6),
            createdByType: 'owner',
            sentAt: new Date(),
          },
        }),
      update: { numberInTab: 999 },
    });

    function itemData() {
      const item = firstItem(order);
      return {
        organizationId: requireOrganizationId(),
        orderId: order.id,
        tabId: tab.id,
        unitId: a.setup.tenant.unitId,
        productId: item.productId,
        productName: item.productName,
        unitPriceCents: item.unitPriceCents,
        quantity: 1,
        position: 9,
        prepStationId: item.prepStationId,
        stageId: item.stageId,
        stationId: item.stationId,
        stageEnteredAt: new Date(),
      };
    }

    describeTenantIsolation('OrderItem', {
      context: () => ctx,
      delegate: (db) => db.orderItem,
      create: (db) => db.orderItem.create({ data: itemData() }),
      update: { quantity: 99 },
    });

    describeTenantIsolation('OrderItemModifier', {
      context: () => ctx,
      delegate: (db) => db.orderItemModifier,
      create: async (db) => {
        const line = await db.orderItem.create({ data: itemData() });
        return db.orderItemModifier.create({
          data: {
            organizationId: requireOrganizationId(),
            orderItemId: line.id,
            modifierId: a.setup.modifiers.medium,
            groupName: 'Ponto da carne',
            modifierName: 'Ao ponto',
            priceDeltaCents: 0,
            position: 0,
          },
        });
      },
      update: { modifierName: 'Invadido' },
    });
  });
});
