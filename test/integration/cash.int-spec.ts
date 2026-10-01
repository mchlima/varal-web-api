import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { MetricsService, resolvePeriod } from '../../src/admin/metrics/metrics.service.js';
import {
  type AuthContext,
  requireOrganizationId,
  runWithContext,
  systemContext,
} from '../../src/context/request-context.js';
import type {
  CashRegisterDetailDto,
  CashRegisterDto,
  PaymentResultDto,
} from '../../src/operation/cash.schemas.js';
import type {
  ItemChangeDto,
  OrderDto,
  ShiftDto,
  StationQueueDto,
  TabDto,
  TabSummaryDto,
} from '../../src/operation/operation.schemas.js';
import type { TenantDb } from '../../src/prisma/prisma.service.js';
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
  cashier: TestStaff;
  /** Balcão only, does not operate cash. */
  counter: TestStaff;
  /** Cozinha only. */
  kitchen: TestStaff;
  shift: ShiftDto;
}

const ALL_ZERO = { cash: 0, pix: 0, credit_card: 0, debit_card: 0 };

describe.skipIf(!databaseUrl)('closing and cash registers (spec 05)', () => {
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

  /** A unit with an open shift where the skewer costs `skewerCents` (shift price, RN-04.06). */
  async function crew(label: string, skewerCents = 1000): Promise<Crew> {
    const tenant = await createTenant(platform, label);
    const setup = await setupOperation(platform, tenant);
    const { stations } = setup;
    const shift = await ok<ShiftDto>('post', `/units/${tenant.unitId}/shifts`, tenant.ownerAuth, {
      type: 'direct_sale',
      prices: [{ productId: setup.products.skewer, priceCents: skewerCents }],
    });
    return {
      setup,
      owner: tenant.ownerAuth,
      cashier: await createStaff(platform, tenant, [stations.counter, stations.delivery], {
        canOperateCash: true,
      }),
      counter: await createStaff(platform, tenant, [stations.counter]),
      kitchen: await createStaff(platform, tenant, [stations.kitchen]),
      shift,
    };
  }

  async function ok<T>(
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    auth: AuthContext,
    body?: object,
    status = method === 'post' ? 201 : 200,
    headers: Record<string, string> = {},
  ): Promise<T> {
    let call = http()[method](`${API}${path}`).set(as(auth)).set(headers);
    if (body !== undefined) {
      call = call.send(body);
    }
    const response = await call;
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return response.body as T;
  }

  async function fails(
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    auth: AuthContext,
    body: object | undefined,
    status: number,
    code: string,
  ): Promise<Record<string, unknown>> {
    let call = http()[method](`${API}${path}`).set(as(auth));
    if (body !== undefined) {
      call = call.send(body);
    }
    const response = await call;
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    expect(errorOf(response).code).toBe(code);
    return (response.body as { error: { details: Record<string, unknown> } }).error.details;
  }

  function skewers(c: Crew, quantity: number): object {
    return {
      productId: c.setup.products.skewer,
      quantity,
      modifierIds: [c.setup.modifiers.medium],
    };
  }

  function openRegister(c: Crew, openingFloatCents = 10_000, name?: string) {
    return ok<CashRegisterDto>('post', `/shifts/${c.shift.id}/cash-registers`, c.cashier.auth, {
      openingFloatCents,
      ...(name === undefined ? {} : { name }),
    });
  }

  /** An open tab with `quantity` skewers, already in `closing` (pedir a conta). */
  async function billedTab(c: Crew, quantity: number, customerName = 'Dona Marta') {
    const tab = await ok<TabDto>('post', `/shifts/${c.shift.id}/tabs`, c.counter.auth, {
      customerName,
    });
    const order = await ok<OrderDto>('post', `/tabs/${tab.id}/orders`, c.counter.auth, {
      items: [skewers(c, quantity)],
    });
    const billed = await ok<TabDto>(
      'post',
      `/tabs/${tab.id}/request-bill`,
      c.counter.auth,
      {},
      200,
    );
    return { tab: billed, order };
  }

  function pay(c: Crew, tabId: string, body: object, auth = c.counter.auth) {
    return ok<PaymentResultDto>('post', `/tabs/${tabId}/payments`, auth, body);
  }

  function expectedOf(register: CashRegisterDto): Record<string, number> {
    return Object.fromEntries(register.expected.map((row) => [row.method, row.expectedCents]));
  }

  async function auditActions(entityId: string): Promise<string[]> {
    const rows = await platform.auditLog.findMany({
      where: { entityId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => row.action);
  }

  describe('payments (section 4)', () => {
    it('CA-05.08, RN-05.06: without an open register the payment is refused', async () => {
      const c = await crew('Sem caixa');
      const { tab } = await billedTab(c, 2);
      await fails(
        'post',
        `/tabs/${tab.id}/payments`,
        c.counter.auth,
        { method: 'pix', amountCents: 500 },
        409,
        'NO_CASH_REGISTER_OPEN',
      );
      await expect(platform.payment.count({ where: { tabId: tab.id } })).resolves.toBe(0);
    });

    it('CA-05.01, RN-05.10: R$ 80,00 paid with R$ 50,00 in Pix and R$ 30,00 in cash is paid and leaves the varal', async () => {
      const c = await crew('Pago');
      await openRegister(c);
      const { tab } = await billedTab(c, 8);
      expect(tab).toMatchObject({ totalCents: 8000, paidCents: 0, balanceCents: 8000 });

      const pix = await pay(c, tab.id, { method: 'pix', amountCents: 5000 });
      expect(pix.tab).toMatchObject({ status: 'closing', paidCents: 5000, balanceCents: 3000 });
      const cash = await pay(c, tab.id, { method: 'cash', tenderedCents: 3000 });
      expect(cash.payment).toMatchObject({ amountCents: 3000, changeCents: 0 });
      expect(cash.tab).toMatchObject({ status: 'paid', paidCents: 8000, balanceCents: 0 });
      expect(cash.tab.closedAt).not.toBeNull();
      expect(cash.tab.payments.map((payment) => payment.method)).toEqual(['pix', 'cash']);

      const varal = await ok<{ data: TabSummaryDto[] }>(
        'get',
        `/shifts/${c.shift.id}/tabs`,
        c.counter.auth,
      );
      expect(varal.data.map((row) => row.id)).not.toContain(tab.id);
      expect(await auditActions(tab.id)).toEqual(
        expect.arrayContaining(['tab.bill_requested', 'tab.paid']),
      );
      expect(await auditActions(pix.payment.id)).toEqual(['payment.received']);
      // A paid tab takes no more payments (RN-05.11).
      await fails(
        'post',
        `/tabs/${tab.id}/payments`,
        c.counter.auth,
        { method: 'pix', amountCents: 1 },
        409,
        'TAB_NOTHING_TO_PAY',
      );
    });

    it('CA-05.02, RN-05.09: R$ 46,00 in cash with R$ 50,00 tendered applies R$ 46,00 and gives R$ 4,00 of change', async () => {
      const c = await crew('Troco', 2300);
      await openRegister(c);
      const { tab } = await billedTab(c, 2);
      const result = await pay(c, tab.id, { method: 'cash', tenderedCents: 5000 });
      expect(result.payment).toMatchObject({
        method: 'cash',
        amountCents: 4600,
        tenderedCents: 5000,
        changeCents: 400,
      });
      expect(result.tab.status).toBe('paid');
    });

    it('CA-05.03, RN-05.08: Pix or card above the balance is refused; cash needs the tendered value', async () => {
      const c = await crew('Acima do saldo');
      await openRegister(c);
      const { tab } = await billedTab(c, 2);
      for (const method of ['pix', 'credit_card', 'debit_card']) {
        const details = await fails(
          'post',
          `/tabs/${tab.id}/payments`,
          c.counter.auth,
          { method, amountCents: 2001 },
          409,
          'PAYMENT_EXCEEDS_BALANCE',
        );
        expect(details).toMatchObject({ balanceCents: 2000 });
      }
      await fails(
        'post',
        `/tabs/${tab.id}/payments`,
        c.counter.auth,
        { method: 'cash', amountCents: 2000 },
        400,
        'VALIDATION_FAILED',
      );
      await fails(
        'post',
        `/tabs/${tab.id}/payments`,
        c.counter.auth,
        { method: 'pix', tenderedCents: 2000 },
        400,
        'VALIDATION_FAILED',
      );
      await expect(platform.payment.count({ where: { tabId: tab.id } })).resolves.toBe(0);
    });

    it('RN-05.07, RN-05.11: only a tab in closing is paid; a tab with total zero is not', async () => {
      const c = await crew('Situações');
      await openRegister(c);
      const tab = await ok<TabDto>('post', `/shifts/${c.shift.id}/tabs`, c.counter.auth, {
        customerName: 'Aberta',
      });
      const order = await ok<OrderDto>('post', `/tabs/${tab.id}/orders`, c.counter.auth, {
        items: [skewers(c, 1)],
      });
      await fails(
        'post',
        `/tabs/${tab.id}/payments`,
        c.counter.auth,
        { method: 'pix', amountCents: 100 },
        409,
        'TAB_NOT_CLOSING',
      );
      const item = order.items[0];
      if (!item) {
        throw new Error('no item');
      }
      await ok<ItemChangeDto>(
        'post',
        `/order-items/${item.id}/cancel`,
        c.counter.auth,
        { version: item.version, reason: 'Desistiu' },
        200,
      );
      await ok<TabDto>('post', `/tabs/${tab.id}/request-bill`, c.counter.auth, {}, 200);
      await fails(
        'post',
        `/tabs/${tab.id}/payments`,
        c.counter.auth,
        { method: 'pix', amountCents: 100 },
        409,
        'TAB_NOTHING_TO_PAY',
      );
    });

    it('RN-05.05: with more than one open register the counter chooses; the register must be of the shift and open', async () => {
      const c = await crew('Dois caixas');
      const first = await openRegister(c);
      const second = await openRegister(c, 0);
      expect([first.name, second.name]).toEqual(['Caixa 1', 'Caixa 2']);
      const { tab } = await billedTab(c, 3);
      const details = await fails(
        'post',
        `/tabs/${tab.id}/payments`,
        c.counter.auth,
        { method: 'pix', amountCents: 1000 },
        409,
        'CASH_REGISTER_REQUIRED',
      );
      expect(details.cashRegisters).toEqual([
        { id: first.id, name: 'Caixa 1' },
        { id: second.id, name: 'Caixa 2' },
      ]);
      const paid = await pay(c, tab.id, {
        method: 'pix',
        amountCents: 1000,
        cashRegisterId: second.id,
      });
      expect(paid.payment.cashRegisterId).toBe(second.id);

      // A register of another shift of the same organization is refused.
      const otherShift = await platform.shift.create({
        data: {
          organizationId: c.setup.tenant.organizationId,
          unitId: c.setup.tenant.unitId,
          type: 'direct_sale',
          status: 'closed',
          openedByType: 'owner',
          openedAt: new Date(),
          closedAt: new Date(),
        },
      });
      const foreign = await platform.cashRegister.create({
        data: {
          organizationId: c.setup.tenant.organizationId,
          shiftId: otherShift.id,
          unitId: c.setup.tenant.unitId,
          name: 'Antigo',
          openingFloatCents: 0,
          openedByType: 'owner',
          openedAt: new Date(),
        },
      });
      await fails(
        'post',
        `/tabs/${tab.id}/payments`,
        c.counter.auth,
        { method: 'pix', amountCents: 1000, cashRegisterId: foreign.id },
        400,
        'INVALID_CASH_REGISTER',
      );
      // A closed register takes no payment (RN-05.21).
      await ok<CashRegisterDto>(
        'post',
        `/cash-registers/${first.id}/close`,
        c.cashier.auth,
        {
          counts: [
            { method: 'cash', informedCents: 10_000 },
            { method: 'pix', informedCents: 0 },
            { method: 'credit_card', informedCents: 0 },
            { method: 'debit_card', informedCents: 0 },
          ],
        },
        200,
      );
      await fails(
        'post',
        `/tabs/${tab.id}/payments`,
        c.counter.auth,
        { method: 'pix', amountCents: 1000, cashRegisterId: first.id },
        409,
        'CASH_REGISTER_CLOSED',
      );
      // With one register left, the choice is automatic again.
      const auto = await pay(c, tab.id, { method: 'pix', amountCents: 1000 });
      expect(auto.payment.cashRegisterId).toBe(second.id);
    });

    it('concurrency: two devices paying the whole balance at once never go past the total', async () => {
      const c = await crew('Corrida');
      await openRegister(c);
      const { tab } = await billedTab(c, 5);
      const responses = await Promise.all(
        [c.counter.auth, c.cashier.auth].map((auth) =>
          http()
            .post(`${API}/tabs/${tab.id}/payments`)
            .set(as(auth))
            .send({ method: 'pix', amountCents: 5000 }),
        ),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const refused = responses.find((response) => response.status === 409);
      expect(['TAB_NOTHING_TO_PAY', 'PAYMENT_EXCEEDS_BALANCE']).toContain(
        refused ? errorOf(refused).code : '',
      );
      const payments = await platform.payment.findMany({ where: { tabId: tab.id } });
      expect(payments.reduce((sum, payment) => sum + payment.amountCents, 0)).toBe(5000);

      // A device with an old version of the tab gets TAB_CHANGED.
      const second = await billedTab(c, 2, 'Seu João');
      await pay(c, second.tab.id, { method: 'pix', amountCents: 500 });
      const details = await fails(
        'post',
        `/tabs/${second.tab.id}/payments`,
        c.counter.auth,
        { method: 'pix', amountCents: 500, version: second.tab.version },
        409,
        'TAB_CHANGED',
      );
      expect(details.currentVersion).toBe(second.tab.version + 1);
    });

    it('idempotency: a payment sent again with the same key is not duplicated', async () => {
      const c = await crew('Reenvio');
      await openRegister(c);
      const { tab } = await billedTab(c, 3);
      const key = crypto.randomUUID();
      const send = () =>
        http()
          .post(`${API}/tabs/${tab.id}/payments`)
          .set(as(c.counter.auth))
          .set('Idempotency-Key', key)
          .send({ method: 'cash', tenderedCents: 2000 });
      const first = await send();
      const again = await send();
      expect(first.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
      await expect(platform.payment.count({ where: { tabId: tab.id } })).resolves.toBe(1);
    });
  });

  describe('discount (section 3)', () => {
    it('CA-05.04, RN-05.03: 10% on a subtotal of R$ 92,50 gives a total of R$ 83,25', async () => {
      const c = await crew('Desconto', 925);
      const { tab } = await billedTab(c, 10);
      expect(tab.subtotalCents).toBe(9250);
      const discounted = await ok<TabDto>('put', `/tabs/${tab.id}/discount`, c.counter.auth, {
        type: 'percent',
        value: 10,
        reason: 'Cliente da casa',
      });
      expect(discounted).toMatchObject({
        discountType: 'percent',
        discountValue: 10,
        discountReason: 'Cliente da casa',
        discountCents: 925,
        totalCents: 8325,
        balanceCents: 8325,
        version: tab.version + 1,
      });
      // RN-05.01: applying again replaces; removing is registered.
      const replaced = await ok<TabDto>('put', `/tabs/${tab.id}/discount`, c.counter.auth, {
        type: 'amount',
        value: 1000,
        reason: 'Promoção',
      });
      expect(replaced).toMatchObject({ discountCents: 1000, totalCents: 8250 });
      const removed = await ok<TabDto>('delete', `/tabs/${tab.id}/discount`, c.counter.auth, {
        reason: 'Engano',
      });
      expect(removed).toMatchObject({ discountType: null, discountCents: 0, totalCents: 9250 });
      expect(await auditActions(tab.id)).toEqual(
        expect.arrayContaining(['tab.discount_applied', 'tab.discount_removed']),
      );
      // RN-05.03: an amount above the subtotal leaves the total at zero, never negative.
      const all = await ok<TabDto>('put', `/tabs/${tab.id}/discount`, c.counter.auth, {
        type: 'amount',
        value: 50_000,
        reason: 'Cortesia',
      });
      expect(all).toMatchObject({ discountCents: 9250, totalCents: 0 });
    });

    it('RN-05.01: percent from 1 to 100 and a reason; not below what was paid; not on a paid tab', async () => {
      const c = await crew('Limites do desconto');
      await openRegister(c);
      const { tab } = await billedTab(c, 4);
      await fails(
        'put',
        `/tabs/${tab.id}/discount`,
        c.counter.auth,
        { type: 'percent', value: 101, reason: 'x' },
        400,
        'VALIDATION_FAILED',
      );
      await fails(
        'put',
        `/tabs/${tab.id}/discount`,
        c.counter.auth,
        { type: 'amount', value: 100 },
        400,
        'VALIDATION_FAILED',
      );
      await pay(c, tab.id, { method: 'pix', amountCents: 3000 });
      await fails(
        'put',
        `/tabs/${tab.id}/discount`,
        c.counter.auth,
        { type: 'amount', value: 1500, reason: 'Desconto' },
        409,
        'TAB_PAYMENTS_EXCEED_TOTAL',
      );
      // A discount that leaves the balance at zero pays the tab (RN-05.10).
      const settled = await ok<TabDto>('put', `/tabs/${tab.id}/discount`, c.counter.auth, {
        type: 'amount',
        value: 1000,
        reason: 'Arredondar',
      });
      expect(settled).toMatchObject({ status: 'paid', totalCents: 3000, balanceCents: 0 });
      await fails(
        'delete',
        `/tabs/${tab.id}/discount`,
        c.counter.auth,
        { reason: 'Voltar' },
        409,
        'TAB_PAID',
      );
    });
  });

  describe('reversal (section 4.1)', () => {
    it('CA-05.05, RN-05.13 to RN-05.15: reversing a payment of a paid tab takes it back to closing with the balance', async () => {
      const c = await crew('Estorno');
      const register = await openRegister(c, 0);
      const { tab } = await billedTab(c, 3);
      await pay(c, tab.id, { method: 'pix', amountCents: 1000 });
      const cash = await pay(c, tab.id, { method: 'cash', tenderedCents: 5000 });
      expect(cash.tab.status).toBe('paid');
      await fails(
        'post',
        `/payments/${cash.payment.id}/reverse`,
        c.counter.auth,
        {},
        400,
        'VALIDATION_FAILED',
      );
      const reversed = await ok<PaymentResultDto>(
        'post',
        `/payments/${cash.payment.id}/reverse`,
        c.counter.auth,
        { reason: 'Cobrado errado' },
        200,
      );
      expect(reversed.payment).toMatchObject({
        reversalReason: 'Cobrado errado',
        reversedBy: { type: 'staff', id: c.counter.id },
      });
      expect(reversed.payment.reversedAt).not.toBeNull();
      expect(reversed.tab).toMatchObject({
        status: 'closing',
        paidCents: 1000,
        balanceCents: 2000,
        closedAt: null,
      });
      // The payment stays, marked; its value leaves the expected of the register.
      expect(reversed.tab.payments).toHaveLength(2);
      const after = await ok<CashRegisterDto>(
        'get',
        `/cash-registers/${register.id}`,
        c.cashier.auth,
      );
      expect(expectedOf(after)).toEqual({ ...ALL_ZERO, pix: 1000 });
      await fails(
        'post',
        `/payments/${cash.payment.id}/reverse`,
        c.counter.auth,
        { reason: 'De novo' },
        409,
        'PAYMENT_ALREADY_REVERSED',
      );
      expect(await auditActions(cash.payment.id)).toEqual(['payment.received', 'payment.reversed']);

      // RN-05.13: not after the register of the payment closed.
      const pix = reversed.tab.payments.find((payment) => payment.method === 'pix');
      await ok<CashRegisterDto>(
        'post',
        `/cash-registers/${register.id}/close`,
        c.cashier.auth,
        {
          counts: [
            { method: 'cash', informedCents: 0 },
            { method: 'pix', informedCents: 1000 },
            { method: 'credit_card', informedCents: 0 },
            { method: 'debit_card', informedCents: 0 },
          ],
        },
        200,
      );
      await fails(
        'post',
        `/payments/${pix?.id ?? ''}/reverse`,
        c.counter.auth,
        { reason: 'Tarde' },
        409,
        'CASH_REGISTER_CLOSED',
      );
    });

    it('RN-04.12: a tab with payments is not canceled; after the reversal it is', async () => {
      const c = await crew('Cancelar com pagamento');
      await openRegister(c);
      const { tab, order } = await billedTab(c, 1);
      const pix = await pay(c, tab.id, { method: 'pix', amountCents: 500 });
      const item = order.items[0];
      if (!item) {
        throw new Error('no item');
      }
      // Canceling the item would leave the total below what was paid.
      await fails(
        'post',
        `/order-items/${item.id}/cancel`,
        c.counter.auth,
        { version: item.version, reason: 'Desistiu' },
        409,
        'TAB_PAYMENTS_EXCEED_TOTAL',
      );
      await ok<PaymentResultDto>(
        'post',
        `/payments/${pix.payment.id}/reverse`,
        c.counter.auth,
        { reason: 'Desistiu' },
        200,
      );
      await ok<ItemChangeDto>(
        'post',
        `/order-items/${item.id}/cancel`,
        c.counter.auth,
        { version: item.version, reason: 'Desistiu' },
        200,
      );
      const canceled = await ok<TabDto>('post', `/tabs/${tab.id}/cancel`, c.counter.auth, {}, 200);
      expect(canceled.status).toBe('canceled');

      // With an active payment the cancel is refused.
      const other = await billedTab(c, 1, 'Seu João');
      const paid = await pay(c, other.tab.id, { method: 'pix', amountCents: 400 });
      const details = await fails(
        'post',
        `/tabs/${other.tab.id}/cancel`,
        c.counter.auth,
        {},
        409,
        'TAB_HAS_PAYMENTS',
      );
      expect(details.paymentIds).toEqual([paid.payment.id]);
    });
  });

  describe('paga antes (RN-05.12)', () => {
    it('CA-05.09: payments below the total write neither the order nor the payment', async () => {
      const c = await crew('Paga antes curto');
      await openRegister(c);
      const tabsBefore = await platform.tab.count({ where: { shiftId: c.shift.id } });
      const details = await fails(
        'post',
        `/shifts/${c.shift.id}/tabs/pay-first`,
        c.counter.auth,
        {
          customerName: 'Lucas',
          items: [skewers(c, 3)],
          payments: [{ method: 'pix', amountCents: 2000 }],
        },
        409,
        'PAYMENT_INSUFFICIENT',
      );
      expect(details).toMatchObject({ totalCents: 3000, paidCents: 2000 });
      await expect(platform.tab.count({ where: { shiftId: c.shift.id } })).resolves.toBe(
        tabsBefore,
      );
      await expect(platform.order.count({ where: { shiftId: c.shift.id } })).resolves.toBe(0);
      await expect(platform.payment.count({ where: { shiftId: c.shift.id } })).resolves.toBe(0);
      // CA-04.10: nothing reached the kitchen.
      const queue = await ok<StationQueueDto>(
        'get',
        `/stations/${c.setup.stations.kitchen}/queue`,
        c.kitchen.auth,
      );
      expect(queue.items).toEqual([]);
      // The tab number was not consumed either (the transaction rolled back).
      const next = await ok<TabDto>('post', `/shifts/${c.shift.id}/tabs`, c.counter.auth, {
        customerName: 'Depois',
      });
      expect(next.number).toBe(tabsBefore + 1);
    });

    it('CA-04.10: the tab is born paid and only then its items reach the kitchen; pix + cash with change', async () => {
      const c = await crew('Paga antes');
      await fails(
        'post',
        `/shifts/${c.shift.id}/tabs/pay-first`,
        c.counter.auth,
        {
          customerName: 'Lucas',
          items: [skewers(c, 3)],
          payments: [{ method: 'pix', amountCents: 3000 }],
        },
        409,
        'NO_CASH_REGISTER_OPEN',
      );
      await openRegister(c);
      const tab = await ok<TabDto>('post', `/shifts/${c.shift.id}/tabs/pay-first`, c.counter.auth, {
        customerName: 'Lucas',
        items: [skewers(c, 3)],
        payments: [
          { method: 'pix', amountCents: 1000 },
          { method: 'cash', tenderedCents: 5000 },
        ],
      });
      expect(tab).toMatchObject({
        mode: 'pay_first',
        status: 'paid',
        totalCents: 3000,
        paidCents: 3000,
        balanceCents: 0,
      });
      expect(
        tab.payments.map((payment) => [payment.method, payment.amountCents, payment.changeCents]),
      ).toEqual([
        ['pix', 1000, null],
        ['cash', 2000, 3000],
      ]);
      const queue = await ok<StationQueueDto>(
        'get',
        `/stations/${c.setup.stations.kitchen}/queue`,
        c.kitchen.auth,
      );
      expect(queue.items.map((item) => item.tabId)).toEqual([tab.id]);
      expect(await auditActions(tab.id)).toEqual(['tab.opened', 'tab.paid']);

      // RN-04.11: no other order and no reopening.
      await fails(
        'post',
        `/tabs/${tab.id}/orders`,
        c.counter.auth,
        { items: [skewers(c, 1)] },
        409,
        'TAB_CLOSED',
      );
      // A Pix above the total is refused (RN-05.08).
      await fails(
        'post',
        `/shifts/${c.shift.id}/tabs/pay-first`,
        c.counter.auth,
        {
          customerName: 'Ana',
          items: [skewers(c, 1)],
          payments: [{ method: 'pix', amountCents: 1001 }],
        },
        409,
        'PAYMENT_EXCEEDS_BALANCE',
      );
    });

    it('RN-04.28, RN-05.14: canceling an item after paying is a reversal, then cancel and receive again', async () => {
      const c = await crew('Paga antes estorno');
      await openRegister(c);
      const tab = await ok<TabDto>('post', `/shifts/${c.shift.id}/tabs/pay-first`, c.counter.auth, {
        customerName: 'Lucas',
        items: [skewers(c, 2), { productId: c.setup.products.soda, quantity: 1 }],
        payments: [{ method: 'pix', amountCents: 2600 }],
      });
      const soda = tab.orders[0]?.items.find((item) => item.productId === c.setup.products.soda);
      const payment = tab.payments[0];
      if (!soda || !payment) {
        throw new Error('missing data');
      }
      const details = await fails(
        'post',
        `/order-items/${soda.id}/cancel`,
        c.counter.auth,
        { version: soda.version, reason: 'Acabou' },
        409,
        'TAB_PAID',
      );
      expect(details.paymentIds).toEqual([payment.id]);
      const reversed = await ok<PaymentResultDto>(
        'post',
        `/payments/${payment.id}/reverse`,
        c.counter.auth,
        { reason: 'Refrigerante acabou' },
        200,
      );
      expect(reversed.tab).toMatchObject({ status: 'closing', balanceCents: 2600 });
      // A "paga antes" tab is not reopened for more orders.
      await fails('post', `/tabs/${tab.id}/reopen`, c.counter.auth, {}, 409, 'TAB_PAY_FIRST');
      await ok<ItemChangeDto>(
        'post',
        `/order-items/${soda.id}/cancel`,
        c.counter.auth,
        { version: soda.version, reason: 'Acabou' },
        200,
      );
      const again = await pay(c, tab.id, { method: 'debit_card', amountCents: 2000 });
      expect(again.tab).toMatchObject({ status: 'paid', totalCents: 2000, paidCents: 2000 });
    });
  });

  describe('cash registers (section 5)', () => {
    it('RN-05.16: only the owner and staff who operate cash open, move and close registers', async () => {
      const c = await crew('Permissões do caixa');
      await fails(
        'post',
        `/shifts/${c.shift.id}/cash-registers`,
        c.counter.auth,
        { openingFloatCents: 0 },
        403,
        'FORBIDDEN',
      );
      const register = await ok<CashRegisterDto>(
        'post',
        `/shifts/${c.shift.id}/cash-registers`,
        c.owner,
        { openingFloatCents: 0, name: 'Gaveta' },
      );
      expect(register).toMatchObject({ name: 'Gaveta', openedBy: { type: 'owner' } });
      await fails(
        'post',
        `/shifts/${c.shift.id}/cash-registers`,
        c.cashier.auth,
        { openingFloatCents: 0, name: 'gaveta' },
        409,
        'CASH_REGISTER_NAME_TAKEN',
      );
      for (const [method, path, body] of [
        ['get', `/cash-registers/${register.id}`, undefined],
        [
          'post',
          `/cash-registers/${register.id}/movements`,
          { type: 'deposit', amountCents: 100, reason: 'Troco' },
        ],
      ] as const) {
        await fails(method, path, c.counter.auth, body, 403, 'FORBIDDEN');
      }
      // The counter lists the registers (to choose one, RN-05.05); the kitchen does not.
      const list = await ok<{ data: CashRegisterDto[] }>(
        'get',
        `/shifts/${c.shift.id}/cash-registers`,
        c.counter.auth,
      );
      expect(list.data.map((row) => row.id)).toEqual([register.id]);
      await fails(
        'get',
        `/shifts/${c.shift.id}/cash-registers`,
        c.kitchen.auth,
        undefined,
        403,
        'FORBIDDEN',
      );
    });

    it('CA-05.06, RN-05.18, RN-05.19: float R$ 100, R$ 300 in cash, withdrawal R$ 200 and deposit R$ 50 expect R$ 250', async () => {
      const c = await crew('Esperado', 10_000);
      const register = await openRegister(c, 10_000);
      const { tab } = await billedTab(c, 3);
      await pay(c, tab.id, { method: 'cash', tenderedCents: 30_000 });
      await fails(
        'post',
        `/cash-registers/${register.id}/movements`,
        c.cashier.auth,
        { type: 'withdrawal', amountCents: 40_001, reason: 'Banco' },
        409,
        'WITHDRAWAL_EXCEEDS_CASH',
      );
      await fails(
        'post',
        `/cash-registers/${register.id}/movements`,
        c.cashier.auth,
        { type: 'withdrawal', amountCents: 100 },
        400,
        'VALIDATION_FAILED',
      );
      const withdrawal = await ok<CashRegisterDetailDto>(
        'post',
        `/cash-registers/${register.id}/movements`,
        c.cashier.auth,
        { type: 'withdrawal', amountCents: 20_000, reason: 'Sangria para o cofre' },
      );
      const deposit = await ok<CashRegisterDetailDto>(
        'post',
        `/cash-registers/${register.id}/movements`,
        c.cashier.auth,
        { type: 'deposit', amountCents: 5_000, reason: 'Mais troco', version: withdrawal.version },
      );
      expect(expectedOf(deposit)).toEqual({ ...ALL_ZERO, cash: 25_000 });
      expect(deposit.cash).toEqual({
        openingFloatCents: 10_000,
        paymentsCents: 30_000,
        depositsCents: 5_000,
        withdrawalsCents: 20_000,
      });
      expect(deposit.movements.map((movement) => movement.type)).toEqual(['withdrawal', 'deposit']);
      expect(deposit.payments).toHaveLength(1);
      // An old version of the register is a conflict.
      await fails(
        'post',
        `/cash-registers/${register.id}/movements`,
        c.cashier.auth,
        { type: 'deposit', amountCents: 100, reason: 'Troco', version: withdrawal.version },
        409,
        'VERSION_CONFLICT',
      );
      const movementId = deposit.movements[1]?.id ?? '';
      expect(await auditActions(movementId)).toEqual(['cash_register.deposit']);
    });

    it('CA-05.07, RN-05.20, RN-05.21: a difference needs a note; it is stored per method, credit and debit apart', async () => {
      const c = await crew('Conferência');
      const register = await openRegister(c, 5_000);
      const { tab } = await billedTab(c, 6);
      await pay(c, tab.id, { method: 'credit_card', amountCents: 2000 });
      await pay(c, tab.id, { method: 'debit_card', amountCents: 1500 });
      await pay(c, tab.id, { method: 'pix', amountCents: 1000 });
      await pay(c, tab.id, { method: 'cash', tenderedCents: 2000 });
      const counts = [
        { method: 'cash', informedCents: 6_400 },
        { method: 'pix', informedCents: 1_000 },
        { method: 'credit_card', informedCents: 2_000 },
        { method: 'debit_card', informedCents: 1_500 },
      ];
      const details = await fails(
        'post',
        `/cash-registers/${register.id}/close`,
        c.cashier.auth,
        { counts },
        400,
        'CLOSING_NOTE_REQUIRED',
      );
      expect(details.counts).toEqual([
        { method: 'cash', expectedCents: 6_500, informedCents: 6_400, differenceCents: -100 },
        { method: 'pix', expectedCents: 1_000, informedCents: 1_000, differenceCents: 0 },
        { method: 'credit_card', expectedCents: 2_000, informedCents: 2_000, differenceCents: 0 },
        { method: 'debit_card', expectedCents: 1_500, informedCents: 1_500, differenceCents: 0 },
      ]);
      await fails(
        'post',
        `/cash-registers/${register.id}/close`,
        c.cashier.auth,
        { counts: counts.slice(0, 3), note: 'x' },
        400,
        'VALIDATION_FAILED',
      );
      const closed = await ok<CashRegisterDto>(
        'post',
        `/cash-registers/${register.id}/close`,
        c.cashier.auth,
        { counts, note: 'Faltou R$ 1,00 de troco' },
        200,
      );
      expect(closed).toMatchObject({
        status: 'closed',
        closingNote: 'Faltou R$ 1,00 de troco',
        closedBy: { type: 'staff', id: c.cashier.id },
      });
      expect(closed.counts).toEqual(details.counts);
      await expect(
        platform.cashRegisterCount.count({ where: { cashRegisterId: register.id } }),
      ).resolves.toBe(4);
      expect(await auditActions(register.id)).toEqual([
        'cash_register.opened',
        'cash_register.closed',
      ]);
      // RN-05.21: closed for good.
      await fails(
        'post',
        `/cash-registers/${register.id}/movements`,
        c.cashier.auth,
        { type: 'deposit', amountCents: 100, reason: 'Troco' },
        409,
        'CASH_REGISTER_CLOSED',
      );
      await fails(
        'post',
        `/cash-registers/${register.id}/close`,
        c.cashier.auth,
        { counts, note: 'De novo' },
        409,
        'CASH_REGISTER_CLOSED',
      );
    });

    it('RN-04.07: the shift closes only with every register closed (details.cashRegisters)', async () => {
      const c = await crew('Fechar turno');
      const register = await openRegister(c, 0);
      const details = await fails(
        'post',
        `/shifts/${c.shift.id}/close`,
        c.owner,
        undefined,
        409,
        'SHIFT_HAS_PENDING_ITEMS',
      );
      expect(details).toEqual({ tabs: [], cashRegisters: [{ id: register.id, name: 'Caixa 1' }] });
      await ok<CashRegisterDto>(
        'post',
        `/cash-registers/${register.id}/close`,
        c.cashier.auth,
        {
          counts: ['cash', 'pix', 'credit_card', 'debit_card'].map((method) => ({
            method,
            informedCents: 0,
          })),
        },
        200,
      );
      const closed = await ok<ShiftDto>(
        'post',
        `/shifts/${c.shift.id}/close`,
        c.owner,
        undefined,
        200,
      );
      expect(closed.status).toBe('closed');
      // No register opens in a closed shift.
      await fails(
        'post',
        `/shifts/${c.shift.id}/cash-registers`,
        c.owner,
        { openingFloatCents: 0 },
        409,
        'SHIFT_CLOSED',
      );
    });

    it('idempotency: a movement sent again with the same key is not duplicated', async () => {
      const c = await crew('Movimento reenviado');
      const register = await openRegister(c, 0);
      const key = crypto.randomUUID();
      for (let attempt = 0; attempt < 2; attempt++) {
        await ok<CashRegisterDetailDto>(
          'post',
          `/cash-registers/${register.id}/movements`,
          c.cashier.auth,
          { type: 'deposit', amountCents: 1000, reason: 'Troco' },
          201,
          { 'Idempotency-Key': key },
        );
      }
      await expect(
        platform.cashMovement.count({ where: { cashRegisterId: register.id } }),
      ).resolves.toBe(1);
    });
  });

  describe('phase 5 adjustments', () => {
    it('the counter and the stations read the workflow of their unit; only the owner writes it', async () => {
      const c = await crew('Fluxo');
      const unitId = c.setup.tenant.unitId;
      const workflow = await ok<{ stages: { id: string }[]; version: number }>(
        'get',
        `/units/${unitId}/workflow`,
        c.counter.auth,
      );
      expect(workflow.stages).toHaveLength(4);
      await ok('get', `/units/${unitId}/workflow`, c.kitchen.auth);
      await fails(
        'put',
        `/units/${unitId}/workflow`,
        c.counter.auth,
        { stages: [] },
        403,
        'FORBIDDEN',
      );
      // Staff of another unit of the organization: 403.
      const otherUnit = await platform.unit.create({
        data: { organizationId: c.setup.tenant.organizationId, name: 'Outra barraca' },
      });
      await fails(
        'get',
        `/units/${otherUnit.id}/workflow`,
        c.counter.auth,
        undefined,
        403,
        'FORBIDDEN',
      );
    });
  });

  describe('admin metrics (spec 02, section 6)', () => {
    it('counts the paid tabs, their value (with discount) and the average ticket', async () => {
      const c = await crew('Métricas pagas', 925);
      await openRegister(c, 0);
      const { tab } = await billedTab(c, 10);
      await ok<TabDto>('put', `/tabs/${tab.id}/discount`, c.counter.auth, {
        type: 'percent',
        value: 10,
        reason: 'Casa',
      });
      await pay(c, tab.id, { method: 'pix', amountCents: 8325 });
      const second = await ok<TabDto>(
        'post',
        `/shifts/${c.shift.id}/tabs/pay-first`,
        c.counter.auth,
        {
          customerName: 'Lucas',
          items: [{ productId: c.setup.products.soda, quantity: 2 }],
          payments: [{ method: 'cash', tenderedCents: 2000 }],
        },
      );
      expect(second.totalCents).toBe(1200);
      // An open tab does not count.
      await billedTab(c, 1, 'Ainda aberta');
      const metrics = app.get(MetricsService);
      const usage = await metrics.organizations(resolvePeriod({}), 'name', 'asc');
      const row = usage.data.find((item) => item.organizationId === c.setup.tenant.organizationId);
      expect(row).toMatchObject({ tabs: 2, soldCents: 8325 + 1200, shifts: 0 });
      const overview = await metrics.overview(resolvePeriod({}));
      expect(overview.tabs).toBeGreaterThanOrEqual(2);
      expect(overview.averageTicketCents).toBe(Math.round(overview.soldCents / overview.tabs));
    });
  });

  describe('tenant isolation (CA-01.02)', () => {
    let a: Crew;
    let b: Crew;
    let ctx: IsolationContext;
    let register: CashRegisterDto;
    let payment: PaymentResultDto;
    let tabId: string;

    beforeAll(async () => {
      a = await crew('Caixa A');
      b = await crew('Caixa B');
      register = await openRegister(a, 0);
      const { tab } = await billedTab(a, 2);
      tabId = tab.id;
      payment = await pay(a, tab.id, { method: 'pix', amountCents: 500 });
      ctx = { prisma: app.get(PrismaService), tenantA: a.setup.tenant, tenantB: b.setup.tenant };
    });

    it('organization B gets 404 on every route with ids of A, and changes nothing', async () => {
      const routes: { method: 'get' | 'post' | 'put' | 'delete'; path: string; body?: object }[] = [
        {
          method: 'put',
          path: `/tabs/${tabId}/discount`,
          body: { type: 'amount', value: 1, reason: 'x' },
        },
        { method: 'delete', path: `/tabs/${tabId}/discount`, body: { reason: 'x' } },
        {
          method: 'post',
          path: `/tabs/${tabId}/payments`,
          body: { method: 'pix', amountCents: 1 },
        },
        { method: 'post', path: `/payments/${payment.payment.id}/reverse`, body: { reason: 'x' } },
        {
          method: 'post',
          path: `/shifts/${a.shift.id}/tabs/pay-first`,
          body: { customerName: 'x', items: [skewers(a, 1)], payments: [] },
        },
        {
          method: 'post',
          path: `/shifts/${a.shift.id}/cash-registers`,
          body: { openingFloatCents: 0 },
        },
        { method: 'get', path: `/shifts/${a.shift.id}/cash-registers` },
        { method: 'get', path: `/cash-registers/${register.id}` },
        {
          method: 'post',
          path: `/cash-registers/${register.id}/movements`,
          body: { type: 'deposit', amountCents: 1, reason: 'x' },
        },
        {
          method: 'post',
          path: `/cash-registers/${register.id}/close`,
          body: {
            counts: ['cash', 'pix', 'credit_card', 'debit_card'].map((method) => ({
              method,
              informedCents: 0,
            })),
            note: 'x',
          },
        },
        { method: 'get', path: `/units/${a.setup.tenant.unitId}/workflow` },
      ];
      for (const route of routes) {
        for (const auth of [b.owner, b.cashier.auth]) {
          await expectNotFoundForOtherTenant(app, {
            method: route.method,
            path: `${API}${route.path}`,
            as: auth,
            ...(route.body === undefined ? {} : { body: route.body }),
          });
        }
      }
      await expect(platform.payment.count({ where: { tabId } })).resolves.toBe(1);
      await expect(
        platform.cashRegister.findUniqueOrThrow({ where: { id: register.id } }),
      ).resolves.toMatchObject({ status: 'open' });
      await expect(platform.tab.findUniqueOrThrow({ where: { id: tabId } })).resolves.toMatchObject(
        {
          discountType: null,
        },
      );
    });

    async function closedShift(db: TenantDb, tenant: Tenant) {
      return db.shift.create({
        data: {
          organizationId: requireOrganizationId(),
          unitId: tenant.unitId,
          type: 'direct_sale',
          status: 'closed',
          openedByType: 'owner',
          openedAt: new Date(),
          closedAt: new Date(),
        },
      });
    }

    async function registerOf(db: TenantDb, tenant: Tenant) {
      const shift = await closedShift(db, tenant);
      return db.cashRegister.create({
        data: {
          organizationId: requireOrganizationId(),
          shiftId: shift.id,
          unitId: tenant.unitId,
          name: 'Caixa',
          openingFloatCents: 0,
          openedByType: 'owner',
          openedAt: new Date(),
        },
      });
    }

    describeTenantIsolation('CashRegister', {
      context: () => ctx,
      delegate: (db) => db.cashRegister,
      create: (db, tenant) => registerOf(db, tenant),
      update: { name: 'Invadido' },
    });

    describeTenantIsolation('CashMovement', {
      context: () => ctx,
      delegate: (db) => db.cashMovement,
      create: async (db, tenant) => {
        const cashRegister = await registerOf(db, tenant);
        return db.cashMovement.create({
          data: {
            organizationId: requireOrganizationId(),
            cashRegisterId: cashRegister.id,
            type: 'deposit',
            amountCents: 100,
            reason: 'Troco',
            createdByType: 'owner',
          },
        });
      },
      update: { reason: 'Invadido' },
    });

    describeTenantIsolation('CashRegisterCount', {
      context: () => ctx,
      delegate: (db) => db.cashRegisterCount,
      create: async (db, tenant) => {
        const cashRegister = await registerOf(db, tenant);
        return db.cashRegisterCount.create({
          data: {
            organizationId: requireOrganizationId(),
            cashRegisterId: cashRegister.id,
            method: 'pix',
            expectedCents: 0,
            informedCents: 0,
            differenceCents: 0,
          },
        });
      },
      update: { informedCents: 0 },
    });

    describeTenantIsolation('Payment', {
      context: () => ctx,
      delegate: (db) => db.payment,
      create: async (db, tenant) => {
        const cashRegister = await registerOf(db, tenant);
        const tab = await db.tab.create({
          data: {
            organizationId: requireOrganizationId(),
            shiftId: cashRegister.shiftId,
            unitId: tenant.unitId,
            number: 1,
            customerName: 'Cliente',
            mode: 'open_tab',
            status: 'paid',
            openedByType: 'owner',
          },
        });
        return db.payment.create({
          data: {
            organizationId: requireOrganizationId(),
            tabId: tab.id,
            shiftId: cashRegister.shiftId,
            cashRegisterId: cashRegister.id,
            method: 'pix',
            amountCents: 100,
            receivedByType: 'owner',
          },
        });
      },
      update: { reversalReason: null },
    });

    it('the tenant client never reads payments of another organization in raw totals', async () => {
      const rows = await runWithContext(systemContext({ auth: b.owner }), async () =>
        app.get(PrismaService).db.payment.findMany({ where: { tabId } }),
      );
      expect(rows).toEqual([]);
    });
  });
});
