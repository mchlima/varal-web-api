import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import type { Category } from '../generated/prisma/client.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { isValidPrepStation } from '../units/routing.js';
import { setupError } from '../units/setup-errors.js';
import { SetupEvents } from '../units/setup-events.js';
import { requireUnit } from '../units/stations.service.js';
import { UnitAccessService } from '../units/unit-access.js';
import { DEFAULT_TEMPLATE } from '../units/unit-template.service.js';
import {
  type CategoryDto,
  type MenuDto,
  toCategoryDto,
  toModifierGroupDto,
  toProductDto,
} from './menu.schemas.js';

/**
 * RN-03.08: a preparation station is an active `queue` station of the same unit
 * (`INVALID_PREP_STATION` otherwise).
 */
export async function assertPrepStation(
  db: TenantDb,
  unitId: string,
  stationId: string,
): Promise<void> {
  const station = await db.station.findFirst({ where: { id: stationId, unitId } });
  if (!isValidPrepStation(station)) {
    throw setupError('INVALID_PREP_STATION');
  }
}

/** Next position at the end of a list. */
export function nextSortOrder(max: number | null): number {
  return (max ?? 0) + 1;
}

/** Fails with `INVALID_ORDER` unless `ids` lists every id of `current` exactly once. */
export function assertSameSet(ids: readonly string[], current: readonly string[]): string[] {
  const normalized = ids.map((id) => id.toLowerCase());
  const expected = new Set(current);
  if (
    normalized.length !== expected.size ||
    new Set(normalized).size !== normalized.length ||
    normalized.some((id) => !expected.has(id))
  ) {
    throw setupError('INVALID_ORDER');
  }
  return normalized;
}

export interface CreateCategoryInput {
  unitId: string;
  name: string;
  defaultStationId?: string | undefined;
  sortOrder?: number | undefined;
  active?: boolean | undefined;
}

export interface UpdateCategoryInput {
  name?: string | undefined;
  defaultStationId?: string | undefined;
  sortOrder?: number | undefined;
  active?: boolean | undefined;
}

/**
 * Menu of a unit (spec 03, section 5): the full read for the owner and the staff of the unit, and
 * the categories (owner only). Every change bumps the menu version and emits `menu.updated`.
 * RN-03.12: changes are allowed with an open shift; items already ordered keep their copy.
 */
