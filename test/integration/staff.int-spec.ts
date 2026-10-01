import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { APP_ENV } from '../../src/config/config.module.js';
import type { Env } from '../../src/config/env.js';
import type { AuthContext } from '../../src/context/request-context.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import type { StaffMemberDto } from '../../src/staff/staff.schemas.js';
import { grantUnit } from '../support/auth-kit.js';
import { errorOf } from '../support/http.js';
import {
  createTenant,
  expectNotFoundForOtherTenant,
  type Tenant,
} from '../support/isolation-kit.js';
import { type TemplateStations, withTemplate } from '../support/setup-kit.js';
import { authHeaders } from '../support/stub-auth.js';
import { createTestApp } from '../support/test-app.js';

const databaseUrl = inject('databaseUrl');
const API = '/api/v1';
const PASSWORD = 'senha-inicial-123';

describe.skipIf(!databaseUrl)('staff members (spec 03, section 6)', () => {
  let app: NestExpressApplication;
  let platform: PlatformPrismaService;
  let tenantA: Tenant;
  let tenantB: Tenant;
  let stationsA: TemplateStations;
  let stationsB: TemplateStations;

  const http = () => request(app.getHttpServer());
  const as = (auth: AuthContext) => authHeaders(auth);
  const username = () => `colab_${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    app = await createTestApp({ databaseUrl: databaseUrl ?? '' });
    platform = app.get(PlatformPrismaService);
    tenantA = await createTenant(platform, 'Staff A');
    tenantB = await createTenant(platform, 'Staff B');
    stationsA = await withTemplate(platform, tenantA);
    stationsB = await withTemplate(platform, tenantB);
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  async function createStaff(
    tenant: Tenant,
    body: Record<string, unknown> = {},
  ): Promise<StaffMemberDto> {
    const response = await http()
      .post(`${API}/staff`)
      .set(as(tenant.ownerAuth))
      .send({ name: 'Joana', username: username(), password: PASSWORD, ...body });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body as StaffMemberDto;
  }

  it('RN-03.15: the owner registers a staff member with permissions; no secret in the response or audit', async () => {
    const staff = await createStaff(tenantA, {
      email: 'Joana@Exemplo.com',
      permissions: [
        {
          unitId: tenantA.unitId,
          stationIds: [stationsA.delivery, stationsA.counter],
          canOperateCash: true,
        },
      ],
    });
    expect(staff).toMatchObject({
      name: 'Joana',
      email: 'joana@exemplo.com',
      active: true,
      hasPassword: true,
      permissions: [
        {
          unitId: tenantA.unitId,
          canOperateCash: true,
          stations: [
            { id: stationsA.counter, name: 'Balcão', kind: 'counter' },
            { id: stationsA.delivery, name: 'Balcão de entrega', kind: 'queue' },
          ],
        },
      ],
    });
    expect(JSON.stringify(staff)).not.toContain('argon2');
    const audit = await platform.auditLog.findFirstOrThrow({
      where: { action: 'staff_member.created', entityId: staff.id },
    });
    expect(JSON.stringify(audit.changes)).not.toContain('argon2');
    expect(audit.actorType).toBe('owner');
  });

  it('CA-03.07: the same username twice in one organization is refused (ignoring case); in another, accepted', async () => {
    const name = username();
    await createStaff(tenantA, { username: name });
    const taken = await http()
      .post(`${API}/staff`)
      .set(as(tenantA.ownerAuth))
      .send({ name: 'Outro', username: name.toUpperCase(), password: PASSWORD })
      .expect(409);
    expect(errorOf(taken).code).toBe('USERNAME_TAKEN');
    await createStaff(tenantB, { username: name });

    const other = await createStaff(tenantA);
    const rename = await http()
      .patch(`${API}/staff/${other.id}`)
      .set(as(tenantA.ownerAuth))
      .send({ username: name })
      .expect(409);
    expect(errorOf(rename).code).toBe('USERNAME_TAKEN');
  });

  it('validates username, password and e-mail', async () => {
    for (const body of [
      { username: 'com espaço' },
      { username: 'ab' },
      { password: '1234567' },
      { email: 'nao-e-email' },
    ]) {
      const response = await http()
        .post(`${API}/staff`)
        .set(as(tenantA.ownerAuth))
        .send({ name: 'X', username: username(), password: PASSWORD, ...body })
        .expect(400);
      expect(errorOf(response).code).toBe('VALIDATION_FAILED');
    }
  });

  it('RN-03.16: permissions accept only units of the organization and active stations of that unit', async () => {
    const staff = await createStaff(tenantA);
    const second = await http()
      .post(`${API}/units`)
      .set(as(tenantA.ownerAuth))
      .send({ name: `Segunda ${crypto.randomUUID().slice(0, 6)}` })
      .expect(201);
    const secondUnit = (second.body as { id: string }).id;
    const invalid = [
      [{ unitId: tenantB.unitId, stationIds: [] }],
      [{ unitId: tenantA.unitId, stationIds: [stationsB.kitchen] }],
      [{ unitId: secondUnit, stationIds: [stationsA.kitchen] }],
      [
        { unitId: tenantA.unitId, stationIds: [] },
        { unitId: tenantA.unitId, stationIds: [] },
      ],
    ];
    for (const units of invalid) {
      const response = await http()
        .put(`${API}/staff/${staff.id}/permissions`)
        .set(as(tenantA.ownerAuth))
        .send({ units })
        .expect(400);
      expect(errorOf(response).code).toBe('INVALID_REFERENCE');
    }
    const saved = await http()
      .put(`${API}/staff/${staff.id}/permissions`)
      .set(as(tenantA.ownerAuth))
      .send({
        units: [
          { unitId: tenantA.unitId, stationIds: [stationsA.kitchen], canOperateCash: false },
          { unitId: secondUnit, stationIds: [], canOperateCash: true },
        ],
      })
      .expect(200);
    const permissions = (saved.body as StaffMemberDto).permissions;
    expect(permissions).toHaveLength(2);
    expect(permissions.find((p) => p.unitId === tenantA.unitId)?.stationIds).toEqual([
      stationsA.kitchen,
    ]);
    expect(
      await platform.auditLog.count({
        where: { action: 'staff_member.permissions_updated', entityId: staff.id },
      }),
    ).toBe(1);
  });

  it('lists the staff of the organization only', async () => {
    const response = await http().get(`${API}/staff?limit=100`).set(as(tenantB.ownerAuth));
    expect(response.status).toBe(200);
    const ids = (response.body as { data: StaffMemberDto[] }).data.map((staff) => staff.id);
    expect(ids).toContain(tenantB.staffMemberId);
    expect(ids).not.toContain(tenantA.staffMemberId);
  });

  it('RN-03.18: the reset link comes back to copy or send by WhatsApp, and by e-mail when asked', async () => {
    const staff = await createStaff(tenantA, { email: 'reset@exemplo.com' });
    const response = await http()
      .post(`${API}/staff/${staff.id}/password-reset`)
      .set(as(tenantA.ownerAuth))
      .send({ sendEmail: true })
      .expect(200);
    const body = response.body as { link: string; whatsappUrl: string; emailSent: boolean };
    const env = app.get<Env>(APP_ENV);
    expect(body.link.startsWith(`${env.PANEL_URL}/definir-senha#token=`)).toBe(true);
    expect(body.link).toContain('&tipo=redefinicao');
    expect(body.emailSent).toBe(true);
    expect(body.whatsappUrl.startsWith('https://wa.me/?text=')).toBe(true);
    expect(decodeURIComponent(body.whatsappUrl.slice('https://wa.me/?text='.length))).toContain(
      body.link,
    );

    const noEmail = await http()
      .post(`${API}/staff/${staff.id}/password-reset`)
      .set(as(tenantA.ownerAuth))
      .send({})
      .expect(200);
    expect((noEmail.body as { emailSent: boolean }).emailSent).toBe(false);
  });

  it('GET /organization/access: code, link /e/{code} and an SVG QR code', async () => {
    const response = await http()
      .get(`${API}/organization/access`)
      .set(as(tenantA.ownerAuth))
      .expect(200);
    const organization = await platform.organization.findUniqueOrThrow({
      where: { id: tenantA.organizationId },
    });
    const env = app.get<Env>(APP_ENV);
    expect(response.body).toMatchObject({
      accessCode: organization.accessCode,
      link: `${env.PANEL_URL}/e/${organization.accessCode}`,
    });
    expect((response.body as { qrSvg: string }).qrSvg.startsWith('<svg')).toBe(true);
  });

  it('staff members cannot manage staff nor see the access code (owner only)', async () => {
    await grantUnit(platform, tenantA);
    const calls = [
      () => http().get(`${API}/staff`),
      () =>
        http().post(`${API}/staff`).send({ name: 'X', username: username(), password: PASSWORD }),
      () => http().patch(`${API}/staff/${tenantA.staffMemberId}`).send({ name: 'X' }),
      () => http().put(`${API}/staff/${tenantA.staffMemberId}/permissions`).send({ units: [] }),
      () => http().post(`${API}/staff/${tenantA.staffMemberId}/password-reset`).send({}),
      () =>
        http().put(`${API}/staff/${tenantA.staffMemberId}/password`).send({ password: PASSWORD }),
      () => http().get(`${API}/organization/access`),
    ];
    for (const call of calls) {
      const response = await call().set(as(tenantA.auth));
      expect(response.status).toBe(403);
    }
  });

  it('CA-01.02: the owner of B gets 404 for every staff route with a staff member of A', async () => {
    const id = tenantA.staffMemberId;
    const routes: { method: 'patch' | 'put' | 'post'; path: string; body: object }[] = [
      { method: 'patch', path: `${API}/staff/${id}`, body: { name: 'Invadido' } },
      { method: 'put', path: `${API}/staff/${id}/permissions`, body: { units: [] } },
      { method: 'post', path: `${API}/staff/${id}/password-reset`, body: {} },
      { method: 'put', path: `${API}/staff/${id}/password`, body: { password: PASSWORD } },
    ];
    for (const route of routes) {
      await expectNotFoundForOtherTenant(app, { ...route, as: tenantB.ownerAuth });
    }
    const staff = await platform.staffMember.findUniqueOrThrow({ where: { id } });
    expect(staff.name).not.toBe('Invadido');
  });
});
