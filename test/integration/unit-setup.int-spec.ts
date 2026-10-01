import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { AuthContext } from '../../src/context/request-context.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { DEFAULT_TEMPLATE } from '../../src/units/unit-template.service.js';
import type { WorkflowDto } from '../../src/units/units.schemas.js';
import { errorOf } from '../support/http.js';
import {
  createTenant,
  expectNotFoundForOtherTenant,
  type Tenant,
} from '../support/isolation-kit.js';
import { templateService, type TemplateStations, withTemplate } from '../support/setup-kit.js';
import { authHeaders } from '../support/stub-auth.js';
import { createTestApp } from '../support/test-app.js';

const databaseUrl = inject('databaseUrl');
const API = '/api/v1';

describe.skipIf(!databaseUrl)('units, stations and workflow (spec 03, sections 3 and 4)', () => {
  let app: NestExpressApplication;
  let platform: PlatformPrismaService;
  let tenantA: Tenant;
  let tenantB: Tenant;
  let stationsA: TemplateStations;

  const http = () => request(app.getHttpServer());
  const as = (auth: AuthContext) => authHeaders(auth);

  beforeAll(async () => {
    app = await createTestApp({ databaseUrl: databaseUrl ?? '' });
    platform = app.get(PlatformPrismaService);
    tenantA = await createTenant(platform, 'Setup A');
    tenantB = await createTenant(platform, 'Setup B');
    stationsA = await withTemplate(platform, tenantA);
    await withTemplate(platform, tenantB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  /** A fresh tenant with the template, for tests that change its workflow or stations. */
  async function freshTenant(
    label: string,
  ): Promise<{ tenant: Tenant; stations: TemplateStations }> {
    const tenant = await createTenant(platform, label);
    return { tenant, stations: await withTemplate(platform, tenant) };
  }

  async function workflowOf(tenant: Tenant): Promise<WorkflowDto> {
    const response = await http()
      .get(`${API}/units/${tenant.unitId}/workflow`)
      .set(as(tenant.ownerAuth))
      .expect(200);
    return response.body as WorkflowDto;
  }

  describe('units (section 3)', () => {
    it('CA-03.01 / RN-03.03: a new unit has the default stations and workflow, and an empty menu', async () => {
      const name = `Barraca ${crypto.randomUUID().slice(0, 8)}`;
      const created = await http()
        .post(`${API}/units`)
        .set(as(tenantA.ownerAuth))
        .send({ name })
        .expect(201);
      const unit = created.body as { id: string; lateAfterMinutes: number; active: boolean };
      expect(unit).toMatchObject({ name, active: true, lateAfterMinutes: 15 });

      const stations = await http()
        .get(`${API}/units/${unit.id}/stations`)
        .set(as(tenantA.ownerAuth))
        .expect(200);
      expect(
        (stations.body as { data: { name: string; kind: string }[] }).data.map((s) => [
          s.name,
          s.kind,
        ]),
      ).toEqual([
        ['Balcão', 'counter'],
        ['Cozinha', 'queue'],
        ['Balcão de entrega', 'queue'],
      ]);
      const delivery = (stations.body as { data: { id: string; name: string }[] }).data.find(
        (station) => station.name === 'Balcão de entrega',
      );

      const workflow = await http()
        .get(`${API}/units/${unit.id}/workflow`)
        .set(as(tenantA.ownerAuth))
        .expect(200);
      expect(
        (workflow.body as WorkflowDto).stages.map((stage) => [
          stage.sortOrder,
          stage.name,
          stage.target,
          stage.stationId,
          stage.isFinal,
        ]),
      ).toEqual([
        [1, 'Recebido', 'product_station', null, false],
        [2, 'Preparando', 'product_station', null, false],
        [3, 'Pronto', 'fixed_station', delivery?.id, false],
        [4, 'Entregue', 'none', null, true],
      ]);

      const menu = await http()
        .get(`${API}/units/${unit.id}/menu`)
        .set(as(tenantA.ownerAuth))
        .expect(200);
      expect(menu.body).toMatchObject({ unitId: unit.id, categories: [] });

      const audit = await platform.auditLog.findMany({
        where: { entityType: 'unit', entityId: unit.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((row) => row.action)).toEqual(['unit.created', 'unit.template_applied']);
      expect(audit[0]).toMatchObject({ actorType: 'owner', actorId: tenantA.ownerId });
    });

    it('the template service is idempotent and refuses a unit of another organization', async () => {
      const unit = await platform.unit.create({
        data: { organizationId: tenantA.organizationId, name: `Idem ${crypto.randomUUID()}` },
      });
      const target = { organizationId: tenantA.organizationId, unitId: unit.id };
      const first = await platform.$transaction((tx) =>
        templateService.applyDefaultTemplate(tx, target),
      );
      const second = await platform.$transaction((tx) =>
        templateService.applyDefaultTemplate(tx, target),
      );
      expect(first.applied).toBe(true);
      expect(first.stationIds).toHaveLength(DEFAULT_TEMPLATE.stations.length);
      expect(second).toEqual({ applied: false, stationIds: [], stageIds: [] });
      expect(await platform.station.count({ where: { unitId: unit.id } })).toBe(3);
      expect(await platform.workflowStage.count({ where: { unitId: unit.id } })).toBe(4);

      await expect(
        platform.$transaction((tx) =>
          templateService.applyDefaultTemplate(tx, {
            organizationId: tenantB.organizationId,
            unitId: unit.id,
          }),
        ),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('late_after_minutes goes from 1 to 240 (default 15)', async () => {
      for (const lateAfterMinutes of [0, 241, 1.5]) {
        const response = await http()
          .post(`${API}/units`)
          .set(as(tenantA.ownerAuth))
          .send({ name: `Atraso ${crypto.randomUUID()}`, lateAfterMinutes })
          .expect(400);
        expect(errorOf(response).code).toBe('VALIDATION_FAILED');
      }
      const response = await http()
        .patch(`${API}/units/${tenantA.unitId}`)
        .set(as(tenantA.ownerAuth))
        .send({ lateAfterMinutes: 240 })
        .expect(200);
      expect(response.body).toMatchObject({ lateAfterMinutes: 240 });
    });

    it('lists the units of the organization only, paginated', async () => {
      const response = await http().get(`${API}/units?limit=100`).set(as(tenantB.ownerAuth));
      expect(response.status).toBe(200);
      const units = (response.body as { data: { id: string }[] }).data;
      expect(units.map((unit) => unit.id)).toContain(tenantB.unitId);
      expect(units.map((unit) => unit.id)).not.toContain(tenantA.unitId);
    });

    it('RN-03.01: the last active unit cannot be deactivated; another one can, and back', async () => {
      const { tenant } = await freshTenant('Ultima unidade');
      const last = await http()
        .patch(`${API}/units/${tenant.unitId}`)
        .set(as(tenant.ownerAuth))
        .send({ active: false })
        .expect(409);
      expect(errorOf(last).code).toBe('LAST_ACTIVE_UNIT');

      const second = await http()
        .post(`${API}/units`)
        .set(as(tenant.ownerAuth))
        .send({ name: 'Segunda' })
        .expect(201);
      const id = (second.body as { id: string }).id;
      await http()
        .patch(`${API}/units/${id}`)
        .set(as(tenant.ownerAuth))
        .send({ active: false })
        .expect(200);
      await http()
        .patch(`${API}/units/${id}`)
        .set(as(tenant.ownerAuth))
        .send({ active: true, name: 'Segunda (praia)' })
        .expect(200);
    });

    it('unit names are unique in the organization ignoring case; a stale version is a 409', async () => {
      const { tenant } = await freshTenant('Nomes');
      await http()
        .post(`${API}/units`)
        .set(as(tenant.ownerAuth))
        .send({ name: 'Feira de Domingo' })
        .expect(201);
      const taken = await http()
        .post(`${API}/units`)
        .set(as(tenant.ownerAuth))
        .send({ name: 'feira de domingo' })
        .expect(409);
      expect(errorOf(taken).code).toBe('UNIT_NAME_TAKEN');

      const unit = await platform.unit.findUniqueOrThrow({ where: { id: tenant.unitId } });
      await http()
        .patch(`${API}/units/${tenant.unitId}`)
        .set(as(tenant.ownerAuth))
        .send({ name: 'Nova', version: unit.version })
        .expect(200);
      const stale = await http()
        .patch(`${API}/units/${tenant.unitId}`)
        .set(as(tenant.ownerAuth))
        .send({ name: 'Velha', version: unit.version })
        .expect(409);
      expect(errorOf(stale)).toMatchObject({
        code: 'VERSION_CONFLICT',
        details: { currentVersion: unit.version + 1 },
      });
    });
  });

  describe('stations (section 4.1)', () => {
    it('creates stations with unique names in the unit (ignoring case)', async () => {
      const { tenant } = await freshTenant('Estações');
      const created = await http()
        .post(`${API}/units/${tenant.unitId}/stations`)
        .set(as(tenant.ownerAuth))
        .send({ name: 'Fritadeira', kind: 'queue' })
        .expect(201);
      expect(created.body).toMatchObject({ name: 'Fritadeira', kind: 'queue', sortOrder: 4 });
      const taken = await http()
        .post(`${API}/units/${tenant.unitId}/stations`)
        .set(as(tenant.ownerAuth))
        .send({ name: 'COZINHA', kind: 'queue' })
        .expect(409);
      expect(errorOf(taken).code).toBe('STATION_NAME_TAKEN');
      const audit = await platform.auditLog.count({
        where: { action: 'station.created', entityId: (created.body as { id: string }).id },
      });
      expect(audit).toBe(1);
    });

    it('RN-03.04: keeps one active counter and one active queue station', async () => {
      const { tenant, stations } = await freshTenant('RN-03.04');
      const counter = await http()
        .patch(`${API}/stations/${stations.counter}`)
        .set(as(tenant.ownerAuth))
        .send({ active: false })
        .expect(409);
      expect(errorOf(counter).code).toBe('STATION_KIND_REQUIRED');
      const retyped = await http()
        .patch(`${API}/stations/${stations.counter}`)
        .set(as(tenant.ownerAuth))
        .send({ kind: 'queue' })
        .expect(409);
      expect(errorOf(retyped).code).toBe('STATION_KIND_REQUIRED');

      // A second counter can go.
      const second = await http()
        .post(`${API}/units/${tenant.unitId}/stations`)
        .set(as(tenant.ownerAuth))
        .send({ name: 'Caixa 2', kind: 'counter' })
        .expect(201);
      await http()
        .patch(`${API}/stations/${(second.body as { id: string }).id}`)
        .set(as(tenant.ownerAuth))
        .send({ active: false })
        .expect(200);
    });

    it('a station used by the workflow or by a category stays an active queue (STATION_IN_USE)', async () => {
      const { tenant, stations } = await freshTenant('Em uso');
      const delivery = await http()
        .patch(`${API}/stations/${stations.delivery}`)
        .set(as(tenant.ownerAuth))
        .send({ active: false })
        .expect(409);
      expect(errorOf(delivery)).toMatchObject({
        code: 'STATION_IN_USE',
        details: { stages: 1, categories: 0, products: 0 },
      });

      await http()
        .post(`${API}/categories`)
        .set(as(tenant.ownerAuth))
        .send({ unitId: tenant.unitId, name: 'Espetos' })
        .expect(201);
      const kitchen = await http()
        .patch(`${API}/stations/${stations.kitchen}`)
        .set(as(tenant.ownerAuth))
        .send({ kind: 'counter' })
        .expect(409);
      expect(errorOf(kitchen)).toMatchObject({
        code: 'STATION_IN_USE',
        details: { categories: 1 },
      });
    });
  });

  describe('workflow (section 4.2)', () => {
    it('CA-03.02: refuses no final stage, two final stages, or a stage on a counter station', async () => {
      const { tenant, stations } = await freshTenant('CA-03.02');
      const cases: [object[], string][] = [
        [
          [
            { name: 'Recebido', target: 'product_station' },
            { name: 'Pronto', target: 'fixed_station', stationId: stations.delivery },
          ],
          'NO_FINAL_STAGE',
        ],
        [
          [
            { name: 'Recebido', target: 'product_station' },
            { name: 'Perdido', target: 'none' },
            { name: 'Entregue', target: 'none' },
          ],
          'MULTIPLE_FINAL_STAGES',
        ],
        [
          [
            { name: 'Recebido', target: 'fixed_station', stationId: stations.counter },
            { name: 'Entregue', target: 'none' },
          ],
          'STATION_NOT_QUEUE',
        ],
      ];
      const before = await workflowOf(tenant);
      for (const [stages, issue] of cases) {
        const response = await http()
          .put(`${API}/units/${tenant.unitId}/workflow`)
          .set(as(tenant.ownerAuth))
          .send({ stages })
          .expect(400);
        const error = errorOf(response);
        expect(error.code).toBe('INVALID_WORKFLOW');
        expect(
          (error.details as { issues: { code: string }[] }).issues.map((i) => i.code),
        ).toContain(issue);
      }
      // Nothing changed.
      expect(await workflowOf(tenant)).toEqual(before);
    });

    it('saves the whole workflow at once, keeping the ids of kept stages and archiving the others', async () => {
      const { tenant, stations } = await freshTenant('Fluxo');
      const before = await workflowOf(tenant);
      const [received, preparing, ready, delivered] = before.stages;
      const fryer = await http()
        .post(`${API}/units/${tenant.unitId}/stations`)
        .set(as(tenant.ownerAuth))
        .send({ name: 'Fritadeira', kind: 'queue' })
        .expect(201);
      const unitVersion = (await workflowOf(tenant)).version;

      const saved = await http()
        .put(`${API}/units/${tenant.unitId}/workflow`)
        .set(as(tenant.ownerAuth))
        .send({
          version: unitVersion,
          stages: [
            { id: received?.id, name: 'Na fila', target: 'product_station' },
            {
              name: 'Conferência',
              target: 'fixed_station',
              stationId: (fryer.body as { id: string }).id,
            },
            {
              id: ready?.id,
              name: 'Pronto',
              target: 'fixed_station',
              stationId: stations.delivery,
            },
            { id: delivered?.id, name: 'Entregue', target: 'none' },
          ],
        })
        .expect(200);
      const workflow = saved.body as WorkflowDto;
      expect(workflow.version).toBe(unitVersion + 1);
      expect(workflow.stages.map((stage) => [stage.sortOrder, stage.name])).toEqual([
        [1, 'Na fila'],
        [2, 'Conferência'],
        [3, 'Pronto'],
        [4, 'Entregue'],
      ]);
      expect(workflow.stages[0]?.id).toBe(received?.id);
      expect(workflow.stages[2]?.id).toBe(ready?.id);
      expect(workflow.stages[3]?.id).toBe(delivered?.id);

      // "Preparando" is archived, not deleted (items of past shifts keep pointing to it).
      const archived = await platform.workflowStage.findUniqueOrThrow({
        where: { id: preparing?.id ?? '' },
      });
      expect(archived.archivedAt).not.toBeNull();
      expect(
        await platform.auditLog.count({
          where: { action: 'workflow.updated', entityId: tenant.unitId },
        }),
      ).toBe(1);

      // The app saw an older workflow: 409.
      const stale = await http()
        .put(`${API}/units/${tenant.unitId}/workflow`)
        .set(as(tenant.ownerAuth))
        .send({ version: unitVersion, stages: [] })
        .expect(409);
      expect(errorOf(stale).code).toBe('VERSION_CONFLICT');

      // A stage id that is not a current stage of the unit.
      const unknown = await http()
        .put(`${API}/units/${tenant.unitId}/workflow`)
        .set(as(tenant.ownerAuth))
        .send({
          stages: [
            { id: preparing?.id, name: 'Recebido', target: 'product_station' },
            { name: 'Entregue', target: 'none' },
          ],
        })
        .expect(400);
      expect(errorOf(unknown).code).toBe('INVALID_REFERENCE');
    });
  });

  describe('open shift (RN-03.02, RN-03.07, RN-03.11, RN-03.12)', () => {
    it('CA-03.03: with an open shift, workflow and stations are refused with SHIFT_OPEN; menu changes go through', async () => {
      const { tenant, stations } = await freshTenant('Turno aberto');
      const category = await http()
        .post(`${API}/categories`)
        .set(as(tenant.ownerAuth))
        .send({ unitId: tenant.unitId, name: 'Espetos' })
        .expect(201);
      const product = await http()
        .post(`${API}/products`)
        .set(as(tenant.ownerAuth))
        .send({ categoryId: (category.body as { id: string }).id, name: 'Carne', priceCents: 1200 })
        .expect(201);
      const productId = (product.body as { id: string }).id;
      const workflow = await workflowOf(tenant);

      // A real open shift (spec 04) replaces the provisional checker of spec 03.
      await http()
        .post(`${API}/units/${tenant.unitId}/shifts`)
        .set(as(tenant.ownerAuth))
        .send({ type: 'direct_sale' })
        .expect(201);
      const refused = await Promise.all([
        http()
          .put(`${API}/units/${tenant.unitId}/workflow`)
          .set(as(tenant.ownerAuth))
          .send({
            stages: workflow.stages.map(({ id, name, target, stationId }) => ({
              id,
              name,
              target,
              stationId,
            })),
          }),
        http()
          .post(`${API}/units/${tenant.unitId}/stations`)
          .set(as(tenant.ownerAuth))
          .send({ name: 'Fritadeira', kind: 'queue' }),
        http()
          .patch(`${API}/stations/${stations.kitchen}`)
          .set(as(tenant.ownerAuth))
          .send({ name: 'Grelha' }),
      ]);
      for (const response of refused) {
        expect(response.status).toBe(409);
        expect(errorOf(response).code).toBe('SHIFT_OPEN');
      }
      // RN-03.02: the unit is not deactivated (a second unit exists, so RN-03.01 is not the cause).
      await http()
        .post(`${API}/units`)
        .set(as(tenant.ownerAuth))
        .send({ name: 'Outra' })
        .expect(201);
      const deactivate = await http()
        .patch(`${API}/units/${tenant.unitId}`)
        .set(as(tenant.ownerAuth))
        .send({ active: false })
        .expect(409);
      expect(errorOf(deactivate).code).toBe('SHIFT_OPEN');

      // RN-03.12 and RN-03.11: price and sold-out change with the shift open.
      await http()
        .patch(`${API}/products/${productId}`)
        .set(as(tenant.ownerAuth))
        .send({ priceCents: 1300 })
        .expect(200);
      await http()
        .post(`${API}/products/${productId}/sold-out`)
        .set(as(tenant.ownerAuth))
        .expect(200);
    });
  });

  describe('permissions and isolation', () => {
    it('staff members cannot change the setup (owner only, spec 03 section 8)', async () => {
      const calls = [
        () => http().get(`${API}/units`),
        () => http().post(`${API}/units`).send({ name: 'X' }),
        () => http().patch(`${API}/units/${tenantA.unitId}`).send({ name: 'X' }),
        () => http().get(`${API}/units/${tenantA.unitId}/stations`),
        () =>
          http().post(`${API}/units/${tenantA.unitId}/stations`).send({ name: 'X', kind: 'queue' }),
        () => http().patch(`${API}/stations/${stationsA.kitchen}`).send({ name: 'X' }),
        () => http().get(`${API}/units/${tenantA.unitId}/workflow`),
        () => http().put(`${API}/units/${tenantA.unitId}/workflow`).send({ stages: [] }),
      ];
      for (const call of calls) {
        const response = await call().set(as(tenantA.auth));
        expect(response.status).toBe(403);
        expect(errorOf(response).code).toBe('FORBIDDEN');
      }
    });

    it('CA-01.02: the owner of B gets 404 for every unit, station and workflow route of A', async () => {
      const routes: { method: 'get' | 'post' | 'patch' | 'put'; path: string; body?: object }[] = [
        { method: 'patch', path: `${API}/units/${tenantA.unitId}`, body: { name: 'Invadida' } },
        { method: 'get', path: `${API}/units/${tenantA.unitId}/stations` },
        {
          method: 'post',
          path: `${API}/units/${tenantA.unitId}/stations`,
          body: { name: 'Invasora', kind: 'queue' },
        },
        { method: 'patch', path: `${API}/stations/${stationsA.kitchen}`, body: { name: 'X' } },
        { method: 'get', path: `${API}/units/${tenantA.unitId}/workflow` },
        {
          method: 'put',
          path: `${API}/units/${tenantA.unitId}/workflow`,
          body: {
            stages: [
              { name: 'A', target: 'product_station' },
              { name: 'B', target: 'none' },
            ],
          },
        },
        { method: 'get', path: `${API}/units/nao-e-um-id/workflow` },
      ];
      for (const route of routes) {
        await expectNotFoundForOtherTenant(app, { ...route, as: tenantB.ownerAuth });
      }
      const kitchen = await platform.station.findUniqueOrThrow({
        where: { id: stationsA.kitchen },
      });
      expect(kitchen.name).toBe('Cozinha');
    });
  });
});
