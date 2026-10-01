import { afterAll, describe, expect, inject, it } from 'vitest';

import type { Env } from '../../src/config/env.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { SEED, seed } from '../../scripts/seed.js';

const databaseUrl = inject('databaseUrl');

describe.skipIf(!databaseUrl)('seed (CA-01.01)', () => {
  const platform = new PlatformPrismaService({ DATABASE_URL: databaseUrl ?? '' } as Env);

  afterAll(async () => {
    await platform.$disconnect();
  });

  it('creates the example organization, unit, owner, two staff members and a platform admin', async () => {
    const result = await seed(platform);
    const organization = await platform.organization.findUniqueOrThrow({
      where: { id: result.organizationId },
      include: { units: true, users: true, staffMembers: { include: { unitPermissions: true } } },
    });
    expect(organization).toMatchObject({
      name: 'Espetinho do Piloto',
      subscriptionStatus: 'pilot',
      accessCode: SEED.organization.accessCode,
    });
    expect(organization.units.map((unit) => unit.name)).toEqual([SEED.unit.name]);
    expect(organization.users.map((user) => user.email)).toEqual(['dono@varal.local']);
    expect(organization.staffMembers.map((staff) => staff.username).sort()).toEqual([
      'ana',
      'bruno',
    ]);
    expect(organization.staffMembers.every((staff) => staff.unitPermissions.length === 1)).toBe(
      true,
    );
    await expect(
      platform.platformAdmin.findUnique({ where: { email: 'admin@varal.local' } }),
    ).resolves.not.toBeNull();
  });

  it('is idempotent: a second run returns the same rows and creates nothing', async () => {
    const counts = () =>
      Promise.all([
        platform.organization.count(),
        platform.unit.count(),
        platform.user.count(),
        platform.staffMember.count(),
        platform.staffUnitPermission.count(),
        platform.platformAdmin.count(),
      ]);
    const first = await seed(platform);
    const before = await counts();
    const second = await seed(platform);
    expect(second).toEqual(first);
    expect(await counts()).toEqual(before);
  });
});
