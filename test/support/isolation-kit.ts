/**
 * Isolation test kit (spec 01, section 6; base of CA-01.02).
 *
 * Every new tenant resource proves that organization B can neither read nor change the data of
 * organization A. Two levels:
 *
 * - Database: {@link describeTenantIsolation} runs the standard checks on a model through the
 *   tenant-scoped client (reads see nothing, writes affect nothing, A's row is unchanged).
 * - HTTP: {@link expectNotFoundForOtherTenant} asserts that an endpoint answers 404 `NOT_FOUND`
 *   when called by B with an id of A (same answer as a missing id, so ids do not leak).
 *
 * ```ts
 * describeTenantIsolation('Unit', {
 *   context: () => ctx,                        // { prisma, tenantA, tenantB } from beforeAll
 *   delegate: (db) => db.unit,
 *   create: (db) => db.unit.create({ data: { organizationId: requireOrganizationId(), name: 'Barraca' } }),
 *   update: { name: 'Invadida' },
 * });
 * ```
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { generateAccessCode } from '../../src/common/access-code.js';
import {
  type AuthContext,
  runWithContext,
  systemContext,
} from '../../src/context/request-context.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import type { PrismaService, TenantDb } from '../../src/prisma/prisma.service.js';
import { authHeaders } from './stub-auth.js';

export interface Tenant {
  organizationId: string;
  unitId: string;
  ownerId: string;
  staffMemberId: string;
  /** Auth context of the staff member of this tenant. */
  auth: AuthContext;
  /** Auth context of the owner of this tenant. */
  ownerAuth: AuthContext;
}

function uniqueSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Creates an organization with a unit, an owner and a staff member, through the unscoped client
 * (as the platform admin would, spec 02). Names are unique, so files can share the test database.
 */
export async function createTenant(platform: PrismaClient, label = 'Tenant'): Promise<Tenant> {
  const suffix = uniqueSuffix();
  let organizationId: string | undefined;
  for (let attempt = 0; organizationId === undefined; attempt++) {
    try {
      const created = await platform.organization.create({
        data: { name: `${label} ${suffix}`, accessCode: generateAccessCode() },
      });
      organizationId = created.id;
    } catch (error) {
      // Access code collision: try another one (unique index on access_code).
      if (attempt >= 5) {
        throw error;
      }
    }
  }
  const unit = await platform.unit.create({ data: { organizationId, name: `Unidade ${suffix}` } });
  const owner = await platform.user.create({
    data: { organizationId, name: `Dono ${suffix}`, email: `dono.${suffix}@teste.local` },
  });
  const staff = await platform.staffMember.create({
    data: { organizationId, name: `Colaborador ${suffix}`, username: `colab_${suffix}` },
  });
  return {
    organizationId,
    unitId: unit.id,
    ownerId: owner.id,
    staffMemberId: staff.id,
    auth: { organizationId, actor: { type: 'staff', id: staff.id } },
    ownerAuth: { organizationId, actor: { type: 'owner', id: owner.id } },
  };
}

/**
 * Runs `fn` as if inside a request authenticated as `auth` (no HTTP needed).
 *
 * Prisma queries are lazy: they run when awaited. `fn` is awaited inside the context, so a query
 * returned without `await` still runs with the organization of `auth`.
 */
export function asTenant<T>(auth: AuthContext, fn: () => PromiseLike<T>): Promise<T> {
  return runWithContext(systemContext({ auth }), async () => await fn());
}

type Where = Record<string, unknown>;

/** The part of a Prisma model delegate the standard checks use. */
export interface IsolationDelegate {
  findUnique(args: { where: { id: string } }): PromiseLike<unknown>;
  findFirst(args: { where: Where }): PromiseLike<unknown>;
  findMany(args: { where: Where }): PromiseLike<unknown[]>;
  count(args: { where: Where }): PromiseLike<number>;
  update(args: { where: { id: string }; data: Where }): PromiseLike<unknown>;
  updateMany(args: { where: Where; data: Where }): PromiseLike<{ count: number }>;
  delete(args: { where: { id: string } }): PromiseLike<unknown>;
  deleteMany(args: { where: Where }): PromiseLike<{ count: number }>;
}

