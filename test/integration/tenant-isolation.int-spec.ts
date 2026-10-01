import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { Env } from '../../src/config/env.js';
import { requireOrganizationId } from '../../src/context/request-context.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { TenantScopeError } from '../../src/prisma/tenant-scope.extension.js';
import {
  asTenant,
  createTenant,
  describeTenantIsolation,
  expectNotFoundForOtherTenant,
  type IsolationContext,
} from '../support/isolation-kit.js';
import { authHeaders } from '../support/stub-auth.js';
import { createTestApp } from '../support/test-app.js';
import { InfrastructureTestModule } from '../support/test-routes.js';

const databaseUrl = inject('databaseUrl');

describe.skipIf(!databaseUrl)(
  'tenant isolation through the scoped client (spec 01, section 6)',
  () => {
    const platform = new PlatformPrismaService({ DATABASE_URL: databaseUrl ?? '' } as Env);
    const prisma = new PrismaService(platform);
    let ctx: IsolationContext;
    const context = () => ctx;

    beforeAll(async () => {
      ctx = {
        prisma,
        tenantA: await createTenant(platform, 'Org A'),
        tenantB: await createTenant(platform, 'Org B'),
      };
    });

    afterAll(async () => {
      await platform.$disconnect();
    });

    describeTenantIsolation('Unit', {
      context,
      delegate: (db) => db.unit,
      create: (db) =>
        db.unit.create({
          data: { organizationId: requireOrganizationId(), name: `U ${crypto.randomUUID()}` },
        }),
      update: { name: 'Invadida' },
    });

    describeTenantIsolation('User (owner)', {
      context,
      delegate: (db) => db.user,
      create: (db) =>
        db.user.create({
          data: {
            organizationId: requireOrganizationId(),
            name: 'Dono',
            email: `dono.${crypto.randomUUID()}@teste.local`,
          },
        }),
      update: { name: 'Invadido' },
    });

    describeTenantIsolation('StaffMember', {
      context,
      delegate: (db) => db.staffMember,
      create: (db) =>
        db.staffMember.create({
          data: {
            organizationId: requireOrganizationId(),
            name: 'Ana',
            username: `ana_${crypto.randomUUID().slice(0, 8)}`,
          },
        }),
      update: { active: false },
    });

    describeTenantIsolation('StaffUnitPermission', {
      context,
      delegate: (db) => db.staffUnitPermission,
      create: async (db, tenant) => {
        const staff = await db.staffMember.create({
          data: {
            organizationId: tenant.organizationId,
            name: 'Bruno',
            username: `bruno_${crypto.randomUUID().slice(0, 8)}`,
          },
        });
        return db.staffUnitPermission.create({
          data: {
            organizationId: tenant.organizationId,
            staffMemberId: staff.id,
            unitId: tenant.unitId,
          },
        });
      },
      update: { canOperateCash: true },
    });

    describeTenantIsolation('Organization', {
      context,
      delegate: (db) => db.organization,
      create: (_db, tenant) => Promise.resolve({ id: tenant.organizationId }),
      update: { name: 'Invadida' },
      canDelete: false,
    });

    it('lists only the rows of the organization in the context', async () => {
      const units = await asTenant(ctx.tenantB.auth, () => prisma.db.unit.findMany());
      expect(units.length).toBeGreaterThan(0);
      expect(units.every((unit) => unit.organizationId === ctx.tenantB.organizationId)).toBe(true);
    });

    it('fills organization_id from the context on create', async () => {
      const unit = await asTenant(ctx.tenantA.auth, () =>
        prisma.db.unit.create({
          // The value written by the caller is checked against the context.
          data: { organizationId: ctx.tenantA.organizationId, name: `Nova ${crypto.randomUUID()}` },
        }),
      );
      expect(unit.organizationId).toBe(ctx.tenantA.organizationId);
    });

    it('refuses to create a row for another organization', async () => {
      await expect(
        asTenant(ctx.tenantA.auth, () =>
          prisma.db.unit.create({
            data: { organizationId: ctx.tenantB.organizationId, name: 'Intrusa' },
          }),
        ),
      ).rejects.toBeInstanceOf(TenantScopeError);
    });

    it('fails when a tenant table is touched without an organization in the context', async () => {
      await expect(prisma.db.unit.findMany()).rejects.toBeInstanceOf(TenantScopeError);
      await expect(
        asTenant(
          { organizationId: null, actor: { type: 'platform_admin', id: ctx.tenantA.ownerId } },
          () => prisma.db.user.count(),
        ),
      ).rejects.toBeInstanceOf(TenantScopeError);
    });

    it('keeps tables without organization reachable (platform data, filtered by hand)', async () => {
      await expect(prisma.db.platformAdmin.count()).resolves.toBeGreaterThanOrEqual(0);
    });

    it('applies inside transactions too', async () => {
      const seen = await asTenant(ctx.tenantB.auth, () =>
        prisma.transaction((tx) => tx.unit.findUnique({ where: { id: ctx.tenantA.unitId } })),
      );
      expect(seen).toBeNull();
    });

    it('a permission cannot point to a staff member or unit of another organization (composite keys)', async () => {
      await expect(
        platform.staffUnitPermission.create({
          data: {
            organizationId: ctx.tenantA.organizationId,
            staffMemberId: ctx.tenantA.staffMemberId,
            unitId: ctx.tenantB.unitId,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('the unscoped platform client sees every organization (admin only)', async () => {
      const count = await platform.organization.count({
        where: { id: { in: [ctx.tenantA.organizationId, ctx.tenantB.organizationId] } },
      });
      expect(count).toBe(2);
    });
  },
);

describe.skipIf(!databaseUrl)('tenant isolation over HTTP (base of CA-01.02)', () => {
  let app: NestExpressApplication;
  let platform: PlatformPrismaService;
  let ctx: Omit<IsolationContext, 'prisma'>;

  beforeAll(async () => {
    app = await createTestApp({
      imports: [InfrastructureTestModule],
      databaseUrl: databaseUrl ?? '',
    });
    platform = app.get(PlatformPrismaService);
    ctx = {
      tenantA: await createTenant(platform, 'Org A'),
      tenantB: await createTenant(platform, 'Org B'),
    };
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('organization A reads its own unit', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/test/units/${ctx.tenantA.unitId}`)
      .set(authHeaders(ctx.tenantA.auth))
      .expect(200);
  });

  it('a staff member of B gets 404 for a unit of A, like a missing id', async () => {
    await expectNotFoundForOtherTenant(app, {
      method: 'get',
      path: `/api/v1/test/units/${ctx.tenantA.unitId}`,
      as: ctx.tenantB.auth,
    });
    await expectNotFoundForOtherTenant(app, {
      method: 'get',
      path: `/api/v1/test/units/${crypto.randomUUID()}`,
      as: ctx.tenantB.auth,
    });
  });
});
