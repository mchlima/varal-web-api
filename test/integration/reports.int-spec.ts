import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { AuthContext } from '../../src/context/request-context.js';
import type { PriceListDto } from '../../src/menu/menu.schemas.js';
import type {
  CashRegisterDto,
  CashRegisterSessionDetailDto,
} from '../../src/operation/cash.schemas.js';
import type { CustomerDto } from '../../src/operation/credit.schemas.js';
import type { ContractedEventDto } from '../../src/operation/events.schemas.js';
import type { TabDto } from '../../src/operation/operation.schemas.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import type {
  DayHistoryDto,
  EventHistoryDto,
  EventReportDto,
  SessionHistoryDto,
  SessionReportDto,
  SummaryReportDto,
} from '../../src/reports/reports.schemas.js';
import { resolveHistoryPeriod } from '../../src/reports/reports.service.js';
import { errorOf } from '../support/http.js';
import { createTenant, expectNotFoundForOtherTenant } from '../support/isolation-kit.js';
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
  unitId: string;
  owner: AuthContext;
  /** Balcão + Balcão de entrega, operates cash. */
  cashier: TestStaff;
  /** Balcão only. */
  counter: TestStaff;
  /** "Feira": the current price list, skewer and soda at R$ 10,00 (spec 03, section 5.3). */
  priceList: PriceListDto;
}

const COUNTS = (informed: Record<string, number>) => ({
  counts: ['cash', 'pix', 'credit_card', 'debit_card'].map((method) => ({
    method,
    informedCents: informed[method] ?? 0,
  })),
});

/** Today's day of operation (São Paulo) and the days before it. */
const today = () => resolveHistoryPeriod({}).to;
const daysAgo = (days: number) => today().subtract({ days }).toString();
const dateColumn = (day: string) => new Date(`${day}T00:00:00.000Z`);

