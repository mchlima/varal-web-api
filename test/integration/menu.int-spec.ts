import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { requireOrganizationId, type AuthContext } from '../../src/context/request-context.js';
import type { MenuDto } from '../../src/menu/menu.schemas.js';
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
import { grantUnit } from '../support/auth-kit.js';
import { type TemplateStations, withTemplate } from '../support/setup-kit.js';
import { authHeaders } from '../support/stub-auth.js';
import { createTestApp } from '../support/test-app.js';

const databaseUrl = inject('databaseUrl');
const API = '/api/v1';

interface Ids {
  id: string;
}

describe.skipIf(!databaseUrl)('menu (spec 03, section 5)', () => {
  let app: NestExpressApplication;
  let platform: PlatformPrismaService;
  let tenantA: Tenant;
  let tenantB: Tenant;
  let stationsA: TemplateStations;
  let ctx: IsolationContext;

  const http = () => request(app.getHttpServer());
  const as = (auth: AuthContext) => authHeaders(auth);

  beforeAll(async () => {
    app = await createTestApp({ databaseUrl: databaseUrl ?? '' });
    platform = app.get(PlatformPrismaService);
    tenantA = await createTenant(platform, 'Menu A');
    tenantB = await createTenant(platform, 'Menu B');
    stationsA = await withTemplate(platform, tenantA);
    await withTemplate(platform, tenantB);
    ctx = { prisma: app.get(PrismaService), tenantA, tenantB };
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  async function post<T = Ids>(path: string, body: object, auth = tenantA.ownerAuth): Promise<T> {
    const response = await http().post(`${API}${path}`).set(as(auth)).send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body as T;
  }

  async function menuOf(auth: AuthContext, unitId = tenantA.unitId): Promise<MenuDto> {
    const response = await http().get(`${API}/units/${unitId}/menu`).set(as(auth)).expect(200);
    return response.body as MenuDto;
  }

  async function newCategory(name = `Cat ${crypto.randomUUID().slice(0, 8)}`): Promise<Ids> {
    return post('/categories', { unitId: tenantA.unitId, name });
  }

  it('a new category gets the Cozinha as preparation station; names are unique in the unit', async () => {
    const category = await post<{ defaultStationId: string }>('/categories', {
      unitId: tenantA.unitId,
      name: 'Espetos',
    });
    expect(category.defaultStationId).toBe(stationsA.kitchen);
    const taken = await http()
      .post(`${API}/categories`)
      .set(as(tenantA.ownerAuth))
      .send({ unitId: tenantA.unitId, name: 'ESPETOS' })
      .expect(409);
    expect(errorOf(taken).code).toBe('CATEGORY_NAME_TAKEN');
  });

  it('RN-03.08: the preparation station must be an active queue station of the unit', async () => {
    const counter = await http()
      .post(`${API}/categories`)
      .set(as(tenantA.ownerAuth))
      .send({ unitId: tenantA.unitId, name: 'No balcão', defaultStationId: stationsA.counter })
      .expect(400);
    expect(errorOf(counter).code).toBe('INVALID_PREP_STATION');
    const stationOfB = await platform.station.findFirstOrThrow({
      where: { organizationId: tenantB.organizationId, kind: 'queue' },
    });
    const category = await newCategory();
    const foreign = await http()
      .post(`${API}/products`)
      .set(as(tenantA.ownerAuth))
      .send({ categoryId: category.id, name: 'X', priceCents: 100, stationId: stationOfB.id })
      .expect(400);
    expect(errorOf(foreign).code).toBe('INVALID_PREP_STATION');
  });

  it('CA-03.04: a product with its own station goes there; without it, to the category station', async () => {
    const category = await newCategory();
    const own = await post<{ prepStationId: string; stationId: string | null }>('/products', {
      categoryId: category.id,
      name: 'Pastel',
      priceCents: 800,
      stationId: stationsA.delivery,
    });
    const inherited = await post<{ prepStationId: string; stationId: string | null }>('/products', {
      categoryId: category.id,
      name: 'Espeto',
      priceCents: 1200,
    });
    expect(own).toMatchObject({ stationId: stationsA.delivery, prepStationId: stationsA.delivery });
    expect(inherited).toMatchObject({ stationId: null, prepStationId: stationsA.kitchen });

    // Changing the category station moves the products that follow it.
    await http()
      .patch(`${API}/categories/${category.id}`)
      .set(as(tenantA.ownerAuth))
      .send({ defaultStationId: stationsA.delivery })
      .expect(200);
    const menu = await menuOf(tenantA.ownerAuth);
    const products = menu.categories.find((c) => c.id === category.id)?.products ?? [];
    expect(products.map((p) => p.prepStationId)).toEqual([stationsA.delivery, stationsA.delivery]);
  });

  it('RN-03.09: price in integer cents, zero or more; description up to 120 characters', async () => {
    const category = await newCategory();
    for (const body of [
      { priceCents: -1 },
      { priceCents: 10.5 },
      { priceCents: 100, description: 'x'.repeat(121) },
    ]) {
      const response = await http()
        .post(`${API}/products`)
        .set(as(tenantA.ownerAuth))
        .send({ categoryId: category.id, name: 'Inválido', ...body })
        .expect(400);
      expect(errorOf(response).code).toBe('VALIDATION_FAILED');
    }
    await post('/products', { categoryId: category.id, name: 'Cortesia', priceCents: 0 });
  });

  it('RN-03.13 / RN-03.14: modifier groups (required and optional) and options', async () => {
    const category = await newCategory();
    const product = await post('/products', {
      categoryId: category.id,
      name: 'Espeto de carne',
      priceCents: 1200,
    });
    const doneness = await post<{ required: boolean; modifiers: { name: string }[] }>(
      '/modifier-groups',
      {
        productId: product.id,
        name: 'Ponto da carne',
        minChoices: 1,
        maxChoices: 1,
        modifiers: [{ name: 'Mal passado' }, { name: 'Ao ponto' }, { name: 'Bem passado' }],
      },
    );
    expect(doneness.required).toBe(true);
    expect(doneness.modifiers.map((m) => m.name)).toEqual([
      'Mal passado',
      'Ao ponto',
      'Bem passado',
    ]);
    const remove = await post<Ids & { required: boolean }>('/modifier-groups', {
      productId: product.id,
      name: 'Retirar',
      minChoices: 0,
      maxChoices: 5,
      modifiers: [{ name: 'Sem cebola', priceDeltaCents: 0 }],
    });
    expect(remove.required).toBe(false);
    const extra = await post<{ priceDeltaCents: number; sortOrder: number }>('/modifiers', {
      modifierGroupId: remove.id,
      name: 'Pão de alho',
      priceDeltaCents: 300,
    });
    expect(extra).toMatchObject({ priceDeltaCents: 300, sortOrder: 2 });

    for (const limits of [
      { minChoices: 2, maxChoices: 1 },
      { minChoices: 0, maxChoices: 0 },
    ]) {
      const response = await http()
        .post(`${API}/modifier-groups`)
        .set(as(tenantA.ownerAuth))
        .send({ productId: product.id, name: 'Errado', ...limits })
        .expect(400);
      expect(errorOf(response).code).toBe('INVALID_MODIFIER_LIMITS');
    }
    const patch = await http()
      .patch(`${API}/modifier-groups/${remove.id}`)
      .set(as(tenantA.ownerAuth))
      .send({ minChoices: 6 })
      .expect(400);
    expect(errorOf(patch).code).toBe('INVALID_MODIFIER_LIMITS');
    const negative = await http()
      .post(`${API}/modifiers`)
      .set(as(tenantA.ownerAuth))
      .send({ modifierGroupId: remove.id, name: 'Desconto', priceDeltaCents: -100 })
      .expect(400);
    expect(errorOf(negative).code).toBe('VALIDATION_FAILED');

    // CA-03.06 (data): the counter knows which groups are required and their limits.
    const menu = await menuOf(tenantA.ownerAuth);
    const groups =
      menu.categories.find((c) => c.id === category.id)?.products[0]?.modifierGroups ?? [];
    expect(groups.map((g) => [g.name, g.required, g.minChoices, g.maxChoices])).toEqual([
      ['Ponto da carne', true, 1, 1],
      ['Retirar', false, 0, 5],
    ]);

    // Deleting a group deletes its options.
    await http()
      .delete(`${API}/modifier-groups/${remove.id}`)
      .set(as(tenantA.ownerAuth))
      .expect(204);
    expect(await platform.modifier.count({ where: { modifierGroupId: remove.id } })).toBe(0);
    expect(
      await platform.auditLog.count({
        where: { action: 'modifier_group.deleted', entityId: remove.id },
      }),
    ).toBe(1);
  });

  it('reorders categories and products; the new order must list every item once', async () => {
    const { tenant } = { tenant: await createTenant(platform, 'Ordem') };
    await withTemplate(platform, tenant);
    const owner = tenant.ownerAuth;
    const c1 = await post('/categories', { unitId: tenant.unitId, name: 'Um' }, owner);
    const c2 = await post('/categories', { unitId: tenant.unitId, name: 'Dois' }, owner);
    const reordered = await http()
      .put(`${API}/units/${tenant.unitId}/categories/order`)
      .set(as(owner))
      .send({ categoryIds: [c2.id, c1.id] })
      .expect(200);
    expect((reordered.body as { data: Ids[] }).data.map((c) => c.id)).toEqual([c2.id, c1.id]);
    const invalid = await http()
      .put(`${API}/units/${tenant.unitId}/categories/order`)
      .set(as(owner))
      .send({ categoryIds: [c2.id] })
      .expect(400);
    expect(errorOf(invalid).code).toBe('INVALID_ORDER');

    const p1 = await post('/products', { categoryId: c1.id, name: 'A', priceCents: 1 }, owner);
    const p2 = await post('/products', { categoryId: c1.id, name: 'B', priceCents: 2 }, owner);
    const products = await http()
      .put(`${API}/categories/${c1.id}/products/order`)
      .set(as(owner))
      .send({ productIds: [p2.id, p1.id] })
      .expect(200);
    expect((products.body as { data: Ids[] }).data.map((p) => p.id)).toEqual([p2.id, p1.id]);
    const duplicated = await http()
      .put(`${API}/categories/${c1.id}/products/order`)
      .set(as(owner))
      .send({ productIds: [p2.id, p2.id] })
      .expect(400);
    expect(errorOf(duplicated).code).toBe('INVALID_ORDER');

    const menu = await menuOf(owner, tenant.unitId);
    expect(menu.categories.map((c) => c.name)).toEqual(['Dois', 'Um']);
    expect(menu.categories[1]?.products.map((p) => p.name)).toEqual(['B', 'A']);
  });

  it('every menu change bumps the menu version; a stale product version is a 409', async () => {
    const before = await menuOf(tenantA.ownerAuth);
    const category = await newCategory();
    const product = await post<Ids & { version: number }>('/products', {
      categoryId: category.id,
      name: 'Versão',
      priceCents: 100,
    });
    expect((await menuOf(tenantA.ownerAuth)).version).toBe(before.version + 2);
    await http()
      .patch(`${API}/products/${product.id}`)
      .set(as(tenantA.ownerAuth))
      .send({ priceCents: 150, version: product.version })
      .expect(200);
    const stale = await http()
      .patch(`${API}/products/${product.id}`)
      .set(as(tenantA.ownerAuth))
      .send({ priceCents: 200, version: product.version })
      .expect(409);
    expect(errorOf(stale)).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: product.version + 1 },
    });
  });

  describe('staff of the unit (RN-03.10, RN-03.11)', () => {
    let staff: Tenant;
    let stations: TemplateStations;
    let productId: string;
    let hiddenId: string;

    beforeAll(async () => {
      staff = await createTenant(platform, 'Equipe');
      stations = await withTemplate(platform, staff);
      const owner = staff.ownerAuth;
      const category = await post('/categories', { unitId: staff.unitId, name: 'Espetos' }, owner);
      const off = await post(
        '/categories',
        { unitId: staff.unitId, name: 'Fora', active: false },
        owner,
      );
      productId = (
        await post('/products', { categoryId: category.id, name: 'Carne', priceCents: 1200 }, owner)
      ).id;
      hiddenId = (
        await post(
          '/products',
          { categoryId: category.id, name: 'Inativo', priceCents: 1, active: false },
          owner,
        )
      ).id;
      await post('/products', { categoryId: off.id, name: 'Escondido', priceCents: 1 }, owner);
    });

    it('a staff member of the unit reads only active items; without access, 403', async () => {
      const denied = await http()
        .get(`${API}/units/${staff.unitId}/menu`)
        .set(as(staff.auth))
        .expect(403);
      expect(errorOf(denied).code).toBe('FORBIDDEN');

      await grantUnit(platform, staff, [stations.kitchen]);
      const menu = await menuOf(staff.auth, staff.unitId);
      expect(menu.categories.map((c) => c.name)).toEqual(['Espetos']);
      expect(menu.categories[0]?.products.map((p) => p.id)).toEqual([productId]);
      const owners = await menuOf(staff.ownerAuth, staff.unitId);
      expect(owners.categories.flatMap((c) => c.products.map((p) => p.id))).toContain(hiddenId);
    });

    it('RN-03.11: staff with a station of the unit marks and unmarks sold out; without a station, 403', async () => {
      await grantUnit(platform, staff, []);
      const denied = await http()
        .post(`${API}/products/${productId}/sold-out`)
        .set(as(staff.auth))
        .expect(403);
      expect(errorOf(denied).code).toBe('FORBIDDEN');

      await grantUnit(platform, staff, [stations.kitchen]);
      const marked = await http()
        .post(`${API}/products/${productId}/sold-out`)
        .set(as(staff.auth))
        .expect(200);
      expect(marked.body).toMatchObject({ id: productId, soldOut: true });
      // RN-03.10: sold out stays in the menu, blocked.
      const menu = await menuOf(staff.auth, staff.unitId);
      expect(menu.categories[0]?.products[0]).toMatchObject({ id: productId, soldOut: true });
      // Repeating changes nothing.
      const again = await http()
        .post(`${API}/products/${productId}/sold-out`)
        .set(as(staff.auth))
        .expect(200);
      expect((again.body as { version: number }).version).toBe(
        (marked.body as { version: number }).version,
      );
      await http().delete(`${API}/products/${productId}/sold-out`).set(as(staff.auth)).expect(200);
      const audit = await platform.auditLog.findMany({
        where: { action: 'product.sold_out_changed', entityId: productId },
      });
      expect(audit).toHaveLength(2);
      expect(audit[0]).toMatchObject({ actorType: 'staff', actorId: staff.staffMemberId });
    });

    it('staff cannot change the menu (owner only)', async () => {
      const calls = [
        () => http().post(`${API}/categories`).send({ unitId: staff.unitId, name: 'X' }),
        () => http().patch(`${API}/products/${productId}`).send({ priceCents: 1 }),
        () => http().put(`${API}/units/${staff.unitId}/categories/order`).send({ categoryIds: [] }),
        () =>
          http()
            .post(`${API}/modifier-groups`)
            .send({ productId, name: 'X', minChoices: 0, maxChoices: 1 }),
      ];
      for (const call of calls) {
        const response = await call().set(as(staff.auth));
        expect(response.status).toBe(403);
      }
    });
  });

  describe('isolation between organizations (CA-01.02)', () => {
    const context = () => ctx;
    const unique = () => crypto.randomUUID().slice(0, 8);

    async function stationOf(db: IsolationContext['prisma']['db'], tenant: Tenant) {
      return db.station.create({
        data: {
          organizationId: requireOrganizationId(),
          unitId: tenant.unitId,
          name: `Fila ${unique()}`,
          kind: 'queue',
          sortOrder: 99,
          attentionAfterMinutes: 7,
          lateAfterMinutes: 15,
        },
      });
    }

    async function categoryOf(db: IsolationContext['prisma']['db'], tenant: Tenant) {
      const station = await stationOf(db, tenant);
      return db.category.create({
        data: {
          organizationId: requireOrganizationId(),
          unitId: tenant.unitId,
          name: `Cat ${unique()}`,
          sortOrder: 1,
          defaultStationId: station.id,
        },
      });
    }

    async function productOf(db: IsolationContext['prisma']['db'], tenant: Tenant) {
      const category = await categoryOf(db, tenant);
      return db.product.create({
        data: {
          organizationId: requireOrganizationId(),
          unitId: tenant.unitId,
          categoryId: category.id,
          name: 'P',
          priceCents: 100,
          sortOrder: 1,
        },
      });
    }

    async function groupOf(db: IsolationContext['prisma']['db'], tenant: Tenant) {
      const product = await productOf(db, tenant);
      return db.modifierGroup.create({
        data: {
          organizationId: requireOrganizationId(),
          productId: product.id,
          name: 'G',
          minChoices: 0,
          maxChoices: 1,
          sortOrder: 1,
        },
      });
    }

    describeTenantIsolation('Station', {
      context,
      delegate: (db) => db.station,
      create: stationOf,
      update: { name: 'Invadida' },
    });

    describeTenantIsolation('WorkflowStage', {
      context,
      delegate: (db) => db.workflowStage,
      create: (db, tenant) =>
        db.workflowStage.create({
          data: {
            organizationId: requireOrganizationId(),
            unitId: tenant.unitId,
            name: 'Arquivada',
            sortOrder: 50,
            target: 'product_station',
            archivedAt: new Date(),
          },
        }),
      update: { name: 'Invadida' },
    });

    describeTenantIsolation('Category', {
      context,
      delegate: (db) => db.category,
      create: categoryOf,
      update: { name: 'Invadida' },
    });

    describeTenantIsolation('Product', {
      context,
      delegate: (db) => db.product,
      create: productOf,
      update: { priceCents: 1 },
    });

    describeTenantIsolation('ModifierGroup', {
      context,
      delegate: (db) => db.modifierGroup,
      create: groupOf,
      update: { name: 'Invadido' },
    });

    describeTenantIsolation('Modifier', {
      context,
      delegate: (db) => db.modifier,
      create: async (db, tenant) => {
        const group = await groupOf(db, tenant);
        return db.modifier.create({
          data: {
            organizationId: requireOrganizationId(),
            modifierGroupId: group.id,
            name: 'M',
            sortOrder: 1,
          },
        });
      },
      update: { priceDeltaCents: 999 },
    });

    it('the owner and staff of B get 404 for every menu route with ids of A', async () => {
      const category = await newCategory();
      const product = await post('/products', {
        categoryId: category.id,
        name: 'Alvo',
        priceCents: 100,
      });
      const group = await post('/modifier-groups', {
        productId: product.id,
        name: 'Alvo',
        minChoices: 0,
        maxChoices: 1,
        modifiers: [{ name: 'Opção' }],
      });
      const modifier = await platform.modifier.findFirstOrThrow({
        where: { modifierGroupId: group.id },
      });
      const routes: {
        method: 'get' | 'post' | 'patch' | 'put' | 'delete';
        path: string;
        body?: object;
      }[] = [
        { method: 'get', path: `${API}/units/${tenantA.unitId}/menu` },
        { method: 'patch', path: `${API}/categories/${category.id}`, body: { name: 'X' } },
        {
          method: 'put',
          path: `${API}/units/${tenantA.unitId}/categories/order`,
          body: { categoryIds: [category.id] },
        },
        { method: 'patch', path: `${API}/products/${product.id}`, body: { priceCents: 1 } },
        {
          method: 'put',
          path: `${API}/categories/${category.id}/products/order`,
          body: { productIds: [product.id] },
        },
        { method: 'post', path: `${API}/products/${product.id}/sold-out` },
        { method: 'delete', path: `${API}/products/${product.id}/sold-out` },
        { method: 'patch', path: `${API}/modifier-groups/${group.id}`, body: { name: 'X' } },
        { method: 'delete', path: `${API}/modifier-groups/${group.id}` },
        { method: 'patch', path: `${API}/modifiers/${modifier.id}`, body: { name: 'X' } },
      ];
      for (const route of routes) {
        await expectNotFoundForOtherTenant(app, { ...route, as: tenantB.ownerAuth });
      }
      await grantUnit(platform, tenantB);
      await expectNotFoundForOtherTenant(app, {
        method: 'post',
        path: `${API}/products/${product.id}/sold-out`,
        as: tenantB.auth,
      });
      // Creating under ids of A is refused like a missing reference.
      const creates: [string, object][] = [
        ['/categories', { unitId: tenantA.unitId, name: 'Invasora' }],
        ['/products', { categoryId: category.id, name: 'Invasor', priceCents: 1 }],
        ['/modifier-groups', { productId: product.id, name: 'X', minChoices: 0, maxChoices: 1 }],
        ['/modifiers', { modifierGroupId: group.id, name: 'X' }],
      ];
      for (const [path, body] of creates) {
        const response = await http().post(`${API}${path}`).set(as(tenantB.ownerAuth)).send(body);
        expect([400, 404]).toContain(response.status);
      }
      const unchanged = await platform.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(unchanged).toMatchObject({ priceCents: 100, soldOut: false });
      expect(await platform.modifier.count({ where: { modifierGroupId: group.id } })).toBe(1);
    });
  });
});
