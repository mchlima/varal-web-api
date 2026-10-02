import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { AuthContext } from '../../src/context/request-context.js';
import type { CashRegisterDetailDto, CashRegisterDto } from '../../src/operation/cash.schemas.js';
import type { CustomerDto } from '../../src/operation/credit.schemas.js';
import type { ShiftDto, TabDto } from '../../src/operation/operation.schemas.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import type { ShiftHistoryDto, ShiftReportDto } from '../../src/reports/reports.schemas.js';
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
  shift: ShiftDto;
}

const COUNTS = (informed: Record<string, number>) => ({
  counts: ['cash', 'pix', 'credit_card', 'debit_card'].map((method) => ({
    method,
    informedCents: informed[method] ?? 0,
  })),
});

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

  /** A unit where the skewer and the soda cost R$ 10,00 in the shift. */
  async function crew(label: string, shiftBody?: object): Promise<Crew> {
    const tenant = await createTenant(platform, label);
    const setup = await setupOperation(platform, tenant);
    const { stations } = setup;
    const c = {
      setup,
      unitId: tenant.unitId,
      owner: tenant.ownerAuth,
      cashier: await createStaff(platform, tenant, [stations.counter, stations.delivery], {
        canOperateCash: true,
      }),
      counter: await createStaff(platform, tenant, [stations.counter]),
    };
    return { ...c, shift: await openShift(c, shiftBody) };
  }

  function openShift(c: Pick<Crew, 'setup' | 'unitId' | 'owner'>, body?: object) {
    return ok<ShiftDto>('post', `/units/${c.unitId}/shifts`, c.owner, {
      type: 'direct_sale',
      prices: [
        { productId: c.setup.products.skewer, priceCents: 1000 },
        { productId: c.setup.products.soda, priceCents: 1000 },
      ],
      ...body,
    });
  }

  function sodas(c: Crew, quantity: number): object {
    return { productId: c.setup.products.soda, quantity };
  }

  function openRegister(c: Crew, shiftId = c.shift.id) {
    return ok<CashRegisterDto>('post', `/shifts/${shiftId}/cash-registers`, c.cashier.auth, {
      openingFloatCents: 0,
    });
  }

  async function tabWith(c: Crew, items: object[], customerName = 'Dona Marta') {
    const tab = await ok<TabDto>('post', `/shifts/${c.shift.id}/tabs`, c.counter.auth, {
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

  async function closeRegisters(c: Crew, informedExtra: Record<string, number> = {}) {
    const registers = await ok<CashRegisterDto[] | { data: CashRegisterDto[] }>(
      'get',
      `/shifts/${c.shift.id}/cash-registers`,
      c.cashier.auth,
    );
    const list = Array.isArray(registers) ? registers : registers.data;
    for (const register of list.filter((row) => row.status === 'open')) {
      const current = await ok<CashRegisterDetailDto>(
        'get',
        `/cash-registers/${register.id}`,
        c.cashier.auth,
      );
      const informed = Object.fromEntries(
        current.expected.map((row) => [
          row.method,
          row.expectedCents + (informedExtra[row.method] ?? 0),
        ]),
      );
      const differs = Object.values(informedExtra).some((value) => value !== 0);
      await ok(
        'post',
        `/cash-registers/${register.id}/close`,
        c.cashier.auth,
        { ...COUNTS(informed), ...(differs ? { note: 'Sobrou troco' } : {}) },
        200,
      );
    }
  }

  async function closeShift(c: Crew, informedExtra: Record<string, number> = {}) {
    await closeRegisters(c, informedExtra);
    await ok('post', `/shifts/${c.shift.id}/close`, c.owner, undefined, 200);
  }

  function report(c: Crew, shiftId = c.shift.id) {
    return ok<ShiftReportDto>('get', `/shifts/${shiftId}/report`, c.owner);
  }

  function history(auth: AuthContext, query: Record<string, string>) {
    return ok<ShiftHistoryDto>(
      'get',
      `/reports/shifts?${new URLSearchParams(query).toString()}`,
      auth,
    );
  }

  /**
   * CA-07.01: a tab paid R$ 80,00, one on credit of R$ 100,00 and one canceled. Returns the crew
   * with the shift still open.
   */
  async function threeTabs(label: string) {
    const c = await crew(label);
    await openRegister(c);
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
      {
        version: item.version,
        reason: 'Cliente desistiu',
      },
      200,
    );
    await ok('post', `/tabs/${canceled.id}/cancel`, c.counter.auth, {}, 200);
    return { c, paid, hung, canceled, customer };
  }

  it('CA-07.01, RN-07.01 to RN-07.03, RN-07.06: sale R$ 180,00, received R$ 80,00, on credit R$ 100,00; partial while open', async () => {
    const { c, hung, canceled, customer } = await threeTabs('Relatório 07.01');
    const open = await report(c);
    expect(open.partial).toBe(true);
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
    expect(open.products).toEqual([
      {
        productId: c.setup.products.soda,
        productName: 'Refrigerante',
        quantity: 18,
        valueCents: 18_000,
        modifiers: [],
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
      expect.objectContaining({
        quantity: 1,
        valueCents: 1000,
        wasted: false,
        reason: 'Cliente desistiu',
      }),
    ]);
    const counter = open.staff.find((row) => row.actor.id === c.counter.id);
    expect(counter).toMatchObject({
      actor: { type: 'staff', name: expect.stringMatching(/^Colaborador/) as unknown },
      tabsOpened: 3,
      ordersSent: 3,
      receivedCents: 8000,
      itemsCanceled: 1,
      tabsCanceled: 1,
    });
    expect(open.agreement).toBeNull();

    await closeShift(c);
    const closed = await report(c);
    expect(closed.partial).toBe(false);
    expect(closed.shift.closedBy).toMatchObject({ type: 'owner', id: c.setup.tenant.ownerId });
    expect(closed.summary).toMatchObject({
      salesCents: 18_000,
      receivedCents: 8000,
      onCreditCents: 10_000,
    });
  });

  it('CA-07.02, RN-07.02: a settlement received today of a tab of yesterday is received as settlement, not a sale', async () => {
    const { c, hung } = await threeTabs('Relatório 07.02');
    await closeShift(c);
    const today = await openShift(c);
    const next = { ...c, shift: today };
    await openRegister(next);
    const sale = await tabWith(next, [sodas(next, 3)]);
    await requestBill(next, sale.id);
    await pay(next, sale.id, { method: 'cash', tenderedCents: 3000 });
    await pay(next, hung.id, { method: 'pix', amountCents: 4000 });

    const now = await report(next);
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
      expect.objectContaining({ tabId: hung.id, tabShiftId: c.shift.id, amountCents: 4000 }),
    ]);
    // Yesterday still shows what was put on credit, with the current balance.
    const yesterday = await report(c);
    expect(yesterday.summary.onCreditCents).toBe(10_000);
    expect(yesterday.credit.tabs[0]).toMatchObject({ amountCents: 10_000, balanceCents: 6000 });
  });

  it('CA-07.03: a contracted shift with 500 agreed and 462 consumed shows a difference of 38', async () => {
    const c = await crew('Relatório 07.03', {
      type: 'contracted',
      agreement: {
        contractorName: 'Casamento Silva',
        modality: 'consumption_billed',
        agreedAmountCents: 500_000,
        agreedQuantity: 500,
        limits: '500 espetos',
      },
    });
    const tab = await tabWith(
      c,
      [99, 99, 99, 99, 66].map((quantity) => ({
        productId: c.setup.products.skewer,
        quantity,
        modifierIds: [c.setup.modifiers.medium],
      })),
      'Casamento Silva',
    );
    await requestBill(c, tab.id);
    await ok('post', `/tabs/${tab.id}/put-on-credit`, c.counter.auth, {}, 200);
    const result = await report(c);
    expect(result.agreement).toEqual({
      contractorName: 'Casamento Silva',
      modality: 'consumption_billed',
      agreedAmountCents: 500_000,
      agreedQuantity: 500,
      limits: '500 espetos',
      notes: null,
      consumedQuantity: 462,
      consumedCents: 462_000,
      quantityDifference: 38,
    });
    expect(result.summary).toMatchObject({ salesCents: 462_000, onCreditCents: 462_000 });
  });

  it('CA-07.04, RN-07.04: the cash difference, discounts and waste appear in the report and in the history', async () => {
    const c = await crew('Relatório 07.04');
    await openRegister(c);
    // Skewer with garlic bread (+ R$ 3,00): R$ 13,00 each.
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
      {
        version: line?.version ?? 0,
        quantity: 1,
        reason: 'Caiu no chão',
      },
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
    await closeShift(c, { cash: 500 });

    const result = await report(c);
    expect(result.summary).toMatchObject({
      salesCents: 2340,
      discountsCents: 260,
      wasteCents: 1300,
      wasteQuantity: 1,
      cashDifferenceCents: 500,
    });
    expect(result.products).toEqual([
      {
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
      },
    ]);
    expect(result.cashRegisters).toHaveLength(1);
    expect(result.cashRegisters[0]).toMatchObject({
      differenceCents: 500,
      closingNote: 'Sobrou troco',
      responsible: { type: 'staff', id: c.cashier.id },
    });
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

    const list = await history(c.owner, { unitId: c.unitId });
    expect(list.data).toEqual([
      expect.objectContaining({
        shiftId: c.shift.id,
        status: 'closed',
        salesCents: 2340,
        receivedCents: 2340,
        onCreditCents: 0,
        cashDifferenceCents: 500,
      }),
    ]);
    expect(list.totals).toMatchObject({
      shiftCount: 1,
      salesCents: 2340,
      discountsCents: 260,
      wasteCents: 1300,
      cashDifferenceCents: 500,
    });
  });

  it('CA-07.05, RN-07.05: changing the price of a product after the shift does not change its report', async () => {
    const { c } = await threeTabs('Relatório 07.05');
    await closeShift(c);
    const before = await report(c);
    await platform.product.update({
      where: { id: c.setup.products.soda },
      data: { priceCents: 9999, name: 'Refri novo' },
    });
    const after = await report(c);
    expect(after).toEqual(before);
    expect(after.products[0]).toMatchObject({ productName: 'Refrigerante', valueCents: 18_000 });
  });

  it('CA-07.06, RN-07.07: staff get 403 on the reports, even operating the cash', async () => {
    const c = await crew('Relatório 07.06');
    for (const auth of [c.counter.auth, c.cashier.auth]) {
      for (const path of [
        `/shifts/${c.shift.id}/report`,
        `/reports/shifts?unitId=${c.unitId}`,
        '/reports/shifts',
      ]) {
        const response = await http().get(`${API}${path}`).set(authHeaders(auth));
        expect(response.status).toBe(403);
        expect(errorOf(response).code).toBe('FORBIDDEN');
      }
    }
  });

  it('section 5: history filters by unit, type and period, newest first, with cursor and period totals', async () => {
    const c = await crew('Histórico');
    await closeShift(c);
    const contracted = await openShift(c, {
      type: 'contracted',
      agreement: { contractorName: 'Festa', modality: 'fixed_fee' },
    });
    const second = { ...c, shift: contracted };
    await openRegister(second);
    const tab = await tabWith(second, [sodas(second, 2)]);
    await requestBill(second, tab.id);
    await pay(second, tab.id, { method: 'debit_card', amountCents: 2000 });
    await closeShift(second);
    // The first shift was "yesterday" (São Paulo).
    const yesterday = resolveHistoryPeriod({}).to.subtract({ days: 1 });
    await platform.shift.update({
      where: { id: c.shift.id },
      data: { openedAt: new Date(`${yesterday.toString()}T15:00:00-03:00`) },
    });

    const all = await history(c.owner, { unitId: c.unitId });
    expect(all.data.map((row) => row.shiftId)).toEqual([contracted.id, c.shift.id]);
    expect(all.data[1]?.date).toBe(yesterday.toString());
    expect(all.totals).toMatchObject({ shiftCount: 2, salesCents: 2000, receivedCents: 2000 });
    expect(all.period.timeZone).toBe('America/Sao_Paulo');

    const first = await history(c.owner, { unitId: c.unitId, limit: '1' });
    expect(first.data.map((row) => row.shiftId)).toEqual([contracted.id]);
    expect(first.totals.shiftCount).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    const next = await history(c.owner, {
      unitId: c.unitId,
      limit: '1',
      cursor: first.nextCursor ?? '',
    });
    expect(next.data.map((row) => row.shiftId)).toEqual([c.shift.id]);
    expect(next.nextCursor).toBeNull();

    const typed = await history(c.owner, { unitId: c.unitId, type: 'contracted' });
    expect(typed.data.map((row) => row.shiftId)).toEqual([contracted.id]);
    const onlyYesterday = await history(c.owner, {
      unitId: c.unitId,
      from: yesterday.toString(),
      to: yesterday.toString(),
    });
    expect(onlyYesterday.data.map((row) => row.shiftId)).toEqual([c.shift.id]);
    expect(onlyYesterday.totals).toMatchObject({ shiftCount: 1, salesCents: 0 });
    // Without a unit: every unit of the organization.
    const everywhere = await history(c.owner, {});
    expect(everywhere.data.map((row) => row.shiftId)).toEqual([contracted.id, c.shift.id]);

    const invalid: Record<string, string>[] = [
      { from: '2026-01-10', to: '2026-01-01' },
      { cursor: 'abc' },
      { from: '10/01/2026' },
    ];
    for (const query of invalid) {
      const response = await http()
        .get(`${API}/reports/shifts?${new URLSearchParams(query).toString()}`)
        .set(authHeaders(c.owner));
      expect(response.status).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_FAILED');
    }
  });

  it('RN-06.03 (LGPD): removing a customer renames its tabs; they stay in the reports', async () => {
    const { c, hung, customer } = await threeTabs('Relatório LGPD');
    await pay(c, hung.id, { method: 'pix', amountCents: 10_000 });
    await ok('delete', `/customers/${customer.id}`, c.owner);
    const result = await report(c);
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
    it('organization B gets 404 with ids of A and never sees its shifts', async () => {
      const a = await threeTabs('Relatório A');
      const b = await crew('Relatório B');
      for (const path of [
        `/shifts/${a.c.shift.id}/report`,
        `/reports/shifts?unitId=${a.c.unitId}`,
      ]) {
        await expectNotFoundForOtherTenant(app, {
          method: 'get',
          path: `${API}${path}`,
          as: b.owner,
        });
      }
      const own = await history(b.owner, {});
      expect(own.data.map((row) => row.shiftId)).toEqual([b.shift.id]);
      expect(own.totals).toMatchObject({ shiftCount: 1, salesCents: 0, receivedCents: 0 });
    });
  });
});
