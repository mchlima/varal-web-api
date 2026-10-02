import { afterAll, describe, expect, inject, it } from 'vitest';

import { verifyPassword } from '../../src/auth/password-hasher.js';
import type { Env } from '../../src/config/env.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import {
  SEED,
  SEED_CUSTOMERS,
  SEED_MENU,
  SEED_ON_CREDIT,
  SEED_PAY_FIRST,
  SEED_PRICE_LIST,
  SEED_TABS,
  seed,
} from '../../scripts/seed.js';

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

  it('spec 03: "Caixa 1" and the price list "Evento", not current (fase 7.5)', async () => {
    const result = await seed(platform);
    const registers = await platform.cashRegister.findMany({ where: { unitId: result.unitId } });
    expect(registers.map((row) => [row.name, row.active])).toEqual([['Caixa 1', true]]);
    const lists = await platform.priceList.findMany({
      where: { unitId: result.unitId },
      include: { prices: { include: { product: true } } },
    });
    expect(lists.map((list) => [list.name, list.active])).toEqual([[SEED_PRICE_LIST.name, true]]);
    expect(lists[0]?.prices.map((price) => [price.product.name, price.priceCents]).sort()).toEqual(
      SEED_PRICE_LIST.prices.map((price) => [price.product, price.priceCents]).sort(),
    );
    const unit = await platform.unit.findUniqueOrThrow({ where: { id: result.unitId } });
    expect(unit.currentPriceListId).toBeNull();
  });

  it('spec 04: "Caixa 1" open today with example tabs and items in different stages', async () => {
    const result = await seed(platform);
    const unit = await platform.unit.findUniqueOrThrow({ where: { id: result.unitId } });
    // Plus the "paga antes" tab (spec 05) and the tab on credit (spec 06).
    expect(unit.nextTabNumber).toBe(SEED_TABS.length + 3);
    expect(unit.businessDate).not.toBeNull();
    const tabs = await platform.tab.findMany({
      where: { unitId: result.unitId, mode: 'open_tab', status: { not: 'on_credit' } },
      orderBy: { number: 'asc' },
      include: { items: { include: { stage: true } } },
    });
    expect(tabs.map((tab) => [tab.number, tab.customerName, tab.status])).toEqual(
      SEED_TABS.map((tab, index) => [index + 1, tab.customerName, tab.status]),
    );
    const stageNames = new Set(tabs.flatMap((tab) => tab.items.map((item) => item.stage.name)));
    expect([...stageNames].sort()).toEqual(['Entregue', 'Preparando', 'Pronto', 'Recebido']);
    expect(tabs.flatMap((tab) => tab.items).some((item) => item.splitFromId !== null)).toBe(true);
    // Final items are in no queue.
    for (const item of tabs.flatMap((tab) => tab.items)) {
      expect(item.stationId === null).toBe(item.stage.isFinal);
    }
  });

  it('spec 06: two customers (one with phone, one with name and reference) and a tab on credit', async () => {
    const result = await seed(platform);
    const customers = await platform.customer.findMany({
      where: { unitId: result.unitId },
      orderBy: { id: 'asc' },
    });
    expect(customers.map((row) => [row.name, row.phone, row.cpf, row.reference])).toEqual(
      SEED_CUSTOMERS.map((row) => [row.name, row.phone, null, row.reference]),
    );
    const tabs = await platform.tab.findMany({
      where: { unitId: result.unitId, status: 'on_credit' },
      include: { customer: true, items: true, payments: true },
    });
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ customerName: SEED_ON_CREDIT.customerName });
    expect(tabs[0]?.customer?.reference).toBe('Barraca do lado');
    expect(tabs[0]?.creditAt).not.toBeNull();
    expect(tabs[0]?.items.map((item) => item.quantity)).toEqual([SEED_ON_CREDIT.quantity]);
    expect(tabs[0]?.payments).toEqual([]);
  });

  it('spec 05: an open session of "Caixa 1" with a partial Pix and a "paga antes" tab paid in cash', async () => {
    const result = await seed(platform);
    const sessions = await platform.cashRegisterSession.findMany({
      where: { unitId: result.unitId },
      include: {
        cashRegister: true,
        payments: { include: { tab: true }, orderBy: { id: 'asc' } },
      },
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ status: 'open', openingFloatCents: 10_000 });
    expect(sessions[0]?.cashRegister.name).toBe('Caixa 1');
    const payments = sessions[0]?.payments ?? [];
    expect(payments.map((payment) => [payment.method, payment.tab.status])).toEqual([
      ['pix', 'closing'],
      ['cash', 'paid'],
    ]);
    const cash = payments.find((payment) => payment.method === 'cash');
    expect(cash).toMatchObject({
      amountCents: 1200,
      tenderedCents: SEED_PAY_FIRST.tenderedCents,
      changeCents: 800,
    });
    expect(cash?.tab).toMatchObject({
      customerName: SEED_PAY_FIRST.customerName,
      mode: 'pay_first',
    });
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
        platform.priceList.count(),
        platform.productPrice.count(),
        platform.tab.count(),
        platform.order.count(),
        platform.orderItem.count(),
        platform.orderItemModifier.count(),
        platform.cashRegister.count(),
        platform.cashRegisterSession.count(),
        platform.payment.count(),
        platform.customer.count(),
      ]);
    const first = await seed(platform);
    const before = await counts();
    const second = await seed(platform);
    expect(second).toEqual(first);
    expect(await counts()).toEqual(before);
  });
});
