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
  CustomerDetailDto,
  CustomerDto,
  ReceivablesDto,
} from '../../src/operation/credit.schemas.js';
import type { ShiftDto, TabDto } from '../../src/operation/operation.schemas.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { RealtimeService } from '../../src/realtime/realtime.service.js';
import { errorOf } from '../support/http.js';
import {
  createTenant,
  describeTenantIsolation,
  expectNotFoundForOtherTenant,
  type IsolationContext,
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
  unitId: string;
  owner: AuthContext;
  /** Balcão + Balcão de entrega, operates cash. */
  cashier: TestStaff;
  /** Balcão only. */
  counter: TestStaff;
  /** Cozinha only. */
  kitchen: TestStaff;
  shift: ShiftDto;
}

const COUNTS = (informed: Record<string, number>) => ({
  counts: ['cash', 'pix', 'credit_card', 'debit_card'].map((method) => ({
    method,
    informedCents: informed[method] ?? 0,
  })),
});

describe.skipIf(!databaseUrl)('fiado (spec 06)', () => {
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

  /** A unit with an open shift where the skewer costs R$ 10,00. */
  async function crew(label: string): Promise<Crew> {
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
      kitchen: await createStaff(platform, tenant, [stations.kitchen]),
    };
    return { ...c, shift: await openShift(c) };
  }

  function openShift(c: Pick<Crew, 'setup' | 'unitId' | 'owner'>, body?: object) {
    return ok<ShiftDto>(
      'post',
      `/units/${c.unitId}/shifts`,
      c.owner,
      body ?? {
        type: 'direct_sale',
        prices: [{ productId: c.setup.products.skewer, priceCents: 1000 }],
      },
    );
  }

  type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

  async function ok<T>(
    method: Method,
    path: string,
    auth: AuthContext,
    body?: object,
    status = method === 'post' ? 201 : 200,
    headers: Record<string, string> = {},
  ): Promise<T> {
    let call = http()[method](`${API}${path}`).set(authHeaders(auth)).set(headers);
    if (body !== undefined) {
      call = call.send(body);
    }
    const response = await call;
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return response.body as T;
  }

  async function fails(
    method: Method,
    path: string,
    auth: AuthContext,
    body: object | undefined,
    status: number,
    code: string,
  ): Promise<Record<string, unknown>> {
    let call = http()[method](`${API}${path}`).set(authHeaders(auth));
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

  function openRegister(c: Crew, shiftId = c.shift.id) {
    return ok<CashRegisterDto>('post', `/shifts/${shiftId}/cash-registers`, c.cashier.auth, {
      openingFloatCents: 0,
    });
  }

  async function billedTab(c: Crew, quantity: number, customerName = 'Dona Marta') {
    const tab = await ok<TabDto>('post', `/shifts/${c.shift.id}/tabs`, c.counter.auth, {
      customerName,
    });
    await ok('post', `/tabs/${tab.id}/orders`, c.counter.auth, { items: [skewers(c, quantity)] });
    return ok<TabDto>('post', `/tabs/${tab.id}/request-bill`, c.counter.auth, {}, 200);
  }

  function createCustomer(c: Crew, body: object, auth = c.counter.auth, unitId = c.unitId) {
    return ok<CustomerDto>('post', `/units/${unitId}/customers`, auth, body);
  }

  function search(c: Crew, q: string, auth = c.counter.auth, unitId = c.unitId) {
    return ok<{ data: CustomerDto[] }>(
      'get',
      `/units/${unitId}/customers?q=${encodeURIComponent(q)}`,
      auth,
    );
  }

  function putOnCredit(c: Crew, tabId: string, body: object, auth = c.counter.auth) {
    return ok<TabDto>('post', `/tabs/${tabId}/put-on-credit`, auth, body, 200);
  }

  function pay(c: Crew, tabId: string, body: object) {
    return ok<PaymentResultDto>('post', `/tabs/${tabId}/payments`, c.counter.auth, body);
  }

  function receivables(c: Crew) {
    return ok<ReceivablesDto>('get', `/units/${c.unitId}/receivables`, c.counter.auth);
  }

  async function closeShift(c: Crew, registers: CashRegisterDto[]) {
    for (const register of registers) {
      const current = await ok<CashRegisterDetailDto>(
        'get',
        `/cash-registers/${register.id}`,
        c.cashier.auth,
      );
      const informed = Object.fromEntries(
        current.expected.map((row) => [row.method, row.expectedCents]),
      );
      await ok(
        'post',
        `/cash-registers/${register.id}/close`,
        c.cashier.auth,
        COUNTS(informed),
        200,
      );
    }
    await ok('post', `/shifts/${c.shift.id}/close`, c.owner, undefined, 200);
  }

  /** A tab of R$ 120,00 with R$ 20,00 paid, put on credit for a new customer (CA-06.01). */
  async function hungTab(c: Crew, name = 'Seu Zé') {
    const register = await openRegister(c);
    const tab = await billedTab(c, 12);
    await pay(c, tab.id, { method: 'pix', amountCents: 2000 });
    const customer = await createCustomer(c, { name, phone: '(11) 98765-4321' });
    const hung = await putOnCredit(c, tab.id, { customerId: customer.id });
    return { register, tab: hung, customer };
  }

  describe('customers (section 3)', () => {
    it('CA-06.06, RN-06.01, RN-06.02: name only; homonyms show their data; repeated phone or CPF is refused', async () => {
      const c = await crew('Clientes');
      const onlyName = await createCustomer(c, { name: 'Maria' });
      expect(onlyName).toMatchObject({
        name: 'Maria',
        phone: null,
        cpf: null,
        reference: null,
        note: null,
        removedAt: null,
      });
      const withData = await createCustomer(c, {
        name: 'Maria',
        phone: '(11) 98765-4321',
        cpf: '529.982.247-25',
        reference: 'apto 42, bloco B',
        note: 'filha da dona Cida',
      });
      // Stored with digits only.
      expect(withData).toMatchObject({ phone: '11987654321', cpf: '52998224725' });

      const found = await search(c, 'mar');
      expect(found.data.map((row) => [row.id, row.phone, row.reference])).toEqual([
        [onlyName.id, null, null],
        [withData.id, '11987654321', 'apto 42, bloco B'],
      ]);
      // Search by phone, CPF and reference too.
      for (const q of ['98765', '529.982', 'bloco b']) {
        expect((await search(c, q)).data.map((row) => row.id)).toEqual([withData.id]);
      }

      const phone = await fails(
        'post',
        `/units/${c.unitId}/customers`,
        c.counter.auth,
        { name: 'Outra', phone: '11 987654321' },
        409,
        'CUSTOMER_PHONE_TAKEN',
      );
      expect(phone).toEqual({});
      await fails(
        'post',
        `/units/${c.unitId}/customers`,
        c.counter.auth,
        { name: 'Outra', cpf: '52998224725' },
        409,
        'CUSTOMER_CPF_TAKEN',
      );
      // Editing into a phone of another customer is refused as well.
      await fails(
        'patch',
        `/customers/${onlyName.id}`,
        c.owner,
        { phone: '11987654321' },
        409,
        'CUSTOMER_PHONE_TAKEN',
      );
      // Invalid CPF and phone without DDD.
      for (const body of [
        { name: 'X', cpf: '529.982.247-24' },
        { name: 'X', phone: '98765-4321' },
        { name: 'X'.repeat(61) },
        { name: 'X', reference: 'R'.repeat(61) },
        { name: 'X', note: 'N'.repeat(141) },
      ]) {
        await fails(
          'post',
          `/units/${c.unitId}/customers`,
          c.counter.auth,
          body,
          400,
          'VALIDATION_FAILED',
        );
      }
      // The owner edits; null clears an optional field.
      const edited = await ok<CustomerDto>('patch', `/customers/${withData.id}`, c.owner, {
        note: null,
        reference: 'apto 43',
        version: withData.version,
      });
      expect(edited).toMatchObject({ note: null, reference: 'apto 43', version: 1 });
      await fails(
        'patch',
        `/customers/${withData.id}`,
        c.owner,
        { name: 'Y', version: 0 },
        409,
        'CUSTOMER_CHANGED',
      );
      // Audit without personal data (LGPD).
      const logs = await platform.auditLog.findMany({ where: { entityId: withData.id } });
      expect(logs.map((log) => log.action)).toEqual(['customer.created', 'customer.updated']);
      expect(JSON.stringify(logs)).not.toMatch(/Maria|98765|52998|apto/);
    });

    it('CA-06.04: a customer of one unit is not found nor used in another unit of the organization', async () => {
      const c = await crew('Duas unidades');
      const other = await platform.unit.create({
        data: { organizationId: c.setup.tenant.organizationId, name: 'Outra barraca' },
      });
      const customer = await createCustomer(c, { name: 'Joana', phone: '11987654321' });
      expect((await search(c, 'Joana', c.owner, other.id)).data).toEqual([]);
      expect((await search(c, 'Joana', c.owner)).data.map((row) => row.id)).toEqual([customer.id]);
      // The same phone may exist in another unit (unique per unit).
      await createCustomer(c, { name: 'Joana', phone: '11987654321' }, c.owner, other.id);

      await openRegister(c);
      const tab = await billedTab(c, 1);
      const elsewhere = await ok<CustomerDto>('post', `/units/${other.id}/customers`, c.owner, {
        name: 'Fora',
      });
      await fails(
        'post',
        `/tabs/${tab.id}/put-on-credit`,
        c.counter.auth,
        { customerId: elsewhere.id },
        400,
        'INVALID_CUSTOMER',
      );
    });

    it('permissions: the counter searches and registers; only the owner edits and removes; stations without counter do nothing', async () => {
      const c = await crew('Permissões fiado');
      const customer = await createCustomer(c, { name: 'Ana' });
      await fails(
        'get',
        `/units/${c.unitId}/customers`,
        c.kitchen.auth,
        undefined,
        403,
        'FORBIDDEN',
      );
      await fails(
        'post',
        `/units/${c.unitId}/customers`,
        c.kitchen.auth,
        { name: 'X' },
        403,
        'FORBIDDEN',
      );
      await fails(
        'patch',
        `/customers/${customer.id}`,
        c.counter.auth,
        { name: 'X' },
        403,
        'FORBIDDEN',
      );
      await fails(
        'delete',
        `/customers/${customer.id}`,
        c.counter.auth,
        undefined,
        403,
        'FORBIDDEN',
      );
      await fails(
        'get',
        `/units/${c.unitId}/receivables`,
        c.kitchen.auth,
        undefined,
        403,
        'FORBIDDEN',
      );
      await ok('get', `/customers/${customer.id}`, c.counter.auth);
    });
  });

  describe('customer search pagination (spec 01, section 5)', () => {
    it('pages the search in name order with limit and cursor', async () => {
      const c = await crew('Paginação clientes');
      for (const name of ['Carla', 'Ana', 'Bruno', 'Ana', 'Davi']) {
        await createCustomer(c, { name });
      }
      const names: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
        const page = await ok<{ data: CustomerDto[]; nextCursor: string | null }>(
          'get',
          `/units/${c.unitId}/customers?limit=2${query}`,
          c.counter.auth,
        );
        expect(page.data.length).toBeLessThanOrEqual(2);
        names.push(...page.data.map((row) => row.name));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);
      expect(names).toEqual(['Ana', 'Ana', 'Bruno', 'Carla', 'Davi']);
      expect(pages).toBe(3);
      const filtered = await ok<{ data: CustomerDto[]; nextCursor: string | null }>(
        'get',
        `/units/${c.unitId}/customers?q=an&limit=1`,
        c.counter.auth,
      );
      expect(filtered.data.map((row) => row.name)).toEqual(['Ana']);
      expect(filtered.nextCursor).not.toBeNull();
      await fails(
        'get',
        `/units/${c.unitId}/customers?cursor=abc`,
        c.counter.auth,
        undefined,
        400,
        'VALIDATION_FAILED',
      );
    });
  });

  describe('put on credit (section 4)', () => {
    it('CA-06.01, RN-06.05, RN-06.06: R$ 120,00 with R$ 20,00 paid is on credit with a balance of R$ 100,00', async () => {
      const c = await crew('Pendurar');
      const emit = vi.spyOn(app.get(RealtimeService), 'emitToUnit');
      const { tab, customer } = await hungTab(c);
      expect(tab).toMatchObject({
        status: 'on_credit',
        totalCents: 12_000,
        paidCents: 2000,
        balanceCents: 10_000,
        customer: { id: customer.id, name: 'Seu Zé', reference: null, removed: false },
      });
      expect(tab.creditAt).not.toBeNull();
      expect(tab.closedAt).not.toBeNull();
      const updates = emit.mock.calls.filter(([event]) => event.type === 'tab.updated');
      expect(updates.map(([, payload]) => (payload.data as TabDto).status)).toContain('on_credit');
      emit.mockRestore();

      const list = await receivables(c);
      expect(list.totalCents).toBe(10_000);
      expect(list.tabs.map((row) => [row.id, row.balanceCents])).toEqual([[tab.id, 10_000]]);
      expect(list.customers).toEqual([
        expect.objectContaining({
          balanceCents: 10_000,
          tabCount: 1,
          oldestCreditAt: tab.creditAt,
        }),
      ]);
      expect(list.customers[0]?.customer.phone).toBe('11987654321');

      // RN-06.07: no more orders, discounts nor item cancellations.
      await fails(
        'post',
        `/tabs/${tab.id}/orders`,
        c.counter.auth,
        { items: [skewers(c, 1)] },
        409,
        'TAB_CLOSED',
      );
      await fails(
        'put',
        `/tabs/${tab.id}/discount`,
        c.counter.auth,
        { type: 'amount', value: 100, reason: 'x' },
        409,
        'TAB_CLOSED',
      );
      const itemId = tab.orders[0]?.items[0]?.id ?? '';
      await fails(
        'post',
        `/order-items/${itemId}/cancel`,
        c.counter.auth,
        { reason: 'x', version: tab.orders[0]?.items[0]?.version ?? 0 },
        409,
        'TAB_CLOSED',
      );
      // RN-06.06: the payment made before stays; it is not reversed from an on-credit tab.
      const before = tab.payments[0]?.id ?? '';
      await fails(
        'post',
        `/payments/${before}/reverse`,
        c.counter.auth,
        { reason: 'x' },
        409,
        'TAB_CLOSED',
      );
      expect(
        await platform.auditLog.count({ where: { entityId: tab.id, action: 'tab.put_on_credit' } }),
      ).toBe(1);
    });

    it('CA-06.02, RN-06.04: an open tab is not put on credit; a customer is required', async () => {
      const c = await crew('Pendurar aberta');
      const customer = await createCustomer(c, { name: 'Lia' });
      const open = await ok<TabDto>('post', `/shifts/${c.shift.id}/tabs`, c.counter.auth, {
        customerName: 'Lia',
      });
      await fails(
        'post',
        `/tabs/${open.id}/put-on-credit`,
        c.counter.auth,
        { customerId: customer.id },
        409,
        'TAB_NOT_CLOSING',
      );
      await ok('post', `/tabs/${open.id}/orders`, c.counter.auth, { items: [skewers(c, 1)] });
      await ok('post', `/tabs/${open.id}/request-bill`, c.counter.auth, {}, 200);
      await fails(
        'post',
        `/tabs/${open.id}/put-on-credit`,
        c.counter.auth,
        {},
        400,
        'CUSTOMER_REQUIRED',
      );
      await fails(
        'post',
        `/tabs/${open.id}/put-on-credit`,
        c.kitchen.auth,
        { customerId: customer.id },
        403,
        'FORBIDDEN',
      );
      // Idempotency: sent twice with the same key, put on credit once.
      const key = crypto.randomUUID();
      const first = await ok<TabDto>(
        'post',
        `/tabs/${open.id}/put-on-credit`,
        c.counter.auth,
        { customerId: customer.id },
        200,
        { 'Idempotency-Key': key },
      );
      const again = await http()
        .post(`${API}/tabs/${open.id}/put-on-credit`)
        .set(authHeaders(c.counter.auth))
        .set('Idempotency-Key', key)
        .send({ customerId: customer.id });
      expect(again.status).toBe(200);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect((again.body as TabDto).version).toBe(first.version);
      await fails(
        'post',
        `/tabs/${open.id}/put-on-credit`,
        c.counter.auth,
        { customerId: customer.id },
        409,
        'TAB_CLOSED',
      );
    });

    it('RN-06.08: in a consumption_billed shift the tab of the contractor goes to a customer with their name', async () => {
      const tenant = await createTenant(platform, 'Contratado');
      const setup = await setupOperation(platform, tenant);
      const shift = await openShift(
        { setup, unitId: tenant.unitId, owner: tenant.ownerAuth },
        {
          type: 'contracted',
          agreement: { contractorName: 'Empresa Alfa', modality: 'consumption_billed' },
        },
      );
      const c: Crew = {
        setup,
        unitId: tenant.unitId,
        owner: tenant.ownerAuth,
        cashier: await createStaff(platform, tenant, [setup.stations.counter], {
          canOperateCash: true,
        }),
        counter: await createStaff(platform, tenant, [setup.stations.counter]),
        kitchen: await createStaff(platform, tenant, [setup.stations.kitchen]),
        shift,
      };
      const first = await billedTab(c, 3, 'Empresa Alfa');
      const hung = await putOnCredit(c, first.id, {});
      expect(hung.customer).toMatchObject({
        name: 'Empresa Alfa',
        reference: 'Contratante de turno',
      });
      const second = await billedTab(c, 1, 'Empresa Alfa');
      const again = await putOnCredit(c, second.id, {});
      expect(again.customer?.id).toBe(hung.customer?.id);
      const list = await receivables(c);
      expect(list.customers).toHaveLength(1);
      expect(list.totalCents).toBe(first.totalCents + second.totalCents);
    });
  });

  describe('settlement (section 5)', () => {
    it('CA-06.03, RN-06.09, RN-06.10, RN-05.22: settled in the next shift, partially then fully, into that register and apart in the count', async () => {
      const c = await crew('Quitação');
      const { register, tab, customer } = await hungTab(c);
      await closeShift(c, [register]);

      // RN-06.09: no open shift in the unit.
      await fails(
        'post',
        `/tabs/${tab.id}/payments`,
        c.counter.auth,
        { method: 'pix', amountCents: 6000 },
        409,
        'NO_SHIFT_OPEN',
      );
      const next = await openShift(c);
      const nextCrew = { ...c, shift: next };
      await fails(
        'post',
        `/tabs/${tab.id}/payments`,
        c.counter.auth,
        { method: 'pix', amountCents: 6000 },
        409,
        'NO_CASH_REGISTER_OPEN',
      );
      const newRegister = await openRegister(nextCrew);
      // The register of the old shift is not accepted.
      await fails(
        'post',
        `/tabs/${tab.id}/payments`,
        c.counter.auth,
        { method: 'pix', amountCents: 6000, cashRegisterId: register.id },
        400,
        'INVALID_CASH_REGISTER',
      );
      // A sale of the new shift, to show the settlements apart.
      const sale = await billedTab(nextCrew, 3);
      await pay(nextCrew, sale.id, { method: 'pix', amountCents: 3000 });

      const partial = await pay(c, tab.id, { method: 'pix', amountCents: 6000 });
      expect(partial.payment).toMatchObject({
        isCreditSettlement: true,
        shiftId: next.id,
        cashRegisterId: newRegister.id,
      });
      expect(partial.tab).toMatchObject({ status: 'on_credit', balanceCents: 4000 });
      expect((await receivables(c)).totalCents).toBe(4000);
      // Above the balance is refused (RN-06.11 follows spec 05).
      await fails(
        'post',
        `/tabs/${tab.id}/payments`,
        c.counter.auth,
        { method: 'pix', amountCents: 4001 },
        409,
        'PAYMENT_EXCEEDS_BALANCE',
      );
      const full = await pay(c, tab.id, { method: 'cash', tenderedCents: 5000 });
      expect(full.payment).toMatchObject({ amountCents: 4000, changeCents: 1000 });
      expect(full.tab).toMatchObject({ status: 'settled', balanceCents: 0 });
      expect(full.tab.settledAt).not.toBeNull();
      expect(await receivables(c)).toMatchObject({ totalCents: 0, tabs: [], customers: [] });
      await fails(
        'post',
        `/tabs/${tab.id}/payments`,
        c.counter.auth,
        { method: 'pix', amountCents: 1 },
        409,
        'TAB_NOTHING_TO_PAY',
      );

      // RN-05.22: the register shows the settlements apart from the sales of the shift.
      const detail = await ok<CashRegisterDetailDto>(
        'get',
        `/cash-registers/${newRegister.id}`,
        c.cashier.auth,
      );
      expect(detail.creditSettlementsCents).toBe(10_000);
      expect(detail.expected).toEqual([
        { method: 'cash', expectedCents: 4000, salesCents: 0, creditSettlementsCents: 4000 },
        { method: 'pix', expectedCents: 9000, salesCents: 3000, creditSettlementsCents: 6000 },
        { method: 'credit_card', expectedCents: 0, salesCents: 0, creditSettlementsCents: 0 },
        { method: 'debit_card', expectedCents: 0, salesCents: 0, creditSettlementsCents: 0 },
      ]);
      expect(detail.cash).toMatchObject({ paymentsCents: 4000, creditSettlementsCents: 4000 });
      expect(
        detail.payments.filter((row) => row.isCreditSettlement).map((row) => row.amountCents),
      ).toEqual([6000, 4000]);
      const closed = await ok<CashRegisterDto>(
        'post',
        `/cash-registers/${newRegister.id}/close`,
        c.cashier.auth,
        COUNTS({ cash: 4000, pix: 9000 }),
        200,
      );
      expect(closed.counts.map((row) => [row.method, row.creditSettlementsCents])).toEqual([
        ['cash', 4000],
        ['pix', 6000],
        ['credit_card', 0],
        ['debit_card', 0],
      ]);

      // The history of the customer.
      const history = await ok<CustomerDetailDto>('get', `/customers/${customer.id}`, c.owner);
      expect(history.balanceCents).toBe(0);
      expect(history.tabs.map((row) => [row.id, row.status])).toEqual([[tab.id, 'settled']]);
      expect(history.settlements.map((row) => row.amountCents)).toEqual([6000, 4000]);
      expect(
        await platform.auditLog.count({ where: { entityId: tab.id, action: 'tab.settled' } }),
      ).toBe(1);
    });

    it('RN-06.12: reversing a settlement of a settled tab takes it back to on_credit', async () => {
      const c = await crew('Estorno quitação');
      const { tab } = await hungTab(c);
      const key = crypto.randomUUID();
      const settled = await ok<PaymentResultDto>(
        'post',
        `/tabs/${tab.id}/payments`,
        c.counter.auth,
        { method: 'pix', amountCents: 10_000 },
        201,
        { 'Idempotency-Key': key },
      );
      // Idempotency: the same settlement sent again is not duplicated.
      await ok<PaymentResultDto>(
        'post',
        `/tabs/${tab.id}/payments`,
        c.counter.auth,
        { method: 'pix', amountCents: 10_000 },
        201,
        { 'Idempotency-Key': key },
      );
      await expect(
        platform.payment.count({ where: { tabId: tab.id, isCreditSettlement: true } }),
      ).resolves.toBe(1);
      expect(settled.tab.status).toBe('settled');
      const reversed = await ok<PaymentResultDto>(
        'post',
        `/payments/${settled.payment.id}/reverse`,
        c.counter.auth,
        { reason: 'Pix não caiu' },
        200,
      );
      expect(reversed.tab).toMatchObject({
        status: 'on_credit',
        balanceCents: 10_000,
        settledAt: null,
      });
      expect((await receivables(c)).totalCents).toBe(10_000);
    });

    it('CA-06.05, RN-06.03: a customer with a balance is not removed; without one it is anonymized and the tabs stay', async () => {
      const c = await crew('Remover cliente');
      const { tab, customer } = await hungTab(c, 'Fulano de Tal');
      const details = await fails(
        'delete',
        `/customers/${customer.id}`,
        c.owner,
        undefined,
        409,
        'CUSTOMER_HAS_RECEIVABLE',
      );
      expect(details).toEqual({ balanceCents: 10_000 });
      await pay(c, tab.id, { method: 'pix', amountCents: 10_000 });

      const removed = await ok<CustomerDto>('delete', `/customers/${customer.id}`, c.owner);
      expect(removed).toMatchObject({
        name: 'Cliente removido',
        phone: null,
        cpf: null,
        reference: null,
        note: null,
      });
      expect(removed.removedAt).not.toBeNull();
      const kept = await ok<TabDto>('get', `/tabs/${tab.id}`, c.counter.auth);
      // RN-06.03 (LGPD): the name typed on the tab is replaced too, in the same transaction.
      expect(kept).toMatchObject({
        status: 'settled',
        customerName: 'Cliente removido',
        customer: { id: customer.id, name: 'Cliente removido', removed: true },
      });
      expect(JSON.stringify(kept)).not.toContain('Dona Marta');
      const other = await billedTab(c, 1, 'Outra pessoa');
      expect(other.customerName).toBe('Outra pessoa');
      expect((await search(c, 'Fulano')).data).toEqual([]);
      expect((await search(c, '')).data.map((row) => row.id)).not.toContain(customer.id);
      // The phone is free again in the unit.
      await createCustomer(c, { name: 'Outro', phone: '11987654321' });
      await fails(
        'patch',
        `/customers/${customer.id}`,
        c.owner,
        { name: 'X' },
        409,
        'CUSTOMER_REMOVED',
      );
      const fresh = await billedTab(c, 1);
      await fails(
        'post',
        `/tabs/${fresh.id}/put-on-credit`,
        c.counter.auth,
        { customerId: customer.id },
        400,
        'INVALID_CUSTOMER',
      );
      const logs = await platform.auditLog.findMany({ where: { entityId: customer.id } });
      expect(logs.map((log) => log.action)).toContain('customer.anonymized');
      expect(JSON.stringify(logs)).not.toMatch(/Fulano|98765/);
    });
  });

  describe('admin metrics (spec 02, section 6)', () => {
    it('tabs on credit and settled count in the period, with their total', async () => {
      const c = await crew('Métricas fiado');
      const { tab } = await hungTab(c);
      const second = await billedTab(c, 2, 'Outra');
      const customer = await createCustomer(c, { name: 'Bia' });
      await putOnCredit(c, second.id, { customerId: customer.id });
      await pay(c, second.id, { method: 'pix', amountCents: 2000 });
      const metrics = app.get(MetricsService);
      const usage = await metrics.organizations(resolvePeriod({}), 'name', 'asc');
      const row = usage.data.find((item) => item.organizationId === c.setup.tenant.organizationId);
      expect(row).toMatchObject({ tabs: 2, soldCents: tab.totalCents + 2000 });
    });
  });

  describe('tenant isolation (CA-01.02)', () => {
    let a: Crew;
    let b: Crew;
    let ctx: IsolationContext;
    let tabId: string;
    let customerId: string;

    beforeAll(async () => {
      a = await crew('Fiado A');
      b = await crew('Fiado B');
      const hung = await hungTab(a);
      tabId = hung.tab.id;
      customerId = hung.customer.id;
      ctx = { prisma: app.get(PrismaService), tenantA: a.setup.tenant, tenantB: b.setup.tenant };
    });

    it('organization B gets 404 on every route with ids of A, and changes nothing', async () => {
      const routes: { method: Method; path: string; body?: object }[] = [
        { method: 'get', path: `/units/${a.unitId}/customers` },
        { method: 'post', path: `/units/${a.unitId}/customers`, body: { name: 'Intruso' } },
        { method: 'get', path: `/customers/${customerId}` },
        { method: 'patch', path: `/customers/${customerId}`, body: { name: 'Intruso' } },
        { method: 'delete', path: `/customers/${customerId}` },
        { method: 'get', path: `/units/${a.unitId}/receivables` },
        { method: 'post', path: `/tabs/${tabId}/put-on-credit`, body: { customerId } },
        {
          method: 'post',
          path: `/tabs/${tabId}/payments`,
          body: { method: 'pix', amountCents: 1 },
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
      // B cannot put its own tab on credit for a customer of A.
      await openRegister(b);
      const own = await billedTab(b, 1);
      await fails(
        'post',
        `/tabs/${own.id}/put-on-credit`,
        b.counter.auth,
        { customerId },
        400,
        'INVALID_CUSTOMER',
      );
      await expect(
        platform.customer.findUniqueOrThrow({ where: { id: customerId } }),
      ).resolves.toMatchObject({
        name: 'Seu Zé',
        anonymizedAt: null,
      });
      await expect(platform.payment.count({ where: { tabId } })).resolves.toBe(1);
      await expect(platform.customer.count({ where: { unitId: a.unitId } })).resolves.toBe(1);
    });

    describeTenantIsolation('Customer', {
      context: () => ctx,
      delegate: (db) => db.customer,
      create: (db, tenant) =>
        db.customer.create({
          data: { organizationId: requireOrganizationId(), unitId: tenant.unitId, name: 'Cliente' },
        }),
      update: { name: 'Invadido' },
    });

    it('the tenant client never reads customers of another organization', async () => {
      const rows = await runWithContext(systemContext({ auth: b.owner }), async () =>
        app.get(PrismaService).db.customer.findMany({ where: { id: customerId } }),
      );
      expect(rows).toEqual([]);
    });
  });
});
