import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { MetricsService, resolvePeriod } from '../../src/admin/metrics/metrics.service.js';
import { dateColumn, todayInSaoPaulo } from '../../src/common/time.js';
import {
  type AuthContext,
  requireOrganizationId,
  runWithContext,
  systemContext,
} from '../../src/context/request-context.js';
import type {
  CashRegisterDto,
  CashRegisterSessionDetailDto,
  CashRegisterSessionDto,
  ClosePreviewDto,
  PaymentResultDto,
} from '../../src/operation/cash.schemas.js';
import type { ContractedEventDto } from '../../src/operation/events.schemas.js';
import type {
  ItemChangeDto,
  OrderDto,
  StationQueueDto,
  TabDto,
  TabSummaryDto,
} from '../../src/operation/operation.schemas.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { PrismaService, type TenantDb } from '../../src/prisma/prisma.service.js';
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
}

const ALL_ZERO = { cash: 0, pix: 0, credit_card: 0, debit_card: 0 };
const METHODS = ['cash', 'pix', 'credit_card', 'debit_card'] as const;

function zeroCounts(cash = 0) {
  return METHODS.map((method) => ({ method, informedCents: method === 'cash' ? cash : 0 }));
}

function today(): string {
  return todayInSaoPaulo().toString();
}

