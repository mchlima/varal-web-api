/**
 * Example data for development (spec 01, CA-01.01). Idempotent: running it again changes nothing.
 * Run with `pnpm db:seed` (the `scripts/worktree.sh new` calls it after the migrations).
 *
 * - Organization "Espetinho do Piloto" (`pilot`), access code ESPT26 (login link `/e/ESPT26`).
 * - Unit "Barraca da Praça".
 * - Owner dono@varal.local; staff members `ana` (operates cash) and `bruno`.
 * - Platform admin admin@varal.local.
 * - DEVELOPMENT ONLY password `varal12345` for the owner, both staff members and the admin. It is set
 *   only while the password is empty, so a password changed locally survives a new seed. The script
 *   refuses to run with NODE_ENV=production.
 *
 * The default stations and workflow of the unit come with spec 03.
 */
import { hashPassword } from '../src/auth/password-hasher.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

export const SEED = {
  organization: { name: 'Espetinho do Piloto', accessCode: 'ESPT26' },
  unit: { name: 'Barraca da Praça' },
  owner: { name: 'Dono do Piloto', email: 'dono@varal.local' },
  staff: [
    { name: 'Ana', username: 'ana', canOperateCash: true },
    { name: 'Bruno', username: 'bruno', canOperateCash: false },
  ],
  platformAdmin: { name: 'Admin do Varal', email: 'admin@varal.local' },
  /** Development only (README). */
  devPassword: 'varal12345',
} as const;

export interface SeedResult {
  organizationId: string;
  unitId: string;
  ownerId: string;
  staffMemberIds: string[];
  platformAdminId: string;
}

/** Uses the unscoped client: the seed runs outside any request, like the platform admin would. */
export async function seed(prisma: PrismaClient): Promise<SeedResult> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The seed has development passwords and never runs in production');
  }
  // Hashed outside the transaction (argon2 takes a moment); used only where the password is empty.
  const passwordHash = await hashPassword(SEED.devPassword);
  return prisma.$transaction(async (tx) => {
    const organization = await tx.organization.upsert({
      where: { accessCode: SEED.organization.accessCode },
      create: { ...SEED.organization, subscriptionStatus: 'pilot' },
      update: {},
    });
    const organizationId = organization.id;

    const unit = await tx.unit.upsert({
      where: { organizationId_name: { organizationId, name: SEED.unit.name } },
      create: { organizationId, name: SEED.unit.name },
      update: {},
    });

    const owner = await tx.user.upsert({
      where: { email: SEED.owner.email },
      create: { organizationId, ...SEED.owner, passwordHash, emailVerifiedAt: new Date() },
      update: {},
    });
    await tx.user.updateMany({
      where: { id: owner.id, passwordHash: null },
      data: { passwordHash, emailVerifiedAt: new Date() },
    });

    const staffMemberIds: string[] = [];
    for (const { canOperateCash, ...staff } of SEED.staff) {
      // Unique by (organization_id, lower(username)): an expression index Prisma cannot upsert on.
      const existing = await tx.staffMember.findFirst({
        where: { organizationId, username: { equals: staff.username, mode: 'insensitive' } },
      });
      const member =
        existing ??
        (await tx.staffMember.create({ data: { organizationId, ...staff, passwordHash } }));
      await tx.staffMember.updateMany({
        where: { id: member.id, passwordHash: null },
        data: { passwordHash },
      });
      await tx.staffUnitPermission.upsert({
        where: { staffMemberId_unitId: { staffMemberId: member.id, unitId: unit.id } },
        create: { organizationId, staffMemberId: member.id, unitId: unit.id, canOperateCash },
        update: {},
      });
      staffMemberIds.push(member.id);
    }

    const platformAdmin = await tx.platformAdmin.upsert({
      where: { email: SEED.platformAdmin.email },
      create: { ...SEED.platformAdmin, passwordHash },
      update: {},
    });
    await tx.platformAdmin.updateMany({
      where: { id: platformAdmin.id, passwordHash: null },
      data: { passwordHash },
    });

    return {
      organizationId,
      unitId: unit.id,
      ownerId: owner.id,
      staffMemberIds,
      platformAdminId: platformAdmin.id,
    };
  });
}

if (import.meta.main) {
  const { loadEnvFiles } = await import('../src/config/load-env.js');
  const { PrismaClient } = await import('../src/generated/prisma/client.js');
  const { createPgAdapter } = await import('../src/prisma/platform-prisma.service.js');
  loadEnvFiles();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }
  const prisma = new PrismaClient({ adapter: createPgAdapter(databaseUrl) });
  try {
    const result = await seed(prisma);
    console.log(
      `Seed ok: organização ${SEED.organization.name} (código ${SEED.organization.accessCode}), ` +
        `${result.staffMemberIds.length} colaboradores, dono ${SEED.owner.email}, admin ${SEED.platformAdmin.email}. ` +
        `Senha de desenvolvimento: ${SEED.devPassword}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}
