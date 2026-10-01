import { afterAll, describe, expect, inject, it } from 'vitest';

import { verifyPassword } from '../../src/auth/password-hasher.js';
import type { Env } from '../../src/config/env.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { SEED, SEED_MENU, seed } from '../../scripts/seed.js';

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

  it('spec 03: the unit has the default template, an example menu and staff with stations', async () => {
    const result = await seed(platform);
    const stations = await platform.station.findMany({
      where: { unitId: result.unitId },
      orderBy: { sortOrder: 'asc' },
    });
    expect(stations.map((station) => station.name)).toEqual([
      'Balcão',
      'Cozinha',
      'Balcão de entrega',
    ]);
    const stages = await platform.workflowStage.findMany({
      where: { unitId: result.unitId },
      orderBy: { sortOrder: 'asc' },
    });
    expect(stages.map((stage) => stage.name)).toEqual([
      'Recebido',
      'Preparando',
      'Pronto',
      'Entregue',
    ]);
    const products = await platform.product.findMany({
      where: { unitId: result.unitId },
      include: { modifierGroups: { include: { modifiers: true } } },
    });
    expect(products.length).toBe(SEED_MENU.flatMap((category) => category.products).length);
    const meat = products.find((product) => product.name === 'Espeto de carne');
    expect(meat?.modifierGroups.map((group) => [group.name, group.minChoices])).toEqual(
      expect.arrayContaining([
        ['Ponto da carne', 1],
        ['Acompanhamentos', 0],
      ]),
    );
    const byName = new Map(stations.map((station) => [station.id, station.name]));
    const permissions = await platform.staffUnitPermission.findMany({
      where: { unitId: result.unitId },
      include: { staffMember: { select: { username: true } } },
    });
    expect(
      Object.fromEntries(
        permissions.map((permission) => [
          permission.staffMember.username,
          permission.stationIds.map((id) => byName.get(id)).sort(),
        ]),
      ),
    ).toEqual({ ana: ['Balcão', 'Balcão de entrega'], bruno: ['Cozinha'] });
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
        platform.station.count(),
        platform.workflowStage.count(),
        platform.category.count(),
        platform.product.count(),
        platform.modifierGroup.count(),
        platform.modifier.count(),
      ]);
    const first = await seed(platform);
    const before = await counts();
    const second = await seed(platform);
    expect(second).toEqual(first);
    expect(await counts()).toEqual(before);
  });
});
