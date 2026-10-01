import { afterAll, describe, expect, inject, it } from 'vitest';

import { verifyPassword } from '../../src/auth/password-hasher.js';
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

  it('sets the development password of the owner, the staff and the admin (only while empty)', async () => {
    const result = await seed(platform);
    const owner = await platform.user.findUniqueOrThrow({ where: { id: result.ownerId } });
    const staff = await platform.staffMember.findMany({
      where: { id: { in: result.staffMemberIds } },
    });
    const admin = await platform.platformAdmin.findUniqueOrThrow({
      where: { id: result.platformAdminId },
    });
    for (const hashed of [
      owner.passwordHash,
      ...staff.map((row) => row.passwordHash),
      admin.passwordHash,
    ]) {
      await expect(verifyPassword(hashed, SEED.devPassword)).resolves.toBe(true);
    }
    expect(owner.emailVerifiedAt).not.toBeNull();

    // A password changed locally survives a new seed.
    await platform.user.update({ where: { id: owner.id }, data: { passwordHash: 'changed' } });
    await seed(platform);
    await expect(
      platform.user.findUniqueOrThrow({ where: { id: owner.id } }),
    ).resolves.toMatchObject({
      passwordHash: 'changed',
    });
    await platform.user.update({
      where: { id: owner.id },
      data: { passwordHash: owner.passwordHash },
    });
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
