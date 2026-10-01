/**
 * Example data for development (spec 01, CA-01.01). Idempotent: running it again changes nothing.
 * Run with `pnpm db:seed` (the `scripts/worktree.sh new` calls it after the migrations).
 *
 * - Organization "Espetinho do Piloto" (`pilot`), access code ESPT26 (login link `/e/ESPT26`).
 * - Unit "Barraca da Praça" with the default stations and workflow (spec 03, section 4.4) and an
 *   example skewer menu: categories, products with modifiers (meat doneness, side dishes,
 *   "Retirar") and drinks routed to the delivery counter (RN-03.08).
 * - Owner dono@varal.local; staff members `ana` (Balcão and Balcão de entrega, operates cash) and
 *   `bruno` (Cozinha).
 * - An open shift (spec 04) in the unit with three tabs and orders in different stages, for the
 *   counter, station and owner screens: created once, only when the unit has never had a shift
 *   (close it in the app and the seed will not open another).
 * - In that shift (spec 05), "Caixa 1" opened by `ana` with R$ 100,00 of float, a partial Pix on
 *   "Mesa da família" and a "paga antes" tab paid in cash with change: created once, while the
 *   open shift has no cash register.
 * - Platform admin admin@varal.local, with the Super admin role (spec 02, RN-02.05). The system roles
 *   come from the migration; the seed only creates any that are missing (never changes them).
 * - DEVELOPMENT ONLY password `varal12345` for the owner, both staff members and the admin. It is set
 *   only while the password is empty, so a password changed locally survives a new seed. The script
 *   refuses to run with NODE_ENV=production.
 */
