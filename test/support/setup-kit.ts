/**
 * Unit setup in tests (spec 03): the default template applied to the unit of a tenant, through the
 * unscoped client, as the platform admin does when it creates an organization (spec 02).
 */
import { AuditService } from '../../src/audit/audit.service.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { UnitTemplateService } from '../../src/units/unit-template.service.js';
import type { Tenant } from './isolation-kit.js';

export interface TemplateStations {
  counter: string;
  kitchen: string;
  delivery: string;
}

export const templateService = new UnitTemplateService(new AuditService());

/** Applies the default template to `unitId` (default: the tenant's unit) and returns its stations. */
export async function withTemplate(
  platform: PrismaClient,
  tenant: Tenant,
  unitId = tenant.unitId,
): Promise<TemplateStations> {
  await platform.$transaction((tx) =>
    templateService.applyDefaultTemplate(tx, { organizationId: tenant.organizationId, unitId }),
  );
  const stations = await platform.station.findMany({
    where: { organizationId: tenant.organizationId, unitId },
  });
  const byName = (name: string): string => {
    const station = stations.find((row) => row.name === name);
    if (!station) {
      throw new Error(`station ${name} not found`);
    }
    return station.id;
  };
  return {
    counter: byName('Balcão'),
    kitchen: byName('Cozinha'),
    delivery: byName('Balcão de entrega'),
  };
}
