import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { AuthContext } from '../../src/context/request-context.js';
import type { MenuDto, PriceListDto } from '../../src/menu/menu.schemas.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { errorOf } from '../support/http.js';
import { createTenant, expectNotFoundForOtherTenant } from '../support/isolation-kit.js';
import { createStaff, type OperationSetup, setupOperation } from '../support/operation-kit.js';
import { authHeaders } from '../support/stub-auth.js';
import { createTestApp } from '../support/test-app.js';

const databaseUrl = inject('databaseUrl');
const API = '/api/v1';

describe.skipIf(!databaseUrl)('price lists (spec 03, section 5.3)', () => {
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

  async function fresh(label: string): Promise<OperationSetup> {
    return setupOperation(platform, await createTenant(platform, label));
  }

  async function createList(setup: OperationSetup, name: string): Promise<PriceListDto> {
    const response = await http()
      .post(`${API}/units/${setup.tenant.unitId}/price-lists`)
      .set(as(setup.tenant.ownerAuth))
      .send({ name })
      .expect(201);
    return response.body as PriceListDto;
  }

  async function menuOf(setup: OperationSetup, auth = setup.tenant.ownerAuth): Promise<MenuDto> {
    const response = await http()
      .get(`${API}/units/${setup.tenant.unitId}/menu`)
      .set(as(auth))
      .expect(200);
    return response.body as MenuDto;
  }

  function priceOf(menu: MenuDto, productId: string) {
    return menu.categories
      .flatMap((category) => category.products)
      .find((product) => product.id === productId);
  }

  it('CA-03.09, RN-03.21: with "Evento" current, the skewer costs the list price and the others the normal price', async () => {
    const setup = await fresh('Tabela Evento');
    const evento = await createList(setup, 'Evento');
    await http()
      .put(`${API}/price-lists/${evento.id}/prices`)
      .set(as(setup.tenant.ownerAuth))
      .send({ prices: [{ productId: setup.products.skewer, priceCents: 1500 }] })
      .expect(200);

    let menu = await menuOf(setup);
    expect(menu.effectivePriceListName).toBe('Normal');
    expect(priceOf(menu, setup.products.skewer)?.effectivePriceCents).toBe(1200);
    expect(priceOf(menu, setup.products.skewer)?.prices).toEqual([
      { priceListId: evento.id, priceCents: 1500 },
    ]);

    await http()
      .put(`${API}/units/${setup.tenant.unitId}/current-price-list`)
      .set(as(setup.tenant.ownerAuth))
      .send({ priceListId: evento.id })
      .expect(200);
    menu = await menuOf(setup);
    expect(menu).toMatchObject({
      currentPriceListId: evento.id,
      effectivePriceListId: evento.id,
      effectivePriceListName: 'Evento',
    });
    expect(priceOf(menu, setup.products.skewer)?.effectivePriceCents).toBe(1500);
    expect(priceOf(menu, setup.products.pastry)?.effectivePriceCents).toBe(800);
    expect(menu.priceLists).toEqual([
      expect.objectContaining({ id: evento.id, productCount: 1, current: true }),
    ]);
  });

  it('CA-03.10, RN-03.20, RN-03.23: "Normal" and repeated names are refused; the current list is not deactivated', async () => {
    const setup = await fresh('Tabela nomes');
    for (const name of ['Normal', ' normal ']) {
      const reserved = await http()
        .post(`${API}/units/${setup.tenant.unitId}/price-lists`)
        .set(as(setup.tenant.ownerAuth))
        .send({ name })
        .expect(409);
      expect(errorOf(reserved).code).toBe('PRICE_LIST_NAME_RESERVED');
    }
    const evento = await createList(setup, 'Evento');
    const repeated = await http()
      .post(`${API}/units/${setup.tenant.unitId}/price-lists`)
      .set(as(setup.tenant.ownerAuth))
      .send({ name: 'EVENTO' })
      .expect(409);
    expect(errorOf(repeated).code).toBe('PRICE_LIST_NAME_TAKEN');
    const tooLong = await http()
      .post(`${API}/units/${setup.tenant.unitId}/price-lists`)
      .set(as(setup.tenant.ownerAuth))
      .send({ name: 'x'.repeat(31) })
      .expect(400);
    expect(errorOf(tooLong).code).toBe('VALIDATION_FAILED');

    await http()
      .put(`${API}/units/${setup.tenant.unitId}/current-price-list`)
      .set(as(setup.tenant.ownerAuth))
      .send({ priceListId: evento.id })
      .expect(200);
    const inUse = await http()
      .patch(`${API}/price-lists/${evento.id}`)
      .set(as(setup.tenant.ownerAuth))
      .send({ active: false })
      .expect(409);
    expect(errorOf(inUse)).toMatchObject({
      code: 'PRICE_LIST_IN_USE',
      details: { reason: 'current' },
    });

    // The list of a scheduled event is in use too.
    const casamento = await createList(setup, 'Casamento');
    await http()
      .post(`${API}/units/${setup.tenant.unitId}/events`)
      .set(as(setup.tenant.ownerAuth))
      .send({
        contractorName: 'Ana e Leo',
        startsOn: '2030-01-10',
        modality: 'fixed_fee',
        priceListId: casamento.id,
      })
      .expect(201);
    const eventList = await http()
      .patch(`${API}/price-lists/${casamento.id}`)
      .set(as(setup.tenant.ownerAuth))
      .send({ active: false })
      .expect(409);
    expect(errorOf(eventList)).toMatchObject({ details: { reason: 'event' } });

    // Back to "Normal": the list can be deactivated and renamed; it is never deleted.
    await http()
      .put(`${API}/units/${setup.tenant.unitId}/current-price-list`)
      .set(as(setup.tenant.ownerAuth))
      .send({ priceListId: null })
      .expect(200);
    const off = await http()
      .patch(`${API}/price-lists/${evento.id}`)
      .set(as(setup.tenant.ownerAuth))
      .send({ active: false, name: 'Evento antigo' })
      .expect(200);
    expect(off.body).toMatchObject({ active: false, name: 'Evento antigo', current: false });
    // An inactive list is not chosen as current (RN-03.23).
    const inactive = await http()
      .put(`${API}/units/${setup.tenant.unitId}/current-price-list`)
      .set(as(setup.tenant.ownerAuth))
      .send({ priceListId: evento.id })
      .expect(400);
    expect(errorOf(inactive).code).toBe('INVALID_PRICE_LIST');
    const audit = await platform.auditLog.findMany({
      where: { entityType: 'price_list', entityId: evento.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((row) => row.action)).toEqual(['price_list.created', 'price_list.updated']);
  });

  it('RN-03.22, RN-03.24: prices per list and per product, `null` removes; products and lists of the unit only', async () => {
    const setup = await fresh('Tabela precos');
    const other = await fresh('Tabela outra unidade');
    const evento = await createList(setup, 'Evento');
    const delivery = await createList(setup, 'Delivery');
    const byProduct = await http()
      .put(`${API}/products/${setup.products.pastry}/prices`)
      .set(as(setup.tenant.ownerAuth))
      .send({
        prices: [
          { priceListId: evento.id, priceCents: 900 },
          { priceListId: delivery.id, priceCents: 1000 },
        ],
      })
      .expect(200);
    expect((byProduct.body as { prices: unknown[] }).prices).toHaveLength(2);
    const byList = await http()
      .put(`${API}/price-lists/${evento.id}/prices`)
      .set(as(setup.tenant.ownerAuth))
      .send({
        prices: [
          { productId: setup.products.pastry, priceCents: null },
          { productId: setup.products.soda, priceCents: 0 },
        ],
      })
      .expect(200);
    expect(byList.body).toMatchObject({
      priceList: { id: evento.id, productCount: 1 },
      prices: [{ productId: setup.products.soda, priceCents: 0 }],
    });
    const read = await http()
      .get(`${API}/price-lists/${delivery.id}`)
      .set(as(setup.tenant.ownerAuth))
      .expect(200);
    expect(read.body).toMatchObject({
      prices: [{ productId: setup.products.pastry, priceCents: 1000 }],
    });

    const foreignProduct = await http()
      .put(`${API}/price-lists/${evento.id}/prices`)
      .set(as(setup.tenant.ownerAuth))
      .send({ prices: [{ productId: other.products.skewer, priceCents: 100 }] })
      .expect(400);
    expect(errorOf(foreignProduct).code).toBe('INVALID_REFERENCE');
    const negative = await http()
      .put(`${API}/price-lists/${evento.id}/prices`)
      .set(as(setup.tenant.ownerAuth))
      .send({ prices: [{ productId: setup.products.soda, priceCents: -1 }] })
      .expect(400);
    expect(errorOf(negative).code).toBe('VALIDATION_FAILED');
  });

  it('only the owner registers lists; staff read the active ones (spec 03, section 5.3)', async () => {
    const setup = await fresh('Tabela permissoes');
    const staff = await createStaff(platform, setup.tenant, [setup.stations.counter]);
    const evento = await createList(setup, 'Evento');
    const old = await createList(setup, 'Antiga');
    await http()
      .patch(`${API}/price-lists/${old.id}`)
      .set(as(setup.tenant.ownerAuth))
      .send({ active: false })
      .expect(200);
    const list = await http()
      .get(`${API}/units/${setup.tenant.unitId}/price-lists`)
      .set(as(staff.auth))
      .expect(200);
    expect((list.body as { data: PriceListDto[] }).data.map((row) => row.id)).toEqual([evento.id]);
    expect((await menuOf(setup, staff.auth)).priceLists.map((row) => row.id)).toEqual([evento.id]);
    for (const call of [
      () => http().post(`${API}/units/${setup.tenant.unitId}/price-lists`).send({ name: 'X' }),
      () => http().patch(`${API}/price-lists/${evento.id}`).send({ name: 'X' }),
      () => http().put(`${API}/price-lists/${evento.id}/prices`).send({ prices: [] }),
      () => http().put(`${API}/products/${setup.products.soda}/prices`).send({ prices: [] }),
    ]) {
      const response = await call().set(as(staff.auth));
      expect(response.status).toBe(403);
    }
  });

  it('CA-01.02: organization B gets 404 for the lists and prices of A', async () => {
    const a = await fresh('Tabela A');
    const b = await fresh('Tabela B');
    const evento = await createList(a, 'Evento');
    for (const call of [
      { method: 'get' as const, path: `${API}/units/${a.tenant.unitId}/price-lists` },
      { method: 'get' as const, path: `${API}/price-lists/${evento.id}` },
      {
        method: 'post' as const,
        path: `${API}/units/${a.tenant.unitId}/price-lists`,
        body: { name: 'Invasora' },
      },
      { method: 'patch' as const, path: `${API}/price-lists/${evento.id}`, body: { name: 'X' } },
      {
        method: 'put' as const,
        path: `${API}/price-lists/${evento.id}/prices`,
        body: { prices: [] },
      },
      {
        method: 'put' as const,
        path: `${API}/products/${a.products.skewer}/prices`,
        body: { prices: [] },
      },
    ]) {
      await expectNotFoundForOtherTenant(app, { ...call, as: b.tenant.ownerAuth });
    }
    await expect(
      platform.priceList.findUniqueOrThrow({ where: { id: evento.id } }),
    ).resolves.toMatchObject({ name: 'Evento' });
  });
});