import { SUPER_ADMIN_KEY, SYSTEM_ROLE_KEYS, SYSTEM_ROLES } from '../src/admin/rbac/permissions.js';
import { AuditService } from '../src/audit/audit.service.js';
import { hashPassword } from '../src/auth/password-hasher.js';
import type { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import { UnitTemplateService } from '../src/units/unit-template.service.js';

interface SeedModifierGroup {
  name: string;
  minChoices: number;
  maxChoices: number;
  modifiers: readonly { name: string; priceDeltaCents: number }[];
}

interface SeedProduct {
  name: string;
  description?: string;
  priceCents: number;
  /** Own preparation station (RN-03.08); otherwise the category's. */
  station?: string;
  groups?: readonly SeedModifierGroup[];
}

const DONENESS: SeedModifierGroup = {
  name: 'Ponto da carne',
  minChoices: 1,
  maxChoices: 1,
  modifiers: [
    { name: 'Mal passado', priceDeltaCents: 0 },
    { name: 'Ao ponto', priceDeltaCents: 0 },
    { name: 'Bem passado', priceDeltaCents: 0 },
  ],
};

const SIDES: SeedModifierGroup = {
  name: 'Acompanhamentos',
  minChoices: 0,
  maxChoices: 3,
  modifiers: [
    { name: 'Farofa', priceDeltaCents: 0 },
    { name: 'Vinagrete', priceDeltaCents: 0 },
    { name: 'Pão de alho', priceDeltaCents: 300 },
  ],
};

/** RN-03.14: removing an ingredient is a zero-delta modifier. */
const REMOVE: SeedModifierGroup = {
  name: 'Retirar',
  minChoices: 0,
  maxChoices: 2,
  modifiers: [
    { name: 'Sem cebola', priceDeltaCents: 0 },
    { name: 'Sem pimentão', priceDeltaCents: 0 },
  ],
};

/** Example menu of the pilot (skewers). Categories go to the Cozinha unless stated. */
export const SEED_MENU: readonly {
  name: string;
  station?: string;
  products: readonly SeedProduct[];
}[] = [
  {
    name: 'Espetos',
    products: [
      { name: 'Espeto de carne', priceCents: 1200, groups: [DONENESS, SIDES] },
      { name: 'Espeto de frango', priceCents: 1000, groups: [SIDES] },
      { name: 'Espeto de linguiça', priceCents: 1000, groups: [SIDES] },
      { name: 'Kafta', priceCents: 1100, groups: [DONENESS, SIDES, REMOVE] },
      { name: 'Queijo coalho', description: 'Com melaço de cana', priceCents: 900 },
    ],
  },
  {
    name: 'Porções',
    products: [
      { name: 'Pão de alho', priceCents: 700 },
      { name: 'Mandioca frita', priceCents: 1500 },
    ],
  },
  {
    name: 'Bebidas',
    station: 'Balcão de entrega',
    products: [
      { name: 'Refrigerante lata', priceCents: 600 },
      { name: 'Água mineral', priceCents: 400 },
      { name: 'Suco natural', description: 'Feito na hora', priceCents: 800, station: 'Cozinha' },
    ],
  },
];

/** Stations each seeded staff member opens (by name, from the default template). */
const SEED_STAFF_STATIONS: Record<string, readonly string[]> = {
  ana: ['Balcão', 'Balcão de entrega'],
  bruno: ['Cozinha'],
};

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
    // RN-03.03: default stations and workflow; does nothing when the unit already has them.
    await new UnitTemplateService(new AuditService()).applyDefaultTemplate(tx, {
      organizationId,
      unitId: unit.id,
    });
    const stations = await tx.station.findMany({ where: { organizationId, unitId: unit.id } });
    const stationId = (name: string): string => {
      const station = stations.find((row) => row.name === name);
      if (!station) {
        throw new Error(`Seed: station "${name}" not found in ${SEED.unit.name}`);
      }
      return station.id;
    };
    await seedMenu(tx, { organizationId, unitId: unit.id }, stationId);

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
      const stationIds = (SEED_STAFF_STATIONS[staff.username] ?? []).map(stationId);
      const permission = await tx.staffUnitPermission.upsert({
        where: { staffMemberId_unitId: { staffMemberId: member.id, unitId: unit.id } },
        create: {
          organizationId,
          staffMemberId: member.id,
          unitId: unit.id,
          canOperateCash,
          stationIds,
        },
        update: {},
      });
      // Databases seeded before spec 03 have no stations in the permission yet.
      if (permission.stationIds.length === 0 && stationIds.length > 0) {
        await tx.staffUnitPermission.update({
          where: { id: permission.id },
          data: { stationIds },
        });
      }
      staffMemberIds.push(member.id);
    }

    await seedShift(tx, { organizationId, unitId: unit.id, ownerId: owner.id });
    await seedCash(tx, { organizationId, unitId: unit.id, cashierId: staffMemberIds[0] ?? null });

    const platformAdmin = await tx.platformAdmin.upsert({
      where: { email: SEED.platformAdmin.email },
      create: { ...SEED.platformAdmin, passwordHash },
      update: {},
    });
    await tx.platformAdmin.updateMany({
      where: { id: platformAdmin.id, passwordHash: null },
      data: { passwordHash },
    });

    // System roles of spec 02 (normally created by the migration): create the missing ones only.
    for (const key of SYSTEM_ROLE_KEYS) {
      const definition = SYSTEM_ROLES[key];
      const existing = await tx.role.findUnique({ where: { systemKey: key } });
      if (existing) {
        continue;
      }
      const role = await tx.role.create({
        data: { name: definition.name, isSystem: true, systemKey: key },
      });
      if (definition.permissions !== 'all') {
        await tx.rolePermission.createMany({
          data: definition.permissions.map((permission) => ({ roleId: role.id, permission })),
        });
      }
    }
    const superAdmin = await tx.role.findUniqueOrThrow({ where: { systemKey: SUPER_ADMIN_KEY } });
    await tx.platformAdminRole.upsert({
      where: {
        platformAdminId_roleId: { platformAdminId: platformAdmin.id, roleId: superAdmin.id },
      },
      create: { platformAdminId: platformAdmin.id, roleId: superAdmin.id },
      update: {},
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

/** Creates the example menu once: rows are looked up by name, so a second run adds nothing. */
async function seedMenu(
  tx: Prisma.TransactionClient,
  scope: { organizationId: string; unitId: string },
  stationId: (name: string) => string,
): Promise<void> {
  const { organizationId, unitId } = scope;
  for (const [categoryIndex, seedCategory] of SEED_MENU.entries()) {
    const category =
      (await tx.category.findFirst({
        where: { organizationId, unitId, name: seedCategory.name },
      })) ??
      (await tx.category.create({
        data: {
          organizationId,
          unitId,
          name: seedCategory.name,
          sortOrder: categoryIndex + 1,
          defaultStationId: stationId(seedCategory.station ?? 'Cozinha'),
        },
      }));
    for (const [productIndex, seedProduct] of seedCategory.products.entries()) {
      if (
        await tx.product.findFirst({
          where: { organizationId, categoryId: category.id, name: seedProduct.name },
        })
      ) {
        continue;
      }
      const product = await tx.product.create({
        data: {
          organizationId,
          unitId,
          categoryId: category.id,
          name: seedProduct.name,
          description: seedProduct.description ?? null,
          priceCents: seedProduct.priceCents,
          stationId: seedProduct.station === undefined ? null : stationId(seedProduct.station),
          sortOrder: productIndex + 1,
        },
      });
      for (const [groupIndex, seedGroup] of (seedProduct.groups ?? []).entries()) {
        const group = await tx.modifierGroup.create({
          data: {
            organizationId,
            productId: product.id,
            name: seedGroup.name,
            minChoices: seedGroup.minChoices,
            maxChoices: seedGroup.maxChoices,
            sortOrder: groupIndex + 1,
          },
        });
        await tx.modifier.createMany({
          data: seedGroup.modifiers.map((modifier, modifierIndex) => ({
            organizationId,
            modifierGroupId: group.id,
            name: modifier.name,
            priceDeltaCents: modifier.priceDeltaCents,
            sortOrder: modifierIndex + 1,
          })),
        });
      }
    }
  }
}

interface SeedLine {
  product: string;
  quantity: number;
  /** Option names of the menu (group order kept). */
  modifiers?: readonly string[];
  note?: string;
  /** Index of the stage (0 = Recebido … 3 = Entregue). */
  stage: number;
  /** Advance part of the line (RN-04.24): this quantity goes one stage ahead, in a split line. */
  splitAhead?: number;
}

interface SeedTab {
  customerName: string;
  status: 'open' | 'closing';
  /** Minutes since the order was sent (more than 15 shows the items as late). */
  minutesAgo: number;
  lines: readonly SeedLine[];
}

/** Example tabs of the open shift (spec 04): numbers 1, 2 and 3. */
export const SEED_TABS: readonly SeedTab[] = [
  {
    customerName: 'Dona Marta',
    status: 'open',
    minutesAgo: 20,
    lines: [
      { product: 'Espeto de carne', quantity: 3, modifiers: ['Ao ponto', 'Farofa'], stage: 1 },
      { product: 'Refrigerante lata', quantity: 2, stage: 2 },
    ],
  },
  {
    customerName: 'Seu João',
    status: 'open',
    minutesAgo: 6,
    lines: [
      {
        product: 'Kafta',
        quantity: 1,
        modifiers: ['Bem passado', 'Sem cebola'],
        note: 'Bem tostada',
        stage: 0,
      },
      {
        product: 'Espeto de frango',
        quantity: 3,
        modifiers: ['Vinagrete'],
        stage: 1,
        splitAhead: 2,
      },
      { product: 'Pão de alho', quantity: 1, stage: 3 },
    ],
  },
  {
    customerName: 'Mesa da família',
    status: 'closing',
    minutesAgo: 35,
    lines: [
      { product: 'Queijo coalho', quantity: 2, stage: 3 },
      { product: 'Água mineral', quantity: 1, stage: 3 },
    ],
  },
];

/**
 * Open shift with example tabs (spec 04), written once: nothing happens when the unit already has
 * (or had) a shift. Items copy name and price of the menu (RN-04.18) and sit at the station of
 * their stage (spec 03, section 4.2).
 */
async function seedShift(
  tx: Prisma.TransactionClient,
  scope: { organizationId: string; unitId: string; ownerId: string },
): Promise<void> {
  const { organizationId, unitId, ownerId } = scope;
  if ((await tx.shift.count({ where: { organizationId, unitId } })) > 0) {
    return;
  }
  const stages = await tx.workflowStage.findMany({
    where: { organizationId, unitId, archivedAt: null },
    orderBy: { sortOrder: 'asc' },
  });
  const products = await tx.product.findMany({
    where: { organizationId, unitId },
    include: { category: true, modifierGroups: { include: { modifiers: true } } },
  });
  const now = Date.now();
  const shift = await tx.shift.create({
    data: {
      organizationId,
      unitId,
      type: 'direct_sale',
      status: 'open',
      openedByType: 'owner',
      openedById: ownerId,
      openedAt: new Date(now - 60 * 60_000),
      nextTabNumber: SEED_TABS.length + 1,
    },
  });
  for (const [tabIndex, seedTab] of SEED_TABS.entries()) {
    const sentAt = new Date(now - seedTab.minutesAgo * 60_000);
    const tab = await tx.tab.create({
      data: {
        organizationId,
        shiftId: shift.id,
        unitId,
        number: tabIndex + 1,
        customerName: seedTab.customerName,
        mode: 'open_tab',
        status: seedTab.status,
        openedByType: 'owner',
        openedById: ownerId,
        createdAt: sentAt,
      },
    });
    const done = seedTab.lines.every((line) => stages[line.stage]?.isFinal === true);
    const order = await tx.order.create({
      data: {
        organizationId,
        tabId: tab.id,
        shiftId: shift.id,
        numberInTab: 1,
        status: done ? 'completed' : 'sent',
        createdByType: 'owner',
        createdById: ownerId,
        sentAt,
        completedAt: done ? new Date(now) : null,
      },
    });
    for (const [position, line] of seedTab.lines.entries()) {
      const product = products.find((row) => row.name === line.product);
      if (!product) {
        throw new Error(`Seed: product "${line.product}" not found`);
      }
      const prepStationId = product.stationId ?? product.category.defaultStationId;
      const placed = (stageIndex: number) => {
        const stage = stages[stageIndex];
        if (!stage) {
          throw new Error(`Seed: stage ${stageIndex} not found`);
        }
        const station =
          stage.target === 'product_station'
            ? prepStationId
            : stage.target === 'fixed_station'
              ? stage.stationId
              : null;
        return { stageId: stage.id, stationId: station };
      };
      const modifiers = product.modifierGroups
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .flatMap((group) =>
          group.modifiers
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .filter((modifier) => line.modifiers?.includes(modifier.name))
            .map((modifier) => ({
              modifierId: modifier.id,
              groupName: group.name,
              modifierName: modifier.name,
              priceDeltaCents: modifier.priceDeltaCents,
            })),
        );
      const copy = {
        organizationId,
        orderId: order.id,
        tabId: tab.id,
        unitId,
        productId: product.id,
        productName: product.name,
        unitPriceCents: product.priceCents,
        note: line.note ?? null,
        position,
        prepStationId,
      };
      const ahead = line.splitAhead ?? 0;
      const original = await tx.orderItem.create({
        data: {
          ...copy,
          ...placed(line.stage),
          quantity: line.quantity - ahead,
          stageEnteredAt: sentAt,
          version: ahead > 0 ? 1 : 0,
        },
      });
      const lines = [original];
      if (ahead > 0) {
        lines.push(
          await tx.orderItem.create({
            data: {
              ...copy,
              ...placed(line.stage + 1),
              quantity: ahead,
              stageEnteredAt: new Date(now - 60_000),
              splitFromId: original.id,
            },
          }),
        );
      }
      for (const item of lines) {
        await tx.orderItemModifier.createMany({
          data: modifiers.map((modifier, index) => ({
            organizationId,
            orderItemId: item.id,
            position: index,
            ...modifier,
          })),
        });
      }
    }
  }
}

/** The "paga antes" tab of the seed (spec 05): two sodas, paid in cash with R$ 20,00. */
export const SEED_PAY_FIRST = {
  customerName: 'Lucas',
  product: 'Refrigerante lata',
  quantity: 2,
  tenderedCents: 2000,
} as const;

/**
 * A cash register with payments in the open example shift (spec 05), written once: nothing happens
 * without an open shift or when it already has a register.
 */
async function seedCash(
  tx: Prisma.TransactionClient,
  scope: { organizationId: string; unitId: string; cashierId: string | null },
): Promise<void> {
  const { organizationId, unitId, cashierId } = scope;
  const shift = await tx.shift.findFirst({ where: { organizationId, unitId, status: 'open' } });
  if (
    !shift ||
    (await tx.cashRegister.count({ where: { organizationId, shiftId: shift.id } })) > 0
  ) {
    return;
  }
  const actor =
    cashierId === null
      ? { type: 'system' as const, id: null }
      : { type: 'staff' as const, id: cashierId };
  const register = await tx.cashRegister.create({
    data: {
      organizationId,
      shiftId: shift.id,
      unitId,
      name: 'Caixa 1',
      status: 'open',
      openingFloatCents: 10_000,
      openedByType: actor.type,
      openedById: actor.id,
      openedAt: shift.openedAt,
    },
  });
  const payment = (
    tabId: string,
    method: 'pix' | 'cash',
    amountCents: number,
    tenderedCents?: number,
  ) =>
    tx.payment.create({
      data: {
        organizationId,
        tabId,
        shiftId: shift.id,
        cashRegisterId: register.id,
        method,
        amountCents,
        tenderedCents: tenderedCents ?? null,
        changeCents: tenderedCents === undefined ? null : tenderedCents - amountCents,
        receivedByType: actor.type,
        receivedById: actor.id,
      },
    });

  // A partial Pix on the tab in `closing`: half of its total, the rest still to receive.
  const closing = await tx.tab.findFirst({
    where: { organizationId, shiftId: shift.id, status: 'closing' },
    include: { items: { include: { modifiers: true } } },
  });
  if (closing) {
    const total = closing.items
      .filter((item) => item.canceledAt === null)
      .reduce(
        (sum, item) =>
          sum +
          (item.unitPriceCents +
            item.modifiers.reduce((acc, mod) => acc + mod.priceDeltaCents, 0)) *
            item.quantity,
        0,
      );
    if (total > 1) {
      await payment(closing.id, 'pix', Math.floor(total / 2));
    }
  }

  // A "paga antes" tab, born paid, with its drinks already delivered.
  const product = await tx.product.findFirst({
    where: { organizationId, unitId, name: SEED_PAY_FIRST.product },
    include: { category: true },
  });
  const final = await tx.workflowStage.findFirst({
    where: { organizationId, unitId, archivedAt: null, isFinal: true },
  });
  if (!product || !final) {
    return;
  }
  const numbered = await tx.shift.update({
    where: { id: shift.id },
    data: { nextTabNumber: { increment: 1 } },
  });
  const now = new Date();
  const tab = await tx.tab.create({
    data: {
      organizationId,
      shiftId: shift.id,
      unitId,
      number: numbered.nextTabNumber - 1,
      customerName: SEED_PAY_FIRST.customerName,
      mode: 'pay_first',
      status: 'paid',
      openedByType: actor.type,
      openedById: actor.id,
      closedAt: now,
    },
  });
  const order = await tx.order.create({
    data: {
      organizationId,
      tabId: tab.id,
      shiftId: shift.id,
      numberInTab: 1,
      status: 'completed',
      createdByType: actor.type,
      createdById: actor.id,
      sentAt: now,
      completedAt: now,
    },
  });
  await tx.orderItem.create({
    data: {
      organizationId,
      orderId: order.id,
      tabId: tab.id,
      unitId,
      productId: product.id,
      productName: product.name,
      unitPriceCents: product.priceCents,
      quantity: SEED_PAY_FIRST.quantity,
      position: 0,
      prepStationId: product.stationId ?? product.category.defaultStationId,
      stageId: final.id,
      stationId: null,
      stageEnteredAt: now,
    },
  });
  const total = product.priceCents * SEED_PAY_FIRST.quantity;
  await payment(tab.id, 'cash', total, Math.max(total, SEED_PAY_FIRST.tenderedCents));
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
        `unidade com estações, fluxo, cardápio e um turno aberto de exemplo com um caixa, ${result.staffMemberIds.length} colaboradores, dono ${SEED.owner.email}, admin ${SEED.platformAdmin.email}. ` +
        `Senha de desenvolvimento: ${SEED.devPassword}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}
