/**
 * Operation in tests (spec 04): a unit with the default template (stations, workflow and "Caixa 1"),
 * a "Fritadeira" station and a small menu, plus staff members with chosen stations. Written through the unscoped client, like
 * the seed.
 */
import type { AuthContext } from '../../src/context/request-context.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import type { Tenant } from './isolation-kit.js';
import { type TemplateStations, withTemplate } from './setup-kit.js';

export interface OperationSetup {
  tenant: Tenant;
  /** "Caixa 1", created with the unit (RN-03.03, RN-05.17). */
  register: string;
  stations: TemplateStations & { fryer: string };
  stages: { received: string; preparing: string; ready: string; delivered: string };
  products: {
    /** Espeto de carne, R$ 12,00, Cozinha; "Ponto da carne" required, "Acompanhamentos" optional. */
    skewer: string;
    /** Pastel, R$ 8,00, Fritadeira. */
    pastry: string;
    /** Refrigerante, R$ 6,00, Balcão de entrega. */
    soda: string;
  };
  modifiers: { medium: string; rare: string; garlicBread: string; farofa: string };
  groups: { doneness: string; sides: string };
}

export async function setupOperation(
  platform: PrismaClient,
  tenant: Tenant,
): Promise<OperationSetup> {
  const template = await withTemplate(platform, tenant);
  const { organizationId, unitId } = tenant;
  const fryer = await platform.station.create({
    data: {
      organizationId,
      unitId,
      name: 'Fritadeira',
      kind: 'queue',
      sortOrder: 4,
      attentionAfterMinutes: 7,
      lateAfterMinutes: 15,
    },
  });
  const stages = await platform.workflowStage.findMany({
    where: { organizationId, unitId },
    orderBy: { sortOrder: 'asc' },
  });
  const stageId = (index: number): string => {
    const stage = stages[index];
    if (!stage) {
      throw new Error(`stage ${index} not found`);
    }
    return stage.id;
  };
  const category = (name: string, defaultStationId: string, sortOrder: number) =>
    platform.category.create({
      data: { organizationId, unitId, name, defaultStationId, sortOrder },
    });
  const skewers = await category('Espetos', template.kitchen, 1);
  const pastries = await category('Pastéis', fryer.id, 2);
  const drinks = await category('Bebidas', template.delivery, 3);
  const product = (categoryId: string, name: string, priceCents: number, sortOrder: number) =>
    platform.product.create({
      data: { organizationId, unitId, categoryId, name, priceCents, sortOrder },
    });
  const skewer = await product(skewers.id, 'Espeto de carne', 1200, 1);
  const pastry = await product(pastries.id, 'Pastel', 800, 1);
  const soda = await product(drinks.id, 'Refrigerante', 600, 1);
  const doneness = await platform.modifierGroup.create({
    data: {
      organizationId,
      productId: skewer.id,
      name: 'Ponto da carne',
      minChoices: 1,
      maxChoices: 1,
      sortOrder: 1,
    },
  });
  const sides = await platform.modifierGroup.create({
    data: {
      organizationId,
      productId: skewer.id,
      name: 'Acompanhamentos',
      minChoices: 0,
      maxChoices: 2,
      sortOrder: 2,
    },
  });
  const modifier = (
    modifierGroupId: string,
    name: string,
    priceDeltaCents: number,
    sortOrder: number,
  ) =>
    platform.modifier.create({
      data: { organizationId, modifierGroupId, name, priceDeltaCents, sortOrder },
    });
  const rare = await modifier(doneness.id, 'Mal passado', 0, 1);
  const medium = await modifier(doneness.id, 'Ao ponto', 0, 2);
  const farofa = await modifier(sides.id, 'Farofa', 0, 1);
  const garlicBread = await modifier(sides.id, 'Pão de alho', 300, 2);
  const register = await platform.cashRegister.findFirstOrThrow({
    where: { organizationId, unitId, name: 'Caixa 1' },
  });
  return {
    tenant,
    register: register.id,
    stations: { ...template, fryer: fryer.id },
    stages: {
      received: stageId(0),
      preparing: stageId(1),
      ready: stageId(2),
      delivered: stageId(3),
    },
    products: { skewer: skewer.id, pastry: pastry.id, soda: soda.id },
    modifiers: {
      medium: medium.id,
      rare: rare.id,
      garlicBread: garlicBread.id,
      farofa: farofa.id,
    },
    groups: { doneness: doneness.id, sides: sides.id },
  };
}

export interface TestStaff {
  id: string;
  username: string;
  auth: AuthContext;
}

/** A staff member of the tenant's unit with the given stations (RN-03.16). */
export async function createStaff(
  platform: PrismaClient,
  tenant: Tenant,
  stationIds: string[],
  options: { canOperateCash?: boolean; passwordHash?: string } = {},
): Promise<TestStaff> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const staff = await platform.staffMember.create({
    data: {
      organizationId: tenant.organizationId,
      name: `Colaborador ${suffix}`,
      username: `op_${suffix}`,
      passwordHash: options.passwordHash ?? null,
    },
  });
  await platform.staffUnitPermission.create({
    data: {
      organizationId: tenant.organizationId,
      staffMemberId: staff.id,
      unitId: tenant.unitId,
      stationIds,
      canOperateCash: options.canOperateCash ?? false,
    },
  });
  return {
    id: staff.id,
    username: staff.username,
    auth: { organizationId: tenant.organizationId, actor: { type: 'staff', id: staff.id } },
  };
}
