import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Env } from '../../src/config/env.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { createTenant, type Tenant } from '../support/isolation-kit.js';

const databaseUrl = inject('databaseUrl');

/** Rules of spec 01, section 12 that live in the migration SQL (not expressible in Prisma). */
describe.skipIf(!databaseUrl)('database constraints (spec 01, section 12)', () => {
  const platform = new PlatformPrismaService({ DATABASE_URL: databaseUrl ?? '' } as Env);
  let tenantA: Tenant;
  let tenantB: Tenant;

  beforeAll(async () => {
    tenantA = await createTenant(platform, 'Restrições A');
    tenantB = await createTenant(platform, 'Restrições B');
  });

  afterAll(async () => {
    await platform.$disconnect();
  });

  it.each(['ABC12O', 'ABC12I', 'ABC120', 'abcdef', 'ABCDE', 'ABCDEFG'])(
    'refuses the access code %s (6 chars, uppercase, no 0/O or 1/I)',
    async (accessCode) => {
      await expect(
        platform.organization.create({ data: { name: 'X', accessCode } }),
      ).rejects.toThrow();
    },
  );

  it('keeps e-mails in lowercase for owners and platform admins', async () => {
    await expect(
      platform.user.create({
        data: { organizationId: tenantA.organizationId, name: 'X', email: 'Dono@Teste.local' },
      }),
    ).rejects.toThrow();
    await expect(
      platform.platformAdmin.create({ data: { name: 'X', email: 'Admin@Teste.local' } }),
    ).rejects.toThrow();
  });

  it('makes usernames unique per organization ignoring case, and free across organizations', async () => {
    const username = `Ana.${crypto.randomUUID().slice(0, 6)}`;
    await platform.staffMember.create({
      data: { organizationId: tenantA.organizationId, name: 'Ana', username },
    });
    await expect(
      platform.staffMember.create({
        data: {
          organizationId: tenantA.organizationId,
          name: 'Ana 2',
          username: username.toLowerCase(),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      platform.staffMember.create({
        data: { organizationId: tenantB.organizationId, name: 'Ana', username },
      }),
    ).resolves.toMatchObject({ username });
  });

  it('accepts only letters, digits, dot and underscore in usernames', async () => {
    await expect(
      platform.staffMember.create({
        data: { organizationId: tenantA.organizationId, name: 'X', username: 'ana silva' },
      }),
    ).rejects.toThrow();
  });

  it('makes unit names unique within the organization', async () => {
    const name = `Barraca ${crypto.randomUUID()}`;
    await platform.unit.create({ data: { organizationId: tenantA.organizationId, name } });
    await expect(
      platform.unit.create({ data: { organizationId: tenantA.organizationId, name } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      platform.unit.create({ data: { organizationId: tenantB.organizationId, name } }),
    ).resolves.toBeDefined();
  });

  it('generates UUID v7 ids', async () => {
    const unit = await platform.unit.findUniqueOrThrow({ where: { id: tenantA.unitId } });
    expect(unit.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
