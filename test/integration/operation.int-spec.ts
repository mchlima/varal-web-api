import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { type AuthContext, requireOrganizationId } from '../../src/context/request-context.js';
import type {
  ItemChangeDto,
  OrderDto,
  OrderItemDto,
  ShiftDto,
  StationQueueDto,
  TabDto,
  TabSummaryDto,
} from '../../src/operation/operation.schemas.js';
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

describe.skipIf(!databaseUrl)('operation: shifts, tabs, orders and items (spec 04)', () => {
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
    method: 'get' | 'post' | 'put',
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

  function openShift(c: Crew, body: object = { type: 'direct_sale' }): Promise<ShiftDto> {
    return ok<ShiftDto>('post', `/units/${c.setup.tenant.unitId}/shifts`, c.owner, body);
  }

  function openTab(c: Crew, shiftId: string, customerName = 'Dona Marta'): Promise<TabDto> {
    return ok<TabDto>('post', `/shifts/${shiftId}/tabs`, c.counter.auth, { customerName });
  }

  function sendOrder(c: Crew, tabId: string, items: object[]): Promise<OrderDto> {
    return ok<OrderDto>('post', `/tabs/${tabId}/orders`, c.counter.auth, { items });
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

  async function auditActions(entityId: string): Promise<string[]> {
    const rows = await platform.auditLog.findMany({
      where: { entityId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => row.action);
  }

  // ----------------------------------------------------------------------------------------------
  // Shifts
  // ----------------------------------------------------------------------------------------------

  describe('shifts (spec 04, section 3)', () => {
    it('CA-04.01: a second shift in the same unit is refused, even when both open at once', async () => {
      const c = await crew('Turno duplo');
      const responses = await Promise.all(
        [0, 1].map(() =>
          http()
            .post(`${API}/units/${c.setup.tenant.unitId}/shifts`)
            .set(as(c.owner))
            .send({ type: 'direct_sale' }),
        ),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const refused = responses.find((response) => response.status === 409);
      expect(refused && errorOf(refused).code).toBe('SHIFT_ALREADY_OPEN');
      const again = await http()
        .post(`${API}/units/${c.setup.tenant.unitId}/shifts`)
        .set(as(c.counter.auth))
        .send({ type: 'direct_sale' })
        .expect(409);
      expect(errorOf(again).code).toBe('SHIFT_ALREADY_OPEN');
      await expect(
        platform.shift.count({ where: { unitId: c.setup.tenant.unitId, status: 'open' } }),
      ).resolves.toBe(1);
    });

    it('RN-04.04/RN-04.05: a contracted shift needs the agreement; direct sale has none', async () => {
      const c = await crew('Contratado');
      const missing = await http()
        .post(`${API}/units/${c.setup.tenant.unitId}/shifts`)
        .set(as(c.owner))
        .send({ type: 'contracted' })
        .expect(400);
      expect(errorOf(missing).code).toBe('VALIDATION_FAILED');
      const extra = await http()
        .post(`${API}/units/${c.setup.tenant.unitId}/shifts`)
        .set(as(c.owner))
        .send({
          type: 'direct_sale',
          agreement: { contractorName: 'Buffet', modality: 'fixed_fee' },
        })
        .expect(400);
      expect(errorOf(extra).code).toBe('VALIDATION_FAILED');

      const shift = await openShift(c, {
        type: 'contracted',
        agreement: {
          contractorName: 'Festa da Firma',
          modality: 'consumption_billed',
          agreedAmountCents: 150000,
          agreedQuantity: 500,
          limits: 'das 18h às 23h',
          notes: 'Pendurar no fim',
        },
        prices: [{ productId: c.setup.products.skewer, priceCents: 1000 }],
      });
      expect(shift).toMatchObject({
        type: 'contracted',
        status: 'open',
        openedBy: { type: 'owner', id: c.owner.actor.id },
        agreement: {
          contractorName: 'Festa da Firma',
          modality: 'consumption_billed',
          agreedAmountCents: 150000,
          agreedQuantity: 500,
          limits: 'das 18h às 23h',
          notes: 'Pendurar no fim',
        },
        prices: [{ productId: c.setup.products.skewer, priceCents: 1000 }],
      });
      const current = await ok<{ shift: ShiftDto | null }>(
        'get',
        `/units/${c.setup.tenant.unitId}/shifts/current`,
        c.kitchen.auth,
      );
      expect(current.shift).toEqual(shift);
      expect(await auditActions(shift.id)).toEqual(['shift.opened']);
    });

    it('RN-04.02: staff without cash cannot open or close; RN-04.03: inactive unit; CA-02.05: suspended', async () => {
      const c = await crew('Permissões turno');
      const refused = await http()
        .post(`${API}/units/${c.setup.tenant.unitId}/shifts`)
        .set(as(c.kitchen.auth))
        .send({ type: 'direct_sale' })
        .expect(403);
      expect(errorOf(refused).code).toBe('FORBIDDEN');

      await platform.organization.update({
        where: { id: c.setup.tenant.organizationId },
        data: { subscriptionStatus: 'suspended' },
      });
      const suspended = await http()
        .post(`${API}/units/${c.setup.tenant.unitId}/shifts`)
        .set(as(c.owner))
        .send({ type: 'direct_sale' })
        .expect(409);
      expect(errorOf(suspended).code).toBe('ORGANIZATION_SUSPENDED');
      await platform.organization.update({
        where: { id: c.setup.tenant.organizationId },
        data: { subscriptionStatus: 'canceled' },
      });
      const canceled = await http()
        .post(`${API}/units/${c.setup.tenant.unitId}/shifts`)
        .set(as(c.owner))
        .send({ type: 'direct_sale' })
        .expect(409);
      expect(errorOf(canceled).code).toBe('ORGANIZATION_CANCELED');
      await platform.organization.update({
        where: { id: c.setup.tenant.organizationId },
        data: { subscriptionStatus: 'active' },
      });

      await platform.unit.update({ where: { id: c.setup.tenant.unitId }, data: { active: false } });
      const inactive = await http()
        .post(`${API}/units/${c.setup.tenant.unitId}/shifts`)
        .set(as(c.owner))
        .send({ type: 'direct_sale' })
        .expect(409);
      expect(errorOf(inactive).code).toBe('UNIT_INACTIVE');
      await platform.unit.update({ where: { id: c.setup.tenant.unitId }, data: { active: true } });

      // The staff member who operates cash opens; RN-01.01: a suspended organization still closes.
      const shift = await ok<ShiftDto>(
        'post',
        `/units/${c.setup.tenant.unitId}/shifts`,
        c.counter.auth,
        { type: 'direct_sale' },
      );
      expect(shift.openedBy).toEqual({ type: 'staff', id: c.counter.id });
      const closeAsKitchen = await http()
        .post(`${API}/shifts/${shift.id}/close`)
        .set(as(c.kitchen.auth))
        .expect(403);
      expect(errorOf(closeAsKitchen).code).toBe('FORBIDDEN');
      await platform.organization.update({
        where: { id: c.setup.tenant.organizationId },
        data: { subscriptionStatus: 'suspended' },
      });
      const closed = await ok<ShiftDto>(
        'post',
        `/shifts/${shift.id}/close`,
        c.counter.auth,
        undefined,
        200,
      );
      expect(closed).toMatchObject({
        status: 'closed',
        closedBy: { type: 'staff', id: c.counter.id },
      });
    });

    it('RN-04.06: prices of the shift are validated and replaced while it is open', async () => {
      const c = await crew('Preços');
      const other = await createTenant(platform, 'Preços outra');
      const foreign = await setupOperation(platform, other);
      const shift = await openShift(c);
      const invalid = await http()
        .put(`${API}/shifts/${shift.id}/prices`)
        .set(as(c.owner))
        .send({ prices: [{ productId: foreign.products.skewer, priceCents: 1 }] })
        .expect(400);
      expect(errorOf(invalid)).toMatchObject({
        code: 'INVALID_SHIFT_PRICE',
        details: { productIds: [foreign.products.skewer] },
      });
      const updated = await ok<ShiftDto>('put', `/shifts/${shift.id}/prices`, c.owner, {
        prices: [{ productId: c.setup.products.pastry, priceCents: 700 }],
        version: shift.version,
      });
      expect(updated.prices).toEqual([{ productId: c.setup.products.pastry, priceCents: 700 }]);
      expect(updated.version).toBe(shift.version + 1);
      const stale = await http()
        .put(`${API}/shifts/${shift.id}/prices`)
        .set(as(c.owner))
        .send({ prices: [], version: shift.version })
        .expect(409);
      expect(errorOf(stale).code).toBe('VERSION_CONFLICT');
    });

    it('CA-04.07: the shift price is used in its items; the next shift goes back to the menu price', async () => {
      const c = await crew('Preço do turno');
      const shift = await openShift(c, {
        type: 'direct_sale',
        prices: [{ productId: c.setup.products.skewer, priceCents: 1000 }],
      });
      const tab = await openTab(c, shift.id);
      const order = await sendOrder(c, tab.id, [
        skewer(c, 2, [c.setup.modifiers.garlicBread]),
        { productId: c.setup.products.pastry, quantity: 1 },
      ]);
      expect(order.items.map((item) => item.unitPriceCents)).toEqual([1000, 800]);
      // (1000 + 300) × 2 + 800
      expect(order.items.map((item) => item.totalCents)).toEqual([2600, 800]);
      const after = await ok<TabDto>('get', `/tabs/${tab.id}`, c.counter.auth);
      expect(after).toMatchObject({ subtotalCents: 3400, totalCents: 3400, itemCount: 3 });

      for (const item of order.items) {
        await ok(
          'post',
          `/order-items/${item.id}/cancel`,
          c.counter.auth,
          { version: item.version, reason: 'Teste' },
          200,
        );
      }
      await ok('post', `/tabs/${tab.id}/cancel`, c.counter.auth, {}, 200);
      await ok('post', `/shifts/${shift.id}/close`, c.owner, undefined, 200);

      const next = await openShift(c);
      const nextTab = await openTab(c, next.id);
      expect(nextTab.number).toBe(1);
      const nextOrder = await sendOrder(c, nextTab.id, [skewer(c)]);
      expect(firstItem(nextOrder).unitPriceCents).toBe(1200);
    });
  });

  // ----------------------------------------------------------------------------------------------
  // Tabs
  // ----------------------------------------------------------------------------------------------

  describe('tabs (spec 04, section 4)', () => {
    it('CA-04.02: numbers 1, 2, 3… without repeating, with counters creating at the same time', async () => {
      const c = await crew('Numeração');
      const shift = await openShift(c);
      const created = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          http()
            .post(`${API}/shifts/${shift.id}/tabs`)
            .set(as(index % 2 === 0 ? c.counter.auth : c.owner))
            .send({ customerName: `Cliente ${index}` }),
        ),
      );
      expect(created.every((response) => response.status === 201)).toBe(true);
      const numbers = created
        .map((response) => (response.body as TabDto).number)
        .sort((a, b) => a - b);
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      const list = await ok<{ data: TabSummaryDto[] }>(
        'get',
        `/shifts/${shift.id}/tabs`,
        c.kitchen.auth,
      );
      expect(list.data.map((tab) => tab.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('RN-04.10: customer name from 1 to 40 characters; only the counter opens tabs', async () => {
      const c = await crew('Nome');
      const shift = await openShift(c);
      for (const customerName of ['', '   ', 'x'.repeat(41)]) {
        const response = await http()
          .post(`${API}/shifts/${shift.id}/tabs`)
          .set(as(c.counter.auth))
          .send({ customerName })
          .expect(400);
        expect(errorOf(response).code).toBe('VALIDATION_FAILED');
      }
      const kitchen = await http()
        .post(`${API}/shifts/${shift.id}/tabs`)
        .set(as(c.kitchen.auth))
        .send({ customerName: 'Seu João' })
        .expect(403);
      expect(errorOf(kitchen).code).toBe('FORBIDDEN');
      const tab = await openTab(c, shift.id, '  Seu João  ');
      expect(tab).toMatchObject({
        number: 1,
        customerName: 'Seu João',
        mode: 'open_tab',
        status: 'open',
        subtotalCents: 0,
        totalCents: 0,
        orders: [],
      });
      expect(await auditActions(tab.id)).toEqual(['tab.opened']);
    });

    it('RN-04.12/RN-04.13: request the bill, refuse orders while closing, reopen, cancel', async () => {
      const c = await crew('Transições');
      const shift = await openShift(c);
      const tab = await openTab(c, shift.id);
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

      // Cancel only when every item is canceled (RN-04.12).
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
      expect(canceled).toMatchObject({ status: 'canceled', totalCents: 0 });
      expect(canceled.closedAt).not.toBeNull();
      // RN-04.28: nothing changes in a canceled tab.
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

    it('CA-04.09: closing the shift with open tabs is refused with the pending list; RN-04.08: closed shift is frozen', async () => {
      const c = await crew('Fechar turno');
      const shift = await openShift(c);
      const marta = await openTab(c, shift.id, 'Dona Marta');
      const joao = await openTab(c, shift.id, 'Seu João');
      await ok('post', `/tabs/${joao.id}/request-bill`, c.counter.auth, {}, 200);

      const refused = await http()
        .post(`${API}/shifts/${shift.id}/close`)
        .set(as(c.owner))
        .expect(409);
      expect(errorOf(refused)).toMatchObject({
        code: 'SHIFT_HAS_PENDING_ITEMS',
        details: {
          tabs: [
            { id: marta.id, number: 1, customerName: 'Dona Marta', status: 'open' },
            { id: joao.id, number: 2, customerName: 'Seu João', status: 'closing' },
          ],
          cashRegisters: [],
        },
      });

      await ok('post', `/tabs/${marta.id}/cancel`, c.counter.auth, {}, 200);
      await ok('post', `/tabs/${joao.id}/cancel`, c.counter.auth, {}, 200);
      const closed = await ok<ShiftDto>(
        'post',
        `/shifts/${shift.id}/close`,
        c.owner,
        undefined,
        200,
      );
      expect(closed.status).toBe('closed');
      expect(await auditActions(shift.id)).toEqual(['shift.opened', 'shift.closed']);

      const newTab = await http()
        .post(`${API}/shifts/${shift.id}/tabs`)
        .set(as(c.counter.auth))
        .send({ customerName: 'Tarde demais' })
        .expect(409);
      expect(errorOf(newTab).code).toBe('SHIFT_CLOSED');
      const closeAgain = await http()
        .post(`${API}/shifts/${shift.id}/close`)
        .set(as(c.owner))
        .expect(409);
      expect(errorOf(closeAgain).code).toBe('SHIFT_CLOSED');
      await expect(
        ok<{ shift: ShiftDto | null }>(
          'get',
          `/units/${c.setup.tenant.unitId}/shifts/current`,
          c.owner,
        ),
      ).resolves.toEqual({ shift: null });
    });

    it('RN-04.08: items still in progress when the shift closes go to the final stage, audited', async () => {
      const c = await crew('Itens no fechamento');
      const shift = await openShift(c);
      const tab = await openTab(c, shift.id);
      const order = await sendOrder(c, tab.id, [skewer(c, 2)]);
      // A tab already paid (spec 05) with an item still in the kitchen.
      await platform.tab.update({ where: { id: tab.id }, data: { status: 'paid' } });
      await ok('post', `/shifts/${shift.id}/close`, c.owner, undefined, 200);
      const item = await platform.orderItem.findUniqueOrThrow({
        where: { id: firstItem(order).id },
      });
      expect(item).toMatchObject({ stageId: c.setup.stages.delivered, stationId: null });
      await expect(
        platform.order.findUniqueOrThrow({ where: { id: order.id } }),
      ).resolves.toMatchObject({ status: 'completed' });
      expect(await auditActions(shift.id)).toEqual([
        'shift.opened',
        'shift.items_finalized',
        'shift.closed',
      ]);
      const queue = await ok<StationQueueDto>(
        'get',
        `/stations/${c.setup.stations.kitchen}/queue`,
        c.kitchen.auth,
      );
      expect(queue.items).toEqual([]);
    });
  });

  // ----------------------------------------------------------------------------------------------
  // Orders
  // ----------------------------------------------------------------------------------------------

  describe('orders (spec 04, section 5)', () => {
    it('RN-04.18/RN-04.19: each item copies what was sold and enters the first stage at its station', async () => {
      const c = await crew('Pedido');
      const shift = await openShift(c);
      const tab = await openTab(c, shift.id);
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
      const shift = await openShift(c);
      const tab = await openTab(c, shift.id);
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
      const shift = await openShift(c);
      const tab = await openTab(c, shift.id);
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

    it('CA-01.06: an order sent again with the same Idempotency-Key is not duplicated', async () => {
      const c = await crew('Idempotência');
      const shift = await openShift(c);
      const tab = await openTab(c, shift.id);
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

      // Stage changes too: the replay does not advance twice.
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

      // Opening a tab with the same key twice opens one tab.
      const tabKey = crypto.randomUUID();
      for (let attempt = 0; attempt < 2; attempt++) {
        await http()
          .post(`${API}/shifts/${shift.id}/tabs`)
          .set(as(c.counter.auth))
          .set('Idempotency-Key', tabKey)
          .send({ customerName: 'Só uma' })
          .expect(201);
      }
      await expect(
        platform.tab.count({ where: { shiftId: shift.id, customerName: 'Só uma' } }),
      ).resolves.toBe(1);
    });
  });

  // ----------------------------------------------------------------------------------------------
  // Stages and items
  // ----------------------------------------------------------------------------------------------

  describe('stages (spec 04, section 5.1)', () => {
    it('RN-04.20/RN-04.21: each station advances its items; the counter registers the delivery', async () => {
      const c = await crew('Etapas');
      const shift = await openShift(c);
      const tab = await openTab(c, shift.id);
      const order = await sendOrder(c, tab.id, [skewer(c)]);
      let item = firstItem(order);

      // The counter does not advance items still in the kitchen; the fryer neither.
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
      // Now in the delivery counter: the kitchen no longer advances it.
      await http()
        .post(`${API}/order-items/${item.id}/advance`)
        .set(as(c.kitchen.auth))
        .send({ version: item.version })
        .expect(403);
      const summary = await ok<{ data: TabSummaryDto[] }>(
        'get',
        `/shifts/${shift.id}/tabs`,
        c.counter.auth,
      );
      expect(summary.data[0]?.readyItemCount).toBe(1);

      const delivered = await advance(c.counter.auth, item);
      expect(delivered.changed).toMatchObject({
        stageName: 'Entregue',
        stageIsFinal: true,
        stationId: null,
        lateAt: null,
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
      const shift = await openShift(c);
      const tab = await openTab(c, shift.id);
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

      // RN-04.22 per line: the new line goes back on its own.
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
      const shift = await openShift(c);
      const tab = await openTab(c, shift.id);
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
      const shift = await openShift(c);
      const tab = await openTab(c, shift.id);
      const item = firstItem(await sendOrder(c, tab.id, [skewer(c)]));
      const first = await http()
        .post(`${API}/order-items/${item.id}/back`)
        .set(as(c.kitchen.auth))
        .send({ version: item.version })
        .expect(409);
      expect(errorOf(first).code).toBe('NO_PREVIOUS_STAGE');

      const ready = (await advance(c.kitchen.auth, (await advance(c.kitchen.auth, item)).changed))
        .changed;
      // The kitchen undoes its own advance (the item went to the delivery counter).
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

    it('CA-04.11/RN-04.23: an item is late after late_after_minutes since the order without reaching the final stage', async () => {
      const c = await crew('Atraso');
      await platform.unit.update({
        where: { id: c.setup.tenant.unitId },
        data: { lateAfterMinutes: 10 },
      });
      const shift = await openShift(c);
      const tab = await openTab(c, shift.id);
      const order = await sendOrder(c, tab.id, [
        skewer(c, 2),
        { productId: c.setup.products.pastry, quantity: 1 },
      ]);
      const fresh = await ok<StationQueueDto>(
        'get',
        `/stations/${c.setup.stations.kitchen}/queue`,
        c.kitchen.auth,
      );
      expect(fresh.items[0]).toMatchObject({ isLate: false });
      expect(Date.parse(fresh.items[0]?.lateAt ?? '') - Date.parse(order.sentAt)).toBe(10 * 60_000);

      await platform.order.update({
        where: { id: order.id },
        data: { sentAt: new Date(Date.now() - 11 * 60_000) },
      });
      const late = await ok<StationQueueDto>(
        'get',
        `/stations/${c.setup.stations.kitchen}/queue`,
        c.kitchen.auth,
      );
      expect(late).toMatchObject({ lateAfterMinutes: 10, items: [{ isLate: true }] });
      const list = await ok<{ data: TabSummaryDto[] }>(
        'get',
        `/shifts/${shift.id}/tabs`,
        c.counter.auth,
      );
      expect(list.data[0]?.lateItemCount).toBe(3);

      // Delivered items are not late any more.
      const pastry = firstItem(order, 1);
      const ready = (await advance(c.fryer.auth, (await advance(c.fryer.auth, pastry)).changed))
        .changed;
      const delivered = await advance(c.counter.auth, ready);
      expect(delivered.changed).toMatchObject({ isLate: false, lateAt: null });
    });
  });

  describe('cancellation (spec 04, section 5.2)', () => {
    it('CA-04.08: canceling 1 of 3 skewers in preparation makes a canceled line of 1 (waste) and an active line of 2', async () => {
      const c = await crew('Cancelar');
      const shift = await openShift(c);
      const tab = await openTab(c, shift.id);
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
        stationId: null,
        splitFromId: preparing.id,
      });
      expect(result.changed.canceledAt).not.toBeNull();
      expect(result.remaining).toMatchObject({
        id: preparing.id,
        quantity: 2,
        canceledAt: null,
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
      const shift = await openShift(c);
      const tab = await openTab(c, shift.id);
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
      // The whole order is now final or canceled once the soda is delivered.
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

      // RN-04.28: a paid tab refuses cancellations (spec 05: reverse the payment first).
      const other = firstItem(await sendOrder(c, tab.id, [skewer(c)]));
      await platform.tab.update({ where: { id: tab.id }, data: { status: 'paid' } });
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

  describe('station queue', () => {
    it('lists the items at the station, oldest order first, only for who has the station', async () => {
      const c = await crew('Fila');
      const shift = await openShift(c);
      const first = await openTab(c, shift.id, 'Primeiro');
      const second = await openTab(c, shift.id, 'Segundo');
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

      const queue = await ok<StationQueueDto>(
        'get',
        `/stations/${c.setup.stations.kitchen}/queue`,
        c.kitchen.auth,
      );
      expect(queue.items.map((item) => [item.customerName, item.orderId, item.quantity])).toEqual([
        ['Segundo', b.id, 1],
        ['Primeiro', a.id, 1],
        ['Primeiro', a.id, 2],
      ]);
      expect(queue.stages.map((stage) => stage.name)).toEqual([
        'Recebido',
        'Preparando',
        'Pronto',
        'Entregue',
      ]);
      const fryerQueue = await ok<StationQueueDto>(
        'get',
        `/stations/${c.setup.stations.fryer}/queue`,
        c.owner,
      );
      expect(fryerQueue.items.map((item) => item.productName)).toEqual(['Pastel']);
      const refused = await http()
        .get(`${API}/stations/${c.setup.stations.kitchen}/queue`)
        .set(as(c.fryer.auth))
        .expect(403);
      expect(errorOf(refused).code).toBe('FORBIDDEN');
    });
  });

  describe('"entrar como" and staff of another unit', () => {
    it('RN-02.20: actions in "entrar como" are the owner\'s, with the admin in the audit', async () => {
      const c = await crew('Entrar como');
      const admin = await platform.platformAdmin.create({
        data: { name: 'Suporte', email: `suporte.${crypto.randomUUID().slice(0, 8)}@teste.local` },
      });
      const impersonated: AuthContext = { ...c.owner, impersonatorId: admin.id };
      const shift = await ok<ShiftDto>(
        'post',
        `/units/${c.setup.tenant.unitId}/shifts`,
        impersonated,
        {
          type: 'direct_sale',
        },
      );
      const audit = await platform.auditLog.findFirstOrThrow({ where: { entityId: shift.id } });
      expect(audit).toMatchObject({
        actorType: 'owner',
        actorId: c.owner.actor.id,
        impersonatorId: admin.id,
      });
    });

    it('staff without the unit get 403 everywhere in it', async () => {
      const c = await crew('Sem unidade');
      const shift = await openShift(c);
      const tab = await openTab(c, shift.id);
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
        () => http().get(`${API}/units/${c.setup.tenant.unitId}/shifts/current`),
        () => http().get(`${API}/shifts/${shift.id}/tabs`),
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
    let shift: ShiftDto;
    let tab: TabDto;
    let order: OrderDto;
    let ctx: IsolationContext;

    beforeAll(async () => {
      a = await crew('Isolamento A');
      b = await crew('Isolamento B');
      shift = await openShift(a, {
        type: 'contracted',
        agreement: { contractorName: 'Contratante', modality: 'other' },
        prices: [{ productId: a.setup.products.soda, priceCents: 500 }],
      });
      tab = await openTab(a, shift.id);
      order = await sendOrder(a, tab.id, [skewer(a)]);
      ctx = { prisma: app.get(PrismaService), tenantA: a.setup.tenant, tenantB: b.setup.tenant };
    });

    it('every route answers 404 to another organization', async () => {
      const item = firstItem(order);
      const routes: { method: 'get' | 'post' | 'put'; path: string; body?: object }[] = [
        {
          method: 'post',
          path: `/units/${a.setup.tenant.unitId}/shifts`,
          body: { type: 'direct_sale' },
        },
        { method: 'get', path: `/units/${a.setup.tenant.unitId}/shifts/current` },
        { method: 'put', path: `/shifts/${shift.id}/prices`, body: { prices: [] } },
        { method: 'post', path: `/shifts/${shift.id}/close` },
        { method: 'get', path: `/shifts/${shift.id}/tabs` },
        { method: 'post', path: `/shifts/${shift.id}/tabs`, body: { customerName: 'Invasor' } },
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
      await expect(platform.tab.count({ where: { shiftId: shift.id } })).resolves.toBe(1);
      await expect(
        platform.orderItem.findUniqueOrThrow({ where: { id: item.id } }),
      ).resolves.toMatchObject({ version: 0, canceledAt: null });
    });

    describeTenantIsolation('Shift', {
      context: () => ctx,
      delegate: (db) => db.shift,
      create: (db, tenant) =>
        db.shift.create({
          data: {
            organizationId: requireOrganizationId(),
            unitId: tenant.unitId,
            type: 'direct_sale',
            status: 'closed',
            openedByType: 'owner',
            openedById: tenant.ownerId,
            openedAt: new Date(),
            closedAt: new Date(),
          },
        }),
      update: { nextTabNumber: 99 },
    });

    describeTenantIsolation('ShiftAgreement', {
      context: () => ctx,
      delegate: (db) => db.shiftAgreement,
      create: async (db, tenant) => {
        const closed = await db.shift.create({
          data: {
            organizationId: requireOrganizationId(),
            unitId: tenant.unitId,
            type: 'contracted',
            status: 'closed',
            openedByType: 'owner',
            openedAt: new Date(),
            closedAt: new Date(),
          },
        });
        return db.shiftAgreement.create({
          data: {
            organizationId: requireOrganizationId(),
            shiftId: closed.id,
            contractorName: 'Contratante',
            modality: 'fixed_fee',
          },
        });
      },
      update: { contractorName: 'Invadido' },
    });

    describeTenantIsolation('ShiftPrice', {
      context: () => ctx,
      delegate: (db) => db.shiftPrice,
      create: async (db) => {
        // One price per product and shift: a new product each time.
        const product = await db.product.create({
          data: {
            organizationId: requireOrganizationId(),
            unitId: a.setup.tenant.unitId,
            categoryId: (
              await db.product.findUniqueOrThrow({ where: { id: a.setup.products.pastry } })
            ).categoryId,
            name: `Isolado ${crypto.randomUUID().slice(0, 8)}`,
            priceCents: 100,
            sortOrder: 99,
          },
        });
        return db.shiftPrice.create({
          data: {
            organizationId: requireOrganizationId(),
            shiftId: shift.id,
            productId: product.id,
            priceCents: 100,
          },
        });
      },
      update: { priceCents: 1 },
    });

    function tabData(tenant: Tenant, number: number) {
      return {
        organizationId: requireOrganizationId(),
        shiftId: shift.id,
        unitId: tenant.unitId,
        number,
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
            shiftId: shift.id,
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