function yesterday(): Date {
  return dateColumn(todayInSaoPaulo().subtract({ days: 1 }));
}

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

  /** A unit with "Caixa 1" (closed) where the skewer costs `skewerCents` (normal price). */
  async function crew(label: string, skewerCents = 1000): Promise<Crew> {
    const tenant = await createTenant(platform, label);
    const setup = await setupOperation(platform, tenant);
    await platform.product.update({
      where: { id: setup.products.skewer },
      data: { priceCents: skewerCents },
    });
    const { stations } = setup;
    return {
      setup,
      owner: tenant.ownerAuth,
      cashier: await createStaff(platform, tenant, [stations.counter, stations.delivery], {
        canOperateCash: true,
      }),
      counter: await createStaff(platform, tenant, [stations.counter]),
      kitchen: await createStaff(platform, tenant, [stations.kitchen]),
    };
  }

  async function ok<T>(
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
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
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
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

  /** Opens `registerId` (default "Caixa 1"); returns the register with its new session. */
  function openRegister(
    c: Crew,
    openingFloatCents = 10_000,
    registerId = c.setup.register,
    auth = c.cashier.auth,
  ) {
    return ok<CashRegisterDto>('post', `/cash-registers/${registerId}/open`, auth, {
      openingFloatCents,
    });
  }

  function sessionOf(register: CashRegisterDto): CashRegisterSessionDto {
    if (!register.session) {
      throw new Error('register without session');
    }
    return register.session;
  }

  /** A new register of the unit, registered by the owner (RN-05.17). */
  function newRegister(c: Crew, name: string) {
    return ok<CashRegisterDto>('post', `/units/${c.setup.tenant.unitId}/cash-registers`, c.owner, {
      name,
    });
  }

  function closeSession(c: Crew, sessionId: string, body: object = { counts: zeroCounts() }) {
    return ok<CashRegisterDto>(
      'post',
      `/cash-register-sessions/${sessionId}/close`,
      c.cashier.auth,
      body,
      200,
    );
  }

  function session(c: Crew, sessionId: string) {
    return ok<CashRegisterSessionDetailDto>(
      'get',
      `/cash-register-sessions/${sessionId}`,
      c.cashier.auth,
    );
  }

  /** An open tab with `quantity` skewers, already in `closing` (pedir a conta). */
  async function billedTab(c: Crew, quantity: number, customerName = 'Dona Marta') {
    const tab = await ok<TabDto>('post', `/units/${c.setup.tenant.unitId}/tabs`, c.counter.auth, {
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

  function expectedOf(row: CashRegisterSessionDto): Record<string, number> {
    return Object.fromEntries(row.expected.map((line) => [line.method, line.expectedCents]));
  }

  async function auditActions(entityId: string): Promise<string[]> {
    const rows = await platform.auditLog.findMany({
      where: { entityId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => row.action);
  }

  describe('payments (section 4)', () => {
    it('CA-05.08, RN-05.06: without an open register the payment is refused (NO_CASH_REGISTER_OPEN)', async () => {
      const c = await crew('Sem caixa');
      const opened = await openRegister(c);
      const { tab } = await billedTab(c, 2);
      // RN-05.28: the tab does not stop the closing and stays open.
      await closeSession(c, sessionOf(opened).id, { counts: zeroCounts(10_000) });
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
      expect(cash.payment).toMatchObject({
        amountCents: 3000,
        changeCents: 0,
        cashRegisterId: c.setup.register,
        cashRegisterName: 'Caixa 1',
      });
      expect(cash.tab).toMatchObject({
        status: 'paid',
        paidCents: 8000,
        balanceCents: 0,
        closedBusinessDate: today(),
      });
      expect(cash.tab.closedAt).not.toBeNull();
      expect(cash.tab.payments.map((payment) => payment.method)).toEqual(['pix', 'cash']);

      const varal = await ok<{ data: TabSummaryDto[] }>(
        'get',
        `/units/${c.setup.tenant.unitId}/tabs`,
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
      const tab = await ok<TabDto>('post', `/units/${c.setup.tenant.unitId}/tabs`, c.counter.auth, {
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

    it('RN-05.05: with more than one open register the counter chooses; the register must be of the unit and open', async () => {
      const c = await crew('Dois caixas');
      const second = await newRegister(c, 'Caixa 2');
      const first = await openRegister(c);
      const secondOpen = await openRegister(c, 0, second.id);
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
      expect(paid.payment).toMatchObject({
        cashRegisterId: second.id,
        cashRegisterSessionId: sessionOf(secondOpen).id,
      });

      // A register of another unit is refused.
      const other = await crew('Outra unidade');
      await fails(
        'post',
        `/tabs/${tab.id}/payments`,
        c.counter.auth,
        { method: 'pix', amountCents: 1000, cashRegisterId: other.setup.register },
        400,
        'INVALID_CASH_REGISTER',
      );
      // A closed register takes no payment (RN-05.21).
      await closeSession(c, sessionOf(first).id, { counts: zeroCounts(10_000) });
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
      await openRegister(c);
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
    it('CA-05.05, CA-05.13, RN-05.13 to RN-05.15: reversing takes a paid tab back to closing; not after the session closed', async () => {
      const c = await crew('Estorno');
      const register = await openRegister(c, 0);
      const sessionId = sessionOf(register).id;
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
        closedBusinessDate: null,
      });
      // The payment stays, marked; its value leaves the expected of the session.
      expect(reversed.tab.payments).toHaveLength(2);
      expect(expectedOf(await session(c, sessionId))).toEqual({ ...ALL_ZERO, pix: 1000 });
      await fails(
        'post',
        `/payments/${cash.payment.id}/reverse`,
        c.counter.auth,
        { reason: 'De novo' },
        409,
        'PAYMENT_ALREADY_REVERSED',
      );
      expect(await auditActions(cash.payment.id)).toEqual(['payment.received', 'payment.reversed']);

      // CA-05.13: not after the session of the payment closed, even with another register open.
      const pix = reversed.tab.payments.find((payment) => payment.method === 'pix');
      await closeSession(c, sessionId, {
        counts: [
          { method: 'cash', informedCents: 0 },
          { method: 'pix', informedCents: 1000 },
          { method: 'credit_card', informedCents: 0 },
          { method: 'debit_card', informedCents: 0 },
        ],
      });
      await openRegister(c, 0);
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
      expect(canceled).toMatchObject({ status: 'canceled', closedBusinessDate: today() });

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
      const unitId = c.setup.tenant.unitId;
      const tabsBefore = await platform.tab.count({ where: { unitId } });
      const details = await fails(
        'post',
        `/units/${unitId}/tabs/pay-first`,
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
      await expect(platform.tab.count({ where: { unitId } })).resolves.toBe(tabsBefore);
      await expect(platform.order.count({ where: { tab: { unitId } } })).resolves.toBe(0);
      await expect(platform.payment.count({ where: { tab: { unitId } } })).resolves.toBe(0);
      // CA-04.10: nothing reached the kitchen.
      const queue = await ok<StationQueueDto>(
        'get',
        `/stations/${c.setup.stations.kitchen}/queue`,
        c.kitchen.auth,
      );
      expect(queue.orders).toEqual([]);
      // The tab number was not consumed either (the transaction rolled back).
      const next = await ok<TabDto>('post', `/units/${unitId}/tabs`, c.counter.auth, {
        customerName: 'Depois',
      });
      expect(next.number).toBe(tabsBefore + 1);
    });

    it('CA-04.10: the tab is born paid and only then its items reach the kitchen; pix + cash with change', async () => {
      const c = await crew('Paga antes');
      const unitId = c.setup.tenant.unitId;
      await fails(
        'post',
        `/units/${unitId}/tabs/pay-first`,
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
      const tab = await ok<TabDto>('post', `/units/${unitId}/tabs/pay-first`, c.counter.auth, {
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
        businessDate: today(),
        closedBusinessDate: today(),
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
      expect(queue.orders.map((order) => order.tabId)).toEqual([tab.id]);
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
        `/units/${unitId}/tabs/pay-first`,
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
      const tab = await ok<TabDto>(
        'post',
        `/units/${c.setup.tenant.unitId}/tabs/pay-first`,
        c.counter.auth,
        {
          customerName: 'Lucas',
          items: [skewers(c, 2), { productId: c.setup.products.soda, quantity: 1 }],
          payments: [{ method: 'pix', amountCents: 2600 }],
        },
      );
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

  describe('cash registers of the unit (section 5.1)', () => {
    it('RN-05.17, RN-05.27, CA-05.14: the owner registers, renames and deactivates; not an open one nor the last active one', async () => {
      const c = await crew('Cadastro de caixas');
      const unitId = c.setup.tenant.unitId;
      await fails(
        'post',
        `/units/${unitId}/cash-registers`,
        c.cashier.auth,
        { name: 'Balcão' },
        403,
        'FORBIDDEN',
      );
      const balcao = await newRegister(c, 'Balcão');
      expect(balcao).toMatchObject({ name: 'Balcão', active: true, session: null, sortOrder: 2 });
      await fails(
        'post',
        `/units/${unitId}/cash-registers`,
        c.owner,
        { name: 'caixa 1' },
        409,
        'CASH_REGISTER_NAME_TAKEN',
      );
      const renamed = await ok<CashRegisterDto>('patch', `/cash-registers/${balcao.id}`, c.owner, {
        name: 'Balcão de fora',
      });
      expect(renamed.name).toBe('Balcão de fora');
      expect(await auditActions(balcao.id)).toEqual([
        'cash_register.created',
        'cash_register.updated',
      ]);

      // CA-05.14: an open register is not deactivated.
      await openRegister(c, 0, balcao.id);
      await fails(
        'patch',
        `/cash-registers/${balcao.id}`,
        c.owner,
        { active: false },
        409,
        'CASH_REGISTER_OPEN',
      );
      // Caixa 1 (closed) is deactivated; then Balcão is the last active one.
      const inactive = await ok<CashRegisterDto>(
        'patch',
        `/cash-registers/${c.setup.register}`,
        c.owner,
        { active: false },
      );
      expect(inactive.active).toBe(false);
      const balcaoNow = await ok<{ data: CashRegisterDto[] }>(
        'get',
        `/units/${unitId}/cash-registers`,
        c.owner,
      );
      const session = balcaoNow.data.find((row) => row.id === balcao.id)?.session;
      await closeSession(c, session?.id ?? '');
      await fails(
        'patch',
        `/cash-registers/${balcao.id}`,
        c.owner,
        { active: false },
        409,
        'LAST_ACTIVE_CASH_REGISTER',
      );
      // An inactive register is not opened (RN-05.27).
      await fails(
        'post',
        `/cash-registers/${c.setup.register}/open`,
        c.cashier.auth,
        { openingFloatCents: 0 },
        409,
        'CASH_REGISTER_INACTIVE',
      );
      // Staff lists only the active ones; the owner sees all.
      const staffList = await ok<{ data: CashRegisterDto[] }>(
        'get',
        `/units/${unitId}/cash-registers`,
        c.cashier.auth,
      );
      expect(staffList.data.map((row) => row.id)).toEqual([balcao.id]);
    });
  });

  describe('opening and closing (sections 5.2 to 5.4)', () => {
    it('RN-05.16: only the owner and staff who operate cash open, move and close registers', async () => {
      const c = await crew('Permissões do caixa');
      await fails(
        'post',
        `/cash-registers/${c.setup.register}/open`,
        c.counter.auth,
        { openingFloatCents: 0 },
        403,
        'FORBIDDEN',
      );
      const register = await openRegister(c, 0, c.setup.register, c.owner);
      const sessionId = sessionOf(register).id;
      expect(register.session).toMatchObject({
        status: 'open',
        name: 'Caixa 1',
        openedBy: { type: 'owner' },
        businessDate: today(),
      });
      for (const [method, path, body] of [
        ['get', `/cash-register-sessions/${sessionId}`, undefined],
        ['get', `/cash-register-sessions/${sessionId}/close-preview`, undefined],
        [
          'post',
          `/cash-register-sessions/${sessionId}/movements`,
          { type: 'deposit', amountCents: 100, reason: 'Troco' },
        ],
        ['post', `/cash-register-sessions/${sessionId}/close`, { counts: zeroCounts() }],
      ] as const) {
        await fails(method, path, c.counter.auth, body, 403, 'FORBIDDEN');
      }
      // The counter lists the registers (to choose one, RN-05.05); the kitchen does not.
      const list = await ok<{ data: CashRegisterDto[] }>(
        'get',
        `/units/${c.setup.tenant.unitId}/cash-registers`,
        c.counter.auth,
      );
      expect(list.data.map((row) => row.id)).toEqual([c.setup.register]);
      await fails(
        'get',
        `/units/${c.setup.tenant.unitId}/cash-registers`,
        c.kitchen.auth,
        undefined,
        403,
        'FORBIDDEN',
      );
    });

    it('CA-05.10, RN-05.23: "Caixa 1" already open is refused; "Caixa 2" opens at the same time', async () => {
      const c = await crew('Dois abertos');
      const second = await newRegister(c, 'Caixa 2');
      await openRegister(c);
      const details = await fails(
        'post',
        `/cash-registers/${c.setup.register}/open`,
        c.cashier.auth,
        { openingFloatCents: 0 },
        409,
        'CASH_REGISTER_ALREADY_OPEN',
      );
      expect(details.sessionId).toEqual(expect.any(String));
      const opened = await openRegister(c, 500, second.id);
      expect(opened.session).toMatchObject({ status: 'open', openingFloatCents: 500 });
      await expect(
        platform.cashRegisterSession.count({
          where: { unitId: c.setup.tenant.unitId, status: 'open' },
        }),
      ).resolves.toBe(2);
    });

    it('RN-05.24, CA-02.05: inactive unit and suspended organization do not open; an open register keeps working and closes', async () => {
      const c = await crew('Suspensa');
      const register = await openRegister(c);
      const { tab } = await billedTab(c, 1);
      await platform.organization.update({
        where: { id: c.setup.tenant.organizationId },
        data: { subscriptionStatus: 'suspended' },
      });
      const second = await newRegister(c, 'Caixa 2');
      await fails(
        'post',
        `/cash-registers/${second.id}/open`,
        c.cashier.auth,
        { openingFloatCents: 0 },
        409,
        'ORGANIZATION_SUSPENDED',
      );
      // The open register still receives and closes (RN-01.01).
      await pay(c, tab.id, { method: 'pix', amountCents: 1000 });
      await closeSession(c, sessionOf(register).id, {
        counts: [
          { method: 'cash', informedCents: 10_000 },
          { method: 'pix', informedCents: 1000 },
          { method: 'credit_card', informedCents: 0 },
          { method: 'debit_card', informedCents: 0 },
        ],
      });

      const d = await crew('Unidade inativa');
      await platform.unit.update({ where: { id: d.setup.tenant.unitId }, data: { active: false } });
      await fails(
        'post',
        `/cash-registers/${d.setup.register}/open`,
        d.owner,
        { openingFloatCents: 0 },
        409,
        'UNIT_INACTIVE',
      );
    });

    it('CA-05.12: opening again creates a new session with its own float; new payments go to it and the old one does not change', async () => {
      const c = await crew('Reabrir');
      const first = await openRegister(c, 5_000);
      const firstSession = sessionOf(first).id;
      const a = await billedTab(c, 2, 'Almoço');
      await pay(c, a.tab.id, { method: 'pix', amountCents: 2000 });
      await closeSession(c, firstSession, {
        counts: [
          { method: 'cash', informedCents: 5_000 },
          { method: 'pix', informedCents: 2_000 },
          { method: 'credit_card', informedCents: 0 },
          { method: 'debit_card', informedCents: 0 },
        ],
      });
      const before = await session(c, firstSession);

      const again = await openRegister(c, 3_000);
      const secondSession = sessionOf(again).id;
      expect(secondSession).not.toBe(firstSession);
      expect(again.session).toMatchObject({ openingFloatCents: 3_000, status: 'open' });
      const b = await billedTab(c, 1, 'Jantar');
      const paid = await pay(c, b.tab.id, { method: 'cash', tenderedCents: 1000 });
      expect(paid.payment.cashRegisterSessionId).toBe(secondSession);
      expect(await session(c, firstSession)).toEqual(before);
      // RN-05.23: the next opening suggests the float of the previous one.
      const list = await ok<{ data: CashRegisterDto[] }>(
        'get',
        `/units/${c.setup.tenant.unitId}/cash-registers`,
        c.cashier.auth,
      );
      expect(list.data[0]).toMatchObject({ suggestedOpeningFloatCents: 3_000 });
    });

    it('RN-05.26: a session of an earlier day shows "aberto desde ontem"', async () => {
      const c = await crew('Esquecido');
      const register = await openRegister(c);
      expect(register.session?.openSinceEarlierDay).toBe(false);
      await platform.cashRegisterSession.update({
        where: { id: sessionOf(register).id },
        data: { businessDate: yesterday() },
      });
      const list = await ok<{ data: CashRegisterDto[] }>(
        'get',
        `/units/${c.setup.tenant.unitId}/cash-registers`,
        c.cashier.auth,
      );
      expect(list.data[0]?.session?.openSinceEarlierDay).toBe(true);
    });

    it('CA-05.06, RN-05.18, RN-05.19: float R$ 100, R$ 300 in cash, withdrawal R$ 200 and deposit R$ 50 expect R$ 250', async () => {
      const c = await crew('Esperado', 10_000);
      const register = await openRegister(c, 10_000);
      const sessionId = sessionOf(register).id;
      const { tab } = await billedTab(c, 3);
      await pay(c, tab.id, { method: 'cash', tenderedCents: 30_000 });
      await fails(
        'post',
        `/cash-register-sessions/${sessionId}/movements`,
        c.cashier.auth,
        { type: 'withdrawal', amountCents: 40_001, reason: 'Banco' },
        409,
        'WITHDRAWAL_EXCEEDS_CASH',
      );
      await fails(
        'post',
        `/cash-register-sessions/${sessionId}/movements`,
        c.cashier.auth,
        { type: 'withdrawal', amountCents: 100 },
        400,
        'VALIDATION_FAILED',
      );
      const withdrawal = await ok<CashRegisterSessionDetailDto>(
        'post',
        `/cash-register-sessions/${sessionId}/movements`,
        c.cashier.auth,
        { type: 'withdrawal', amountCents: 20_000, reason: 'Sangria para o cofre' },
      );
      const deposit = await ok<CashRegisterSessionDetailDto>(
        'post',
        `/cash-register-sessions/${sessionId}/movements`,
        c.cashier.auth,
        { type: 'deposit', amountCents: 5_000, reason: 'Mais troco', version: withdrawal.version },
      );
      expect(expectedOf(deposit)).toEqual({ ...ALL_ZERO, cash: 25_000 });
      expect(deposit.cash).toEqual({
        openingFloatCents: 10_000,
        paymentsCents: 30_000,
        creditSettlementsCents: 0,
        depositsCents: 5_000,
        withdrawalsCents: 20_000,
      });
      expect(deposit.movements.map((movement) => movement.type)).toEqual(['withdrawal', 'deposit']);
      expect(deposit.payments).toHaveLength(1);
      // An old version of the session is a conflict.
      await fails(
        'post',
        `/cash-register-sessions/${sessionId}/movements`,
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
      const sessionId = sessionOf(register).id;
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
        `/cash-register-sessions/${sessionId}/close`,
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
        `/cash-register-sessions/${sessionId}/close`,
        c.cashier.auth,
        { counts: counts.slice(0, 3), note: 'x' },
        400,
        'VALIDATION_FAILED',
      );
      const closed = await closeSession(c, sessionId, { counts, note: 'Faltou R$ 1,00 de troco' });
      expect(closed.session).toMatchObject({
        id: sessionId,
        status: 'closed',
        closingNote: 'Faltou R$ 1,00 de troco',
        closedBy: { type: 'staff', id: c.cashier.id },
        differenceCents: -100,
      });
      // RN-05.22: each count also shows the settlements of tabs on credit (none here).
      expect(closed.session?.counts).toEqual(
        (details.counts as object[]).map((row) => ({ ...row, creditSettlementsCents: 0 })),
      );
      await expect(
        platform.cashRegisterCount.count({ where: { cashRegisterSessionId: sessionId } }),
      ).resolves.toBe(4);
      expect(await auditActions(sessionId)).toEqual([
        'cash_register.opened',
        'cash_register.closed',
      ]);
      // RN-05.21: closed for good.
      await fails(
        'post',
        `/cash-register-sessions/${sessionId}/movements`,
        c.cashier.auth,
        { type: 'deposit', amountCents: 100, reason: 'Troco' },
        409,
        'CASH_REGISTER_CLOSED',
      );
      await fails(
        'post',
        `/cash-register-sessions/${sessionId}/close`,
        c.cashier.auth,
        { counts, note: 'De novo' },
        409,
        'CASH_REGISTER_CLOSED',
      );
    });

    it('CA-05.11, RN-05.28: closing with two open tabs records 2 pending with their total; the tabs stay open', async () => {
      const c = await crew('Pendentes');
      const register = await openRegister(c, 0);
      const sessionId = sessionOf(register).id;
      const a = await billedTab(c, 2, 'Mesa 1');
      const b = await ok<TabDto>('post', `/units/${c.setup.tenant.unitId}/tabs`, c.counter.auth, {
        customerName: 'Mesa 2',
      });
      await ok<OrderDto>('post', `/tabs/${b.id}/orders`, c.counter.auth, {
        items: [skewers(c, 1)],
      });
      const preview = await ok<ClosePreviewDto>(
        'get',
        `/cash-register-sessions/${sessionId}/close-preview`,
        c.cashier.auth,
      );
      expect(preview.pendingTabs.map((tab) => tab.number)).toEqual([a.tab.number, b.number]);
      expect(preview.pendingTabsTotalCents).toBe(3000);
      expect(preview.lastOpenRegister).toBe(true);
      const closed = await closeSession(c, sessionId, {
        counts: zeroCounts(),
        finishPendingItems: false,
      });
      expect(closed.session).toMatchObject({ pendingTabsCount: 2, pendingTabsTotalCents: 3000 });
      const tabs = await platform.tab.findMany({
        where: { id: { in: [a.tab.id, b.id] } },
        orderBy: { number: 'asc' },
      });
      expect(tabs.map((tab) => tab.status)).toEqual(['closing', 'open']);
    });

    it('RN-05.29, RN-04.08: closing the last register shows the items in preparation and the event; finishEvent finishes it', async () => {
      const c = await crew('Último caixa');
      const unitId = c.setup.tenant.unitId;
      const second = await newRegister(c, 'Caixa 2');
      const first = await openRegister(c, 0);
      const other = await openRegister(c, 0, second.id);
      const event = await ok<ContractedEventDto>('post', `/units/${unitId}/events`, c.owner, {
        contractorName: 'Casamento Ana e Leo',
        startsOn: today(),
        modality: 'fixed_fee',
      });
      await ok<ContractedEventDto>('post', `/events/${event.id}/start`, c.cashier.auth, {}, 200);
      const tab = await ok<TabDto>('post', `/units/${unitId}/tabs`, c.counter.auth, {
        customerName: 'Convidado',
      });
      await ok<OrderDto>('post', `/tabs/${tab.id}/orders`, c.counter.auth, {
        items: [skewers(c, 3)],
      });

      // Not the last register: nothing about items nor the event.
      const notLast = await ok<ClosePreviewDto>(
        'get',
        `/cash-register-sessions/${sessionOf(first).id}/close-preview`,
        c.cashier.auth,
      );
      expect(notLast).toMatchObject({
        lastOpenRegister: false,
        itemsInProgress: 0,
        eventInProgress: null,
      });
      await closeSession(c, sessionOf(first).id, { counts: zeroCounts(), finishEvent: true });
      await expect(
        platform.contractedEvent.findUniqueOrThrow({ where: { id: event.id } }),
      ).resolves.toMatchObject({ status: 'in_progress' });

      const last = await ok<ClosePreviewDto>(
        'get',
        `/cash-register-sessions/${sessionOf(other).id}/close-preview`,
        c.cashier.auth,
      );
      expect(last).toMatchObject({
        lastOpenRegister: true,
        itemsInProgress: 3,
        eventInProgress: { id: event.id, contractorName: 'Casamento Ana e Leo' },
      });
      await closeSession(c, sessionOf(other).id, {
        counts: zeroCounts(),
        finishEvent: true,
        finishPendingItems: false,
      });
      await expect(
        platform.contractedEvent.findUniqueOrThrow({ where: { id: event.id } }),
      ).resolves.toMatchObject({ status: 'finished' });
      // finishPendingItems false: the items stay in preparation.
      await expect(
        platform.orderItem.count({ where: { tabId: tab.id, stationId: { not: null } } }),
      ).resolves.toBe(1);
    });

    it('idempotency: a movement sent again with the same key is not duplicated', async () => {
      const c = await crew('Movimento reenviado');
      const register = await openRegister(c, 0);
      const sessionId = sessionOf(register).id;
      const key = crypto.randomUUID();
      for (let attempt = 0; attempt < 2; attempt++) {
        await ok<CashRegisterSessionDetailDto>(
          'post',
          `/cash-register-sessions/${sessionId}/movements`,
          c.cashier.auth,
          { type: 'deposit', amountCents: 1000, reason: 'Troco' },
          201,
          { 'Idempotency-Key': key },
        );
      }
      await expect(
        platform.cashMovement.count({ where: { cashRegisterSessionId: sessionId } }),
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
    it('counts the paid tabs, their value (with discount), the average ticket and the days of operation', async () => {
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
        `/units/${c.setup.tenant.unitId}/tabs/pay-first`,
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
      expect(row).toMatchObject({ tabs: 2, soldCents: 8325 + 1200, operationDays: 1 });
      const overview = await metrics.overview(resolvePeriod({}));
      expect(overview.tabs).toBeGreaterThanOrEqual(2);
      expect(overview.averageTicketCents).toBe(Math.round(overview.soldCents / overview.tabs));
    });
  });

  describe('tenant isolation (CA-01.02)', () => {
    let a: Crew;
    let b: Crew;
    let ctx: IsolationContext;
    let sessionId: string;
    let payment: PaymentResultDto;
    let tabId: string;

    beforeAll(async () => {
      a = await crew('Caixa A');
      b = await crew('Caixa B');
      const register = await openRegister(a, 0);
      sessionId = sessionOf(register).id;
      await openRegister(b, 0);
      const { tab } = await billedTab(a, 2);
      tabId = tab.id;
      payment = await pay(a, tab.id, { method: 'pix', amountCents: 500 });
      ctx = { prisma: app.get(PrismaService), tenantA: a.setup.tenant, tenantB: b.setup.tenant };
    });

    it('organization B gets 404 on every route with ids of A, and changes nothing', async () => {
      const unitA = a.setup.tenant.unitId;
      const routes: {
        method: 'get' | 'post' | 'put' | 'patch' | 'delete';
        path: string;
        body?: object;
        /** Owner-only routes answer 403 to staff before looking at the id. */
        ownerOnly?: boolean;
      }[] = [
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
          path: `/units/${unitA}/tabs/pay-first`,
          body: { customerName: 'x', items: [skewers(a, 1)], payments: [] },
        },
        { method: 'get', path: `/units/${unitA}/cash-registers` },
        {
          method: 'post',
          path: `/units/${unitA}/cash-registers`,
          body: { name: 'Invasor' },
          ownerOnly: true,
        },
        {
          method: 'patch',
          path: `/cash-registers/${a.setup.register}`,
          body: { name: 'x' },
          ownerOnly: true,
        },
        {
          method: 'post',
          path: `/cash-registers/${a.setup.register}/open`,
          body: { openingFloatCents: 0 },
        },
        { method: 'get', path: `/cash-register-sessions/${sessionId}` },
        { method: 'get', path: `/cash-register-sessions/${sessionId}/close-preview` },
        {
          method: 'post',
          path: `/cash-register-sessions/${sessionId}/movements`,
          body: { type: 'deposit', amountCents: 1, reason: 'x' },
        },
        {
          method: 'post',
          path: `/cash-register-sessions/${sessionId}/close`,
          body: { counts: zeroCounts(), note: 'x' },
        },
        { method: 'get', path: `/units/${unitA}/workflow` },
      ];
      for (const route of routes) {
        for (const auth of route.ownerOnly === true ? [b.owner] : [b.owner, b.cashier.auth]) {
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
        platform.cashRegisterSession.findUniqueOrThrow({ where: { id: sessionId } }),
      ).resolves.toMatchObject({ status: 'open' });
      await expect(
        platform.cashRegister.findUniqueOrThrow({ where: { id: a.setup.register } }),
      ).resolves.toMatchObject({ name: 'Caixa 1' });
      await expect(platform.tab.findUniqueOrThrow({ where: { id: tabId } })).resolves.toMatchObject(
        { discountType: null },
      );
    });

    async function registerOf(db: TenantDb, tenant: Tenant) {
      return db.cashRegister.create({
        data: {
          organizationId: requireOrganizationId(),
          unitId: tenant.unitId,
          name: `Caixa ${crypto.randomUUID().slice(0, 8)}`,
          sortOrder: 9,
        },
      });
    }

    async function sessionRowOf(db: TenantDb, tenant: Tenant) {
      const register = await registerOf(db, tenant);
      return db.cashRegisterSession.create({
        data: {
          organizationId: requireOrganizationId(),
          cashRegisterId: register.id,
          unitId: tenant.unitId,
          businessDate: dateColumn(todayInSaoPaulo()),
          status: 'closed',
          openingFloatCents: 0,
          openedByType: 'owner',
          openedAt: new Date(),
          closedByType: 'owner',
          closedAt: new Date(),
        },
      });
    }

    describeTenantIsolation('CashRegister', {
      context: () => ctx,
      delegate: (db) => db.cashRegister,
      create: (db, tenant) => registerOf(db, tenant),
      update: { name: 'Invadido' },
    });

    describeTenantIsolation('CashRegisterSession', {
      context: () => ctx,
      delegate: (db) => db.cashRegisterSession,
      create: (db, tenant) => sessionRowOf(db, tenant),
      update: { closingNote: 'Invadido' },
    });

    describeTenantIsolation('CashMovement', {
      context: () => ctx,
      delegate: (db) => db.cashMovement,
      create: async (db, tenant) => {
        const row = await sessionRowOf(db, tenant);
        return db.cashMovement.create({
          data: {
            organizationId: requireOrganizationId(),
            cashRegisterSessionId: row.id,
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
        const row = await sessionRowOf(db, tenant);
        return db.cashRegisterCount.create({
          data: {
            organizationId: requireOrganizationId(),
            cashRegisterSessionId: row.id,
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
        const row = await sessionRowOf(db, tenant);
        const tab = await db.tab.create({
          data: {
            organizationId: requireOrganizationId(),
            unitId: tenant.unitId,
            number: 1,
            businessDate: row.businessDate,
            closedBusinessDate: row.businessDate,
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
            cashRegisterSessionId: row.id,
            method: 'pix',
            amountCents: 100,
            receivedByType: 'owner',
          },
        });
      },
      update: { reversalReason: null },
    });

    it('the tenant client never reads payments of another organization', async () => {
      const rows = await runWithContext(systemContext({ auth: b.owner }), async () =>
        app.get(PrismaService).db.payment.findMany({ where: { tabId } }),
      );
      expect(rows).toEqual([]);
    });
  });
});