@Injectable()
export class MenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: SetupEvents,
    private readonly access: UnitAccessService,
  ) {}

  /**
   * `GET /units/{id}/menu`: the owner sees everything, with `active`; staff of the unit see only
   * active categories, products and modifiers (RN-03.10: inactive products do not reach the
   * counter; sold-out ones do, blocked).
   */
  async read(unitId: string): Promise<MenuDto> {
    const access = await this.access.forMember(unitId);
    const onlyActive = access.actor.type === 'staff';
    const activeFilter = onlyActive ? { active: true } : {};
    const db = this.prisma.db;
    const order = [{ sortOrder: 'asc' as const }, { id: 'asc' as const }];
    const categories = await db.category.findMany({
      where: { unitId, ...activeFilter },
      orderBy: order,
    });
    const products = await db.product.findMany({
      where: { unitId, ...activeFilter, categoryId: { in: categories.map((c) => c.id) } },
      orderBy: order,
    });
    const groups = await db.modifierGroup.findMany({
      where: { productId: { in: products.map((product) => product.id) } },
      orderBy: order,
    });
    const modifiers = await db.modifier.findMany({
      where: { modifierGroupId: { in: groups.map((group) => group.id) }, ...activeFilter },
      orderBy: order,
    });
    return {
      unitId,
      version: access.unit.menuVersion,
      categories: categories.map((category) => ({
        ...toCategoryDto(category),
        products: products
          .filter((product) => product.categoryId === category.id)
          .map((product) => ({
            ...toProductDto(product, category),
            modifierGroups: groups
              .filter((group) => group.productId === product.id)
              .map((group) =>
                toModifierGroupDto(
                  group,
                  modifiers.filter((modifier) => modifier.modifierGroupId === group.id),
                ),
              ),
          })),
      })),
    };
  }

  /** New categories get the Cozinha as preparation station by default (spec 03, section 4.4). */
  async createCategory(input: CreateCategoryInput): Promise<CategoryDto> {
    return this.prisma.transaction(async (db) => {
      const unitId = input.unitId.toLowerCase();
      await requireUnit(db, unitId);
      await this.assertNameFree(db, unitId, input.name, null);
      const defaultStationId =
        input.defaultStationId?.toLowerCase() ?? (await this.defaultPrepStation(db, unitId));
      await assertPrepStation(db, unitId, defaultStationId);
      const last = await db.category.aggregate({ where: { unitId }, _max: { sortOrder: true } });
      const category = await db.category.create({
        data: {
          organizationId: requireOrganizationId(),
          unitId,
          name: input.name,
          defaultStationId,
          sortOrder: input.sortOrder ?? nextSortOrder(last._max.sortOrder),
          active: input.active ?? true,
        },
      });
      await this.audit.record(db, {
        action: 'category.created',
        entityType: 'category',
        entityId: category.id,
        after: audited(category),
        metadata: { unitId },
      });
      await this.events.menuChanged(db, unitId);
      return toCategoryDto(category);
    });
  }

  async updateCategory(categoryId: string, input: UpdateCategoryInput): Promise<CategoryDto> {
    return this.prisma.transaction(async (db) => {
      const current = await db.category.findUnique({ where: { id: categoryId } });
      if (!current) {
        throw AppError.of('NOT_FOUND');
      }
      const unitId = current.unitId;
      if (input.name !== undefined && input.name.toLowerCase() !== current.name.toLowerCase()) {
        await this.assertNameFree(db, unitId, input.name, categoryId);
      }
      const defaultStationId = input.defaultStationId?.toLowerCase();
      if (defaultStationId !== undefined && defaultStationId !== current.defaultStationId) {
        await assertPrepStation(db, unitId, defaultStationId);
      }
      const category = await db.category.update({
        where: { id: categoryId },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(defaultStationId === undefined ? {} : { defaultStationId }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
          ...(input.active === undefined ? {} : { active: input.active }),
        },
      });
      await this.audit.record(db, {
        action: 'category.updated',
        entityType: 'category',
        entityId: categoryId,
        before: audited(current),
        after: audited(category),
        metadata: { unitId },
      });
      await this.events.menuChanged(db, unitId);
      return toCategoryDto(category);
    });
  }

  /** `PUT /units/{id}/categories/order`: every category of the unit, in the new order. */
  async reorderCategories(unitId: string, categoryIds: string[]): Promise<CategoryDto[]> {
    return this.prisma.transaction(async (db) => {
      await requireUnit(db, unitId);
      const current = await db.category.findMany({
        where: { unitId },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
      const ordered = assertSameSet(
        categoryIds,
        current.map((category) => category.id),
      );
      for (const [index, id] of ordered.entries()) {
        await db.category.update({ where: { id }, data: { sortOrder: index + 1 } });
      }
      await this.audit.record(db, {
        action: 'category.reordered',
        entityType: 'unit',
        entityId: unitId,
        before: { categoryIds: current.map((category) => category.id) },
        after: { categoryIds: ordered },
      });
      await this.events.menuChanged(db, unitId);
      const categories = await db.category.findMany({
        where: { unitId },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
      return categories.map(toCategoryDto);
    });
  }

  /** The template's preparation station (Cozinha) if active, else the first active queue. */
  private async defaultPrepStation(db: TenantDb, unitId: string): Promise<string> {
    const stations = await db.station.findMany({
      where: { unitId, active: true, kind: 'queue' },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    const preferred = stations.find(
      (station) => station.name.toLowerCase() === DEFAULT_TEMPLATE.prepStation.toLowerCase(),
    );
    const chosen = preferred ?? stations[0];
    if (!chosen) {
      throw setupError('INVALID_PREP_STATION');
    }
    return chosen.id;
  }

  private async assertNameFree(
    db: TenantDb,
    unitId: string,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const taken = await db.category.count({
      where: {
        unitId,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId === null ? {} : { id: { not: exceptId } }),
      },
    });
    if (taken > 0) {
      throw setupError('CATEGORY_NAME_TAKEN');
    }
  }
}

function audited(category: Category): Record<string, unknown> {
  return {
    name: category.name,
    defaultStationId: category.defaultStationId,
    sortOrder: category.sortOrder,
    active: category.active,
  };
}