describe.skipIf(!databaseUrl)('relatórios (spec 07)', () => {
  let app: NestExpressApplication;
  let platform: PlatformPrismaService;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({ databaseUrl: databaseUrl ?? '' });
    platform = app.get(PlatformPrismaService);
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

  async function ok<T>(
    method: Method,
    path: string,
    auth: AuthContext,
    body?: object,
    status = method === 'post' ? 201 : 200,
  ): Promise<T> {
    let call = http()[method](`${API}${path}`).set(authHeaders(auth));
    if (body !== undefined) {
      call = call.send(body);
    }
    const response = await call;
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return response.body as T;
  }

  /** A unit with "Caixa 1" and the current list "Feira" (skewer and soda at R$ 10,00). */
  async function crew(label: string): Promise<Crew> {
    const tenant = await createTenant(platform, label);
    const setup = await setupOperation(platform, tenant);
    const { stations } = setup;
    const owner = tenant.ownerAuth;
    const priceList = await ok<PriceListDto>('post', `/units/${tenant.unitId}/price-lists`, owner, {
      name: 'Feira',
    });
    await ok('put', `/price-lists/${priceList.id}/prices`, owner, {
      prices: [
        { productId: setup.products.skewer, priceCents: 1000 },
        { productId: setup.products.soda, priceCents: 1000 },
      ],
    });
    await ok('put', `/units/${tenant.unitId}/current-price-list`, owner, {
      priceListId: priceList.id,
    });
    return {
      setup,
      unitId: tenant.unitId,
      owner,
      priceList,
      cashier: await createStaff(platform, tenant, [stations.counter, stations.delivery], {
        canOperateCash: true,
      }),
      counter: await createStaff(platform, tenant, [stations.counter]),
    };
  }

  function sodas(c: Crew, quantity: number): object {
    return { productId: c.setup.products.soda, quantity };
  }

  /** Opens a register (default "Caixa 1") and returns the id of its session. */
  async function openRegister(c: Crew, registerId = c.setup.register): Promise<string> {
    const register = await ok<CashRegisterDto>(
      'post',
      `/cash-registers/${registerId}/open`,
      c.cashier.auth,
      { openingFloatCents: 0 },
    );
    const sessionId = register.session?.id;
    if (!sessionId) {
      throw new Error('session not found');
    }
    return sessionId;
  }

  async function tabWith(c: Crew, items: object[], customerName = 'Dona Marta') {
    const tab = await ok<TabDto>('post', `/units/${c.unitId}/tabs`, c.counter.auth, {
      customerName,
    });
    await ok('post', `/tabs/${tab.id}/orders`, c.counter.auth, { items });
    return ok<TabDto>('get', `/tabs/${tab.id}`, c.counter.auth);
  }

  function requestBill(c: Crew, tabId: string) {
    return ok<TabDto>('post', `/tabs/${tabId}/request-bill`, c.counter.auth, {}, 200);
  }

  function pay(c: Crew, tabId: string, body: object) {
    return ok('post', `/tabs/${tabId}/payments`, c.counter.auth, body);
  }

  async function putOnCredit(c: Crew, tabId: string, name = 'Seu Zé') {
    const customer = await ok<CustomerDto>('post', `/units/${c.unitId}/customers`, c.counter.auth, {
      name,
    });
    await ok(
      'post',
      `/tabs/${tabId}/put-on-credit`,
      c.counter.auth,
      { customerId: customer.id },
      200,
    );
    return customer;
  }

  /** Closes a session with the expected values plus `extra` per method (with a note if any). */
  async function closeSession(c: Crew, sessionId: string, extra: Record<string, number> = {}) {
    const current = await ok<CashRegisterSessionDetailDto>(
      'get',
      `/cash-register-sessions/${sessionId}`,
      c.cashier.auth,
    );
    const informed = Object.fromEntries(
      current.expected.map((row) => [row.method, row.expectedCents + (extra[row.method] ?? 0)]),
    );
    const differs = Object.values(extra).some((value) => value !== 0);
    await ok(
      'post',
      `/cash-register-sessions/${sessionId}/close`,
      c.cashier.auth,
      { ...COUNTS(informed), ...(differs ? { note: 'Sobrou troco' } : {}) },
      200,
    );
  }

  /**
   * Moves what the unit did "today" to `day` (São Paulo): the day of operation of the unit, of the
   * sessions, tabs and canceled items. Simulates days of operation in the past (RN-04.29, RN-04.30).
   */
  async function moveToDay(c: Crew, day: string): Promise<void> {
    const from = dateColumn(today().toString());
    const to = dateColumn(day);
    await platform.unit.update({ where: { id: c.unitId }, data: { businessDate: to } });
    await platform.cashRegisterSession.updateMany({
      where: { unitId: c.unitId, businessDate: from },
      data: { businessDate: to },
    });
    await platform.tab.updateMany({
      where: { unitId: c.unitId, businessDate: from },
      data: { businessDate: to },
    });
    await platform.tab.updateMany({
      where: { unitId: c.unitId, closedBusinessDate: from },
      data: { closedBusinessDate: to },
    });
    await platform.orderItem.updateMany({
      where: { unitId: c.unitId, canceledBusinessDate: from },
      data: { canceledBusinessDate: to },
    });
  }

  function summary(auth: AuthContext, query: Record<string, string>) {
    return ok<SummaryReportDto>(
      'get',
      `/reports/summary?${new URLSearchParams(query).toString()}`,
      auth,
    );
  }

  function dayOf(c: Crew, day = today().toString()) {
    return summary(c.owner, { unitId: c.unitId, from: day, to: day });
  }

  function sessionReport(c: Crew, sessionId: string) {
    return ok<SessionReportDto>('get', `/cash-register-sessions/${sessionId}/report`, c.owner);
  }

  function history<T>(path: string, auth: AuthContext, query: Record<string, string>) {
    return ok<T>('get', `${path}?${new URLSearchParams(query).toString()}`, auth);
  }

  /**
   * CA-07.01: a tab paid R$ 80,00, one on credit of R$ 100,00 and one canceled, today. Returns the
   * crew with "Caixa 1" still open.
   */
  async function threeTabs(label: string) {
    const c = await crew(label);
    const sessionId = await openRegister(c);
    const paid = await tabWith(c, [sodas(c, 8)], 'Paga');
    await requestBill(c, paid.id);
    await pay(c, paid.id, { method: 'pix', amountCents: 8000 });
    const hung = await tabWith(c, [sodas(c, 10)], 'Pendura');
    await requestBill(c, hung.id);
    const customer = await putOnCredit(c, hung.id);
    const canceled = await tabWith(c, [sodas(c, 1)], 'Desistiu');
    const item = canceled.orders[0]?.items[0];
    if (!item) {
      throw new Error('item not found');
    }
    await ok(
      'post',
      `/order-items/${item.id}/cancel`,
      c.counter.auth,
      { version: item.version, reason: 'Cliente desistiu' },
      200,
    );
    await ok('post', `/tabs/${canceled.id}/cancel`, c.counter.auth, {}, 200);
    return { c, sessionId, paid, hung, canceled, customer };
  }

  it('CA-07.01, RN-07.01 to RN-07.03, RN-07.06: sale R$ 180,00, received R$ 80,00, on credit R$ 100,00; partial while open', async () => {
    const { c, sessionId, hung, canceled, customer } = await threeTabs('Relatório 07.01');
    const open = await dayOf(c);
    expect(open.partial).toBe(true);
    expect(open.unit).toEqual({ id: c.unitId, name: expect.any(String) as string });
    expect(open.summary).toMatchObject({
      salesCents: 18_000,
      receivedCents: 8000,
      receivedSalesCents: 8000,
      receivedSettlementsCents: 0,
      onCreditCents: 10_000,
      tabCount: 2,
      canceledTabCount: 1,
      averageTicketCents: 9000,
      discountsCents: 0,
      wasteCents: 0,
    });
    expect(open.openTabsNow).toEqual({ count: 0, totalCents: 0 });
    // Sold with the "Feira" list: the breakdown per list shows (spec 07, section 4).
    expect(open.products).toEqual([
      {
        productId: c.setup.products.soda,
        productName: 'Refrigerante',
        quantity: 18,
        valueCents: 18_000,
        modifiers: [],
        priceLists: [
          { priceListId: c.priceList.id, priceListName: 'Feira', quantity: 18, valueCents: 18_000 },
        ],
      },
    ]);
    expect(open.paymentMethods).toEqual([
      { method: 'cash', salesCents: 0, settlementsCents: 0, totalCents: 0 },
      { method: 'pix', salesCents: 8000, settlementsCents: 0, totalCents: 8000 },
      { method: 'credit_card', salesCents: 0, settlementsCents: 0, totalCents: 0 },
      { method: 'debit_card', salesCents: 0, settlementsCents: 0, totalCents: 0 },
    ]);
    expect(open.credit.tabs).toEqual([
      expect.objectContaining({
        tabId: hung.id,
        amountCents: 10_000,
        balanceCents: 10_000,
        status: 'on_credit',
        customer: expect.objectContaining({ id: customer.id, name: 'Seu Zé' }) as unknown,
      }),
    ]);
    expect(open.cancellations.tabs).toEqual([
      expect.objectContaining({
        tabId: canceled.id,
        canceledBy: expect.objectContaining({ type: 'staff', id: c.counter.id }) as unknown,
      }),
    ]);
    expect(open.cancellations.items).toEqual([
      expect.objectContaining({ quantity: 1, valueCents: 1000, wasted: false }),
    ]);
    expect(open.cashSessions).toEqual([
      expect.objectContaining({
        sessionId,
        name: 'Caixa 1',
        status: 'open',
        receivedCents: 8000,
        responsible: expect.objectContaining({ type: 'staff', id: c.cashier.id }) as unknown,
      }),
    ]);
    expect(open.events).toEqual([]);
    const counter = open.staff.find((row) => row.actor.id === c.counter.id);
    expect(counter).toMatchObject({
      actor: { type: 'staff', name: expect.stringMatching(/^Colaborador/) as unknown },
      tabsOpened: 3,
      ordersSent: 3,
      receivedCents: 8000,
      itemsCanceled: 1,
      tabsCanceled: 1,
    });

    await closeSession(c, sessionId);
    const closed = await dayOf(c);
    expect(closed.partial).toBe(false);
    expect(closed.openTabsNow).toBeNull();
    expect(closed.summary).toMatchObject({
      salesCents: 18_000,
      receivedCents: 8000,
      onCreditCents: 10_000,
    });
  });

  it('CA-07.02, RN-07.02: a settlement received today of a tab of yesterday is received as settlement, not a sale', async () => {
    const { c, sessionId, hung } = await threeTabs('Relatório 07.02');
    await closeSession(c, sessionId);
    const yesterdayDay = daysAgo(1);
    await moveToDay(c, yesterdayDay);

    const todaySession = await openRegister(c);
    const sale = await tabWith(c, [sodas(c, 3)]);
    await requestBill(c, sale.id);
    await pay(c, sale.id, { method: 'cash', tenderedCents: 3000 });
    await pay(c, hung.id, { method: 'pix', amountCents: 4000 });

    const now = await dayOf(c);
    expect(now.summary).toMatchObject({
      salesCents: 3000,
      receivedCents: 7000,
      receivedSalesCents: 3000,
      receivedSettlementsCents: 4000,
      onCreditCents: 0,
    });
    expect(now.paymentMethods.find((row) => row.method === 'pix')).toEqual({
      method: 'pix',
      salesCents: 0,
      settlementsCents: 4000,
      totalCents: 4000,
    });
    expect(now.credit.settlements).toEqual([
      expect.objectContaining({ tabId: hung.id, tabBusinessDate: yesterdayDay, amountCents: 4000 }),
    ]);
    // The session of today received the settlement apart (RN-05.22, RN-07.09).
    const report = await sessionReport(c, todaySession);
    expect(report.totals).toMatchObject({
      receivedCents: 7000,
      receivedSalesCents: 3000,
      receivedSettlementsCents: 4000,
      salesCents: 0,
    });
    // Yesterday still shows what was put on credit, with the current balance.
    const yesterday = await dayOf(c, yesterdayDay);
    expect(yesterday.summary).toMatchObject({ onCreditCents: 10_000, receivedCents: 8000 });
    expect(yesterday.credit.tabs[0]).toMatchObject({ amountCents: 10_000, balanceCents: 6000 });
  });

  it('CA-07.03, RN-07.10: an event with 500 agreed and 462 consumed in two days shows a difference of 38', async () => {
    const c = await crew('Relatório 07.03');
    const event = await ok<ContractedEventDto>('post', `/units/${c.unitId}/events`, c.owner, {
      contractorName: 'Casamento Silva',
      startsOn: daysAgo(1),
      endsOn: today().toString(),
      modality: 'consumption_billed',
      agreedAmountCents: 500_000,
      agreedQuantity: 500,
      limits: '500 espetos',
    });
    await ok('post', `/events/${event.id}/start`, c.owner, {}, 200);
    const skewers = (quantities: number[]) =>
      quantities.map((quantity) => ({
        productId: c.setup.products.skewer,
        quantity,
        modifierIds: [c.setup.modifiers.medium],
      }));

    // Day 1: 300 skewers on the tab of the contractor, put on credit (RN-06.08).
    const first = await openRegister(c);
    const contractor = await tabWith(c, skewers([99, 99, 99, 3]), 'Casamento Silva');
    expect(contractor.eventId).toBe(event.id);
    await requestBill(c, contractor.id);
    await ok('post', `/tabs/${contractor.id}/put-on-credit`, c.counter.auth, {}, 200);
    await closeSession(c, first);
    await moveToDay(c, daysAgo(1));

    // Day 2: 162 more, paid; and a tab of the event canceled.
    await openRegister(c);
    const guests = await tabWith(c, skewers([99, 63]), 'Convidados');
    expect(guests.eventId).toBe(event.id);
    await requestBill(c, guests.id);
    // The event has no list: "Normal" applies while it is in progress (RN-04.32), R$ 12,00 each.
    await pay(c, guests.id, { method: 'credit_card', amountCents: 194_400 });

    const result = await ok<EventReportDto>('get', `/events/${event.id}/report`, c.owner);
    expect(result.partial).toBe(true);
    expect(result.event).toMatchObject({ id: event.id, contractorName: 'Casamento Silva' });
    expect(result.agreement).toEqual({
      consumedQuantity: 462,
      consumedCents: 554_400,
      quantityDifference: 38,
    });
    expect(result.summary).toMatchObject({
      salesCents: 554_400,
      onCreditCents: 360_000,
      receivedCents: 194_400,
      tabCount: 2,
    });
    expect(result.tabs).toEqual([
      expect.objectContaining({
        tabId: contractor.id,
        status: 'on_credit',
        businessDate: daysAgo(1),
        totalCents: 360_000,
        balanceCents: 360_000,
      }),
      expect.objectContaining({
        tabId: guests.id,
        status: 'paid',
        businessDate: today().toString(),
        totalCents: 194_400,
        paidCents: 194_400,
        balanceCents: 0,
      }),
    ]);
    expect(result.products).toEqual([
      expect.objectContaining({ productId: c.setup.products.skewer, quantity: 462 }),
    ]);

    // The day report shows the event with the sale of that day.
    const day2 = await dayOf(c);
    expect(day2.events).toEqual([
      {
        eventId: event.id,
        contractorName: 'Casamento Silva',
        status: 'in_progress',
        salesCents: 194_400,
      },
    ]);
    const events = await history<EventHistoryDto>('/reports/events', c.owner, {
      unitId: c.unitId,
    });
    expect(events.data).toEqual([
      expect.objectContaining({
        eventId: event.id,
        salesCents: 554_400,
        consumedQuantity: 462,
        agreedQuantity: 500,
        quantityDifference: 38,
      }),
    ]);
  });

  it('CA-07.04, RN-07.04, RN-07.08: the cash difference, discounts and waste appear in the session, the day and the history', async () => {
    const c = await crew('Relatório 07.04');
    const sessionId = await openRegister(c);
    // Skewer with garlic bread (+ R$ 3,00): R$ 13,00 each (R$ 10,00 in "Feira").
    const tab = await tabWith(c, [
      {
        productId: c.setup.products.skewer,
        quantity: 3,
        modifierIds: [c.setup.modifiers.medium, c.setup.modifiers.garlicBread],
      },
    ]);
    const item = tab.orders[0]?.items[0];
    if (!item) {
      throw new Error('item not found');
    }
    // 1 of 3 canceled after leaving the first stage: waste of R$ 13,00 (RN-04.27).
    await ok('post', `/order-items/${item.id}/advance`, c.owner, { version: item.version }, 200);
    const advanced = await ok<TabDto>('get', `/tabs/${tab.id}`, c.counter.auth);
    const line = advanced.orders[0]?.items[0];
    await ok(
      'post',
      `/order-items/${line?.id ?? ''}/cancel`,
      c.owner,
      { version: line?.version ?? 0, quantity: 1, reason: 'Caiu no chão' },
      200,
    );
    await ok('put', `/tabs/${tab.id}/discount`, c.counter.auth, {
      type: 'percent',
      value: 10,
      reason: 'Cliente fiel',
    });
    await requestBill(c, tab.id);
    // Subtotal 2 × 13,00 = 26,00; 10% off = 2,60; total 23,40.
    await pay(c, tab.id, { method: 'cash', tenderedCents: 2340 });
    await closeSession(c, sessionId, { cash: 500 });

    const result = await dayOf(c);
    expect(result.summary).toMatchObject({
      salesCents: 2340,
      discountsCents: 260,
      wasteCents: 1300,
      wasteQuantity: 1,
      cashDifferenceCents: 500,
    });
    expect(result.products).toEqual([
      expect.objectContaining({
        productId: c.setup.products.skewer,
        productName: 'Espeto de carne',
        quantity: 2,
        valueCents: 2600,
        modifiers: [
          {
            groupName: 'Acompanhamentos',
            modifierName: 'Pão de alho',
            priceDeltaCents: 300,
            quantity: 2,
            valueCents: 600,
          },
        ],
      }),
    ]);
    expect(result.cashSessions).toEqual([
      expect.objectContaining({ sessionId, differenceCents: 500, receivedCents: 2340 }),
    ]);
    expect(result.cancellations.items).toEqual([
      expect.objectContaining({
        quantity: 1,
        valueCents: 1300,
        wasted: true,
        reason: 'Caiu no chão',
      }),
    ]);
    const counter = result.staff.find((row) => row.actor.id === c.counter.id);
    expect(counter).toMatchObject({ discountCount: 1, discountsCents: 260 });

    const session = await sessionReport(c, sessionId);
    expect(session.partial).toBe(false);
    expect(session.session).toMatchObject({ closingNote: 'Sobrou troco', differenceCents: 500 });
    expect(session.totals).toMatchObject({ cashDifferenceCents: 500, receivedCents: 2340 });
    expect(session.byMethod.find((row) => row.method === 'cash')).toEqual({
      method: 'cash',
      expectedCents: 2340,
      informedCents: 2840,
      differenceCents: 500,
      salesCents: 2340,
      settlementsCents: 0,
    });
    expect(session.responsible).toMatchObject({ type: 'staff', id: c.cashier.id });
    expect(session.payments).toEqual([
      expect.objectContaining({ tabId: tab.id, method: 'cash', amountCents: 2340 }),
    ]);
    expect(session.pending).toEqual({ count: 0, totalCents: 0 });

    const days = await history<DayHistoryDto>('/reports/days', c.owner, { unitId: c.unitId });
    expect(days.data).toEqual([
      expect.objectContaining({
        unitId: c.unitId,
        businessDate: today().toString(),
        partial: false,
        salesCents: 2340,
        receivedCents: 2340,
        cashDifferenceCents: 500,
      }),
    ]);
    expect(days.totals).toMatchObject({
      salesCents: 2340,
      discountsCents: 260,
      wasteCents: 1300,
      cashDifferenceCents: 500,
    });
    const sessions = await history<SessionHistoryDto>('/reports/cash-sessions', c.owner, {
      unitId: c.unitId,
    });
    expect(sessions.data).toEqual([
      expect.objectContaining({ sessionId, differenceCents: 500, receivedCents: 2340 }),
    ]);
  });

  it('CA-07.05, RN-07.05: changing the price of a product or of a list after the day does not change its report', async () => {
    const { c, sessionId } = await threeTabs('Relatório 07.05');
    await closeSession(c, sessionId);
    const before = await dayOf(c);
    const beforeSession = await sessionReport(c, sessionId);
    await platform.product.update({
      where: { id: c.setup.products.soda },
      data: { priceCents: 9999, name: 'Refri novo' },
    });
    await ok('put', `/price-lists/${c.priceList.id}/prices`, c.owner, {
      prices: [{ productId: c.setup.products.soda, priceCents: 5000 }],
    });
    await ok('patch', `/price-lists/${c.priceList.id}`, c.owner, { name: 'Feira nova' });
    const after = await dayOf(c);
    expect(after.summary).toEqual(before.summary);
    expect(after.products[0]).toMatchObject({ productName: 'Refrigerante', valueCents: 18_000 });
    expect(await sessionReport(c, sessionId)).toEqual(beforeSession);
  });

  it('CA-07.06, RN-07.07: staff get 403 on the reports, even operating the cash and on the register they closed', async () => {
    const { c, sessionId } = await threeTabs('Relatório 07.06');
    await closeSession(c, sessionId);
    const event = await ok<ContractedEventDto>('post', `/units/${c.unitId}/events`, c.owner, {
      contractorName: 'Festa',
      startsOn: today().toString(),
      modality: 'fixed_fee',
    });
    for (const auth of [c.counter.auth, c.cashier.auth]) {
      for (const path of [
        `/reports/summary?unitId=${c.unitId}`,
        '/reports/summary',
        '/reports/days',
        '/reports/cash-sessions',
        '/reports/events',
        `/cash-register-sessions/${sessionId}/report`,
        `/events/${event.id}/report`,
      ]) {
        const response = await http().get(`${API}${path}`).set(authHeaders(auth));
        expect(response.status, path).toBe(403);
        expect(errorOf(response).code).toBe('FORBIDDEN');
      }
    }
  });

  it('CA-07.07, RN-04.38: a tab opened on 01/10 and paid on 02/10 counts in the sale of 02/10', async () => {
    const c = await crew('Relatório 07.07');
    const first = await openRegister(c);
    const tab = await tabWith(c, [sodas(c, 2)], 'De ontem');
    await closeSession(c, first);
    await moveToDay(c, daysAgo(1));

    await openRegister(c);
    await requestBill(c, tab.id);
    await pay(c, tab.id, { method: 'pix', amountCents: 2000 });

    const yesterday = await dayOf(c, daysAgo(1));
    expect(yesterday.summary).toMatchObject({ salesCents: 0, tabCount: 0, receivedCents: 0 });
    const now = await dayOf(c);
    expect(now.summary).toMatchObject({ salesCents: 2000, tabCount: 1, receivedCents: 2000 });
    // Opened by the counter yesterday (per staff member, by the day the tab was opened).
    expect(yesterday.staff.find((row) => row.actor.id === c.counter.id)).toMatchObject({
      tabsOpened: 1,
    });
  });

  it('CA-07.08, RN-04.29: a sale at 0h30 of a fair whose register opened the day before counts on that day', async () => {
    const c = await crew('Relatório 07.08');
    const sessionId = await openRegister(c);
    // The register was opened "yesterday at 18h": the day of operation stays while it is open.
    await moveToDay(c, daysAgo(1));
    const tab = await tabWith(c, [sodas(c, 4)], 'Madrugada');
    expect(tab.businessDate).toBe(daysAgo(1));
    await requestBill(c, tab.id);
    await pay(c, tab.id, { method: 'cash', tenderedCents: 4000 });
    await closeSession(c, sessionId);

    const opened = await dayOf(c, daysAgo(1));
    expect(opened.summary).toMatchObject({ salesCents: 4000, receivedCents: 4000, tabCount: 1 });
    expect(opened.cashSessions).toEqual([expect.objectContaining({ sessionId })]);
    const now = await dayOf(c);
    expect(now.summary).toMatchObject({ salesCents: 0, receivedCents: 0, tabCount: 0 });
  });

  it('CA-07.09, RN-07.09: with two registers, each report has only its payments and the day sums both', async () => {
    const c = await crew('Relatório 07.09');
    const second = await ok<CashRegisterDto>('post', `/units/${c.unitId}/cash-registers`, c.owner, {
      name: 'Balcão',
    });
    const one = await openRegister(c);
    const two = await openRegister(c, second.id);
    const a = await tabWith(c, [sodas(c, 2)], 'A');
    await requestBill(c, a.id);
    await pay(c, a.id, { method: 'pix', amountCents: 2000, cashRegisterId: c.setup.register });
    const b = await tabWith(c, [sodas(c, 3)], 'B');
    await requestBill(c, b.id);
    await pay(c, b.id, { method: 'cash', tenderedCents: 3000, cashRegisterId: second.id });

    const first = await sessionReport(c, one);
    expect(first.partial).toBe(true);
    expect(first.payments.map((row) => row.tabId)).toEqual([a.id]);
    expect(first.totals.receivedCents).toBe(2000);
    const other = await sessionReport(c, two);
    expect(other.payments.map((row) => row.tabId)).toEqual([b.id]);
    expect(other.totals.receivedCents).toBe(3000);
    expect(other.session.name).toBe('Balcão');

    const day = await dayOf(c);
    expect(day.summary).toMatchObject({ receivedCents: 5000, salesCents: 5000 });
    expect(day.cashSessions.map((row) => row.sessionId).sort()).toEqual([one, two].sort());
  });

  it('CA-07.10: the report of a period of 7 days sums the 7 daily reports', async () => {
    const c = await crew('Relatório 07.10');
    for (let index = 6; index >= 0; index--) {
      const sessionId = await openRegister(c);
      const tab = await tabWith(
        c,
        [
          sodas(c, index + 1),
          {
            productId: c.setup.products.skewer,
            quantity: 2,
            modifierIds: [c.setup.modifiers.medium],
          },
        ],
        `Dia ${index}`,
      );
      if (index % 2 === 0) {
        const skewer = tab.orders[0]?.items[1];
        await ok(
          'post',
          `/order-items/${skewer?.id ?? ''}/advance`,
          c.owner,
          {
            version: skewer?.version ?? 0,
          },
          200,
        );
        const advanced = await ok<TabDto>('get', `/tabs/${tab.id}`, c.counter.auth);
        const line = advanced.orders[0]?.items.find(
          (row) => row.productId === c.setup.products.skewer,
        );
        await ok(
          'post',
          `/order-items/${line?.id ?? ''}/cancel`,
          c.owner,
          { version: line?.version ?? 0, quantity: 1, reason: 'Queimou' },
          200,
        );
      }
      if (index % 3 === 0) {
        await ok('put', `/tabs/${tab.id}/discount`, c.counter.auth, {
          type: 'amount',
          value: 100,
          reason: 'Arredondar',
        });
      }
      await requestBill(c, tab.id);
      const balance = (await ok<TabDto>('get', `/tabs/${tab.id}`, c.counter.auth)).balanceCents;
      if (index === 3) {
        await putOnCredit(c, tab.id, `Cliente ${index}`);
      } else {
        await pay(c, tab.id, { method: 'cash', tenderedCents: balance });
      }
      await closeSession(c, sessionId, index % 2 === 1 && index !== 3 ? { cash: -50 } : {});
      if (index > 0) {
        await moveToDay(c, daysAgo(index));
      }
    }
    const keys = [
      'salesCents',
      'receivedCents',
      'onCreditCents',
      'wasteCents',
      'discountsCents',
      'cashDifferenceCents',
      'tabCount',
    ] as const;
    const daily = [];
    for (let index = 0; index <= 6; index++) {
      daily.push((await dayOf(c, daysAgo(index))).summary);
    }
    const period = await summary(c.owner, {
      unitId: c.unitId,
      from: daysAgo(6),
      to: today().toString(),
    });
    for (const key of keys) {
      expect(period.summary[key], key).toBe(daily.reduce((sum, row) => sum + row[key], 0));
    }
    expect(period.summary.salesCents).toBeGreaterThan(0);
    expect(period.summary.wasteCents).toBeGreaterThan(0);
    expect(period.summary.cashDifferenceCents).toBe(-100);
    expect(period.cashSessions).toHaveLength(7);

    // History of the days, paginated by cursor, with the totals of the whole period.
    const page1 = await history<DayHistoryDto>('/reports/days', c.owner, {
      unitId: c.unitId,
      from: daysAgo(6),
      to: today().toString(),
      limit: '4',
    });
    expect(page1.data.map((row) => row.businessDate)).toEqual([0, 1, 2, 3].map(daysAgo));
    expect(page1.totals.salesCents).toBe(period.summary.salesCents);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await history<DayHistoryDto>('/reports/days', c.owner, {
      unitId: c.unitId,
      from: daysAgo(6),
      to: today().toString(),
      limit: '4',
      cursor: page1.nextCursor ?? '',
    });
    expect(page2.data.map((row) => row.businessDate)).toEqual([4, 5, 6].map(daysAgo));
    expect(page2.nextCursor).toBeNull();

    const sessions1 = await history<SessionHistoryDto>('/reports/cash-sessions', c.owner, {
      unitId: c.unitId,
      from: daysAgo(6),
      to: today().toString(),
      limit: '5',
    });
    expect(sessions1.data).toHaveLength(5);
    expect(sessions1.data[0]?.businessDate).toBe(today().toString());
    expect(sessions1.totals.salesCents).toBe(period.summary.salesCents);
    const sessions2 = await history<SessionHistoryDto>('/reports/cash-sessions', c.owner, {
      unitId: c.unitId,
      from: daysAgo(6),
      to: today().toString(),
      limit: '5',
      cursor: sessions1.nextCursor ?? '',
    });
    expect(sessions2.data).toHaveLength(2);
    expect(sessions2.nextCursor).toBeNull();
    const byRegister = await history<SessionHistoryDto>('/reports/cash-sessions', c.owner, {
      cashRegisterId: c.setup.register,
      from: daysAgo(6),
      to: today().toString(),
    });
    expect(byRegister.data).toHaveLength(7);

    const invalid: Record<string, string>[] = [
      { from: '2026-01-10', to: '2026-01-01' },
      { cursor: 'abc' },
      { from: '10/01/2026' },
    ];
    for (const query of invalid) {
      for (const path of ['/reports/summary', '/reports/days', '/reports/cash-sessions']) {
        const response = await http()
          .get(`${API}${path}?${new URLSearchParams(query).toString()}`)
          .set(authHeaders(c.owner));
        if (path === '/reports/summary' && 'cursor' in query) {
          continue;
        }
        expect(response.status, `${path} ${JSON.stringify(query)}`).toBe(400);
        expect(errorOf(response).code).toBe('VALIDATION_FAILED');
      }
    }
  });

  it('RN-06.03 (LGPD): removing a customer renames its tabs; they stay in the reports', async () => {
    const { c, hung, customer } = await threeTabs('Relatório LGPD');
    await pay(c, hung.id, { method: 'pix', amountCents: 10_000 });
    await ok('delete', `/customers/${customer.id}`, c.owner);
    const result = await dayOf(c);
    expect(result.credit.tabs).toEqual([
      expect.objectContaining({
        tabId: hung.id,
        customerName: 'Cliente removido',
        customer: expect.objectContaining({ name: 'Cliente removido', removed: true }) as unknown,
        amountCents: 10_000,
      }),
    ]);
    expect(result.summary).toMatchObject({ salesCents: 18_000, onCreditCents: 10_000 });
    expect(JSON.stringify(result)).not.toContain('Pendura');
  });

  describe('tenant isolation (CA-01.02)', () => {
    it('organization B gets 404 with ids of A and never sees its days, sessions or events', async () => {
      const a = await threeTabs('Relatório A');
      const event = await ok<ContractedEventDto>('post', `/units/${a.c.unitId}/events`, a.c.owner, {
        contractorName: 'Festa A',
        startsOn: today().toString(),
        modality: 'other',
      });
      const b = await crew('Relatório B');
      for (const path of [
        `/cash-register-sessions/${a.sessionId}/report`,
        `/events/${event.id}/report`,
        `/reports/summary?unitId=${a.c.unitId}`,
        `/reports/days?unitId=${a.c.unitId}`,
        `/reports/cash-sessions?unitId=${a.c.unitId}`,
        `/reports/events?unitId=${a.c.unitId}`,
      ]) {
        await expectNotFoundForOtherTenant(app, {
          method: 'get',
          path: `${API}${path}`,
          as: b.owner,
        });
      }
      const own = await summary(b.owner, {});
      expect(own.unit).toBeNull();
      expect(own.summary).toMatchObject({ salesCents: 0, receivedCents: 0, tabCount: 0 });
      const days = await history<DayHistoryDto>('/reports/days', b.owner, {});
      expect(days.data).toEqual([]);
      const sessions = await history<SessionHistoryDto>('/reports/cash-sessions', b.owner, {});
      expect(sessions.data).toEqual([]);
      const events = await history<EventHistoryDto>('/reports/events', b.owner, {});
      expect(events.data).toEqual([]);
    });
  });
});