export interface IsolationContext {
  prisma: PrismaService;
  tenantA: Tenant;
  tenantB: Tenant;
}

export interface TenantIsolationSpec {
  /** Filled in `beforeAll` of the enclosing suite. */
  context: () => IsolationContext;
  delegate: (db: TenantDb) => IsolationDelegate;
  /** Creates a row as tenant A (runs inside A's context) and returns its id. */
  create: (db: TenantDb, tenant: Tenant) => PromiseLike<{ id: string }>;
  /** A valid change for the row, used to try to alter it as tenant B. */
  update: Where;
  /** Set to false for models that are never removed through the tenant client (e.g. Organization). */
  canDelete?: boolean;
}

/** Prisma "record not found" (P2025), rendered as 404 by the API. */
const RECORD_NOT_FOUND = { code: 'P2025' };

/** Registers the standard isolation checks of one tenant model (CA-01.02 at the data layer). */
export function describeTenantIsolation(model: string, spec: TenantIsolationSpec): void {
  describe(`${model}: organization B cannot see or change organization A (CA-01.02)`, () => {
    async function setup() {
      const { prisma, tenantA, tenantB } = spec.context();
      const { id } = await asTenant(tenantA.auth, () => spec.create(prisma.db, tenantA));
      const asB = <T>(fn: (delegate: IsolationDelegate) => PromiseLike<T>) =>
        asTenant(tenantB.auth, () => fn(spec.delegate(prisma.db)));
      const readAsA = () =>
        asTenant(tenantA.auth, () => spec.delegate(prisma.db).findUnique({ where: { id } }));
      return { id, asB, readAsA };
    }

    it('reads nothing of A by id, filter, list or count', async () => {
      const { id, asB, readAsA } = await setup();
      await expect(asB((d) => d.findUnique({ where: { id } }))).resolves.toBeNull();
      await expect(asB((d) => d.findFirst({ where: { id } }))).resolves.toBeNull();
      await expect(asB((d) => d.findMany({ where: { id } }))).resolves.toEqual([]);
      await expect(asB((d) => d.count({ where: { id } }))).resolves.toBe(0);
      await expect(readAsA()).resolves.toMatchObject({ id });
    });

    it('changes nothing of A by id or in bulk', async () => {
      const { id, asB, readAsA } = await setup();
      const before = await readAsA();
      await expect(
        asB((d) => d.update({ where: { id }, data: spec.update })),
      ).rejects.toMatchObject(RECORD_NOT_FOUND);
      await expect(asB((d) => d.updateMany({ where: { id }, data: spec.update }))).resolves.toEqual(
        {
          count: 0,
        },
      );
      await expect(readAsA()).resolves.toEqual(before);
    });

    if (spec.canDelete !== false) {
      it('removes nothing of A by id or in bulk', async () => {
        const { id, asB, readAsA } = await setup();
        await expect(asB((d) => d.delete({ where: { id } }))).rejects.toMatchObject(
          RECORD_NOT_FOUND,
        );
        await expect(asB((d) => d.deleteMany({ where: { id } }))).resolves.toEqual({ count: 0 });
        await expect(readAsA()).resolves.toMatchObject({ id });
      });
    }
  });
}

/**
 * HTTP level of CA-01.02: `as` (organization B) calling a route with an id of organization A gets
 * 404 `NOT_FOUND`, the same answer as a missing id.
 *
 * `as` authenticates through the stub (`createTestApp()`); with the real authentication
 * (`createTestApp({ auth: 'real' })`) pass the session cookie of B in `headers` instead
 * (`{ Cookie: jar.header() }`, see auth-kit.ts).
 */
export async function expectNotFoundForOtherTenant(
  app: NestExpressApplication,
  options: {
    method: 'get' | 'post' | 'patch' | 'put' | 'delete';
    path: string;
    as?: AuthContext;
    headers?: Record<string, string>;
    body?: object;
  },
): Promise<void> {
  let call = request(app.getHttpServer())
    [options.method](options.path)
    .set(options.as ? authHeaders(options.as) : {})
    .set(options.headers ?? {});
  if (options.body !== undefined) {
    call = call.send(options.body);
  }
  const response = await call;
  expect(response.status).toBe(404);
  expect(response.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
}
