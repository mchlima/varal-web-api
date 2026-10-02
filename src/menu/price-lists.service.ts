import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { updateWithVersion } from '../common/versioned-update.js';
import { requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import { type PriceList, Prisma } from '../generated/prisma/client.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { NORMAL_PRICE_LIST_NAME } from '../units/effective-price-list.js';
import { setupError } from '../units/setup-errors.js';
import { SetupEvents } from '../units/setup-events.js';
import { requireUnit } from '../units/stations.service.js';
import { UnitAccessService } from '../units/unit-access.js';
import { nextSortOrder } from './menu.service.js';
import {
  type PriceListDto,
  type PriceListPricesDto,
  type ProductPricesDto,
  toPriceListDto,
} from './menu.schemas.js';

export function isReservedPriceListName(name: string): boolean {
  return (
    name.trim().toLocaleLowerCase('pt-BR') === NORMAL_PRICE_LIST_NAME.toLocaleLowerCase('pt-BR')
  );
}

/**
 * Price lists of a unit (spec 03, section 5.3): saved lists of alternative prices ("Evento"), with an
 * optional price per product (RN-03.21). Only the owner registers and edits lists and prices
 * (section 5.3); reading the lists is open to the members of the unit (the counter shows the
 * effective one). Every change emits `menu.updated` (spec 03, section 8). Prices change at any time
 * and apply to new items only (RN-03.24).
 */
@Injectable()
export class PriceListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: SetupEvents,
    private readonly access: UnitAccessService,
  ) {}

  /** `GET /units/{id}/price-lists`: every list for the owner; only active ones for staff. */
  async list(unitId: string): Promise<PriceListDto[]> {
    const access = await this.access.forMember(unitId);
    const db = this.prisma.db;
    const lists = await db.priceList.findMany({
      where: { unitId, ...(access.actor.type === 'staff' ? { active: true } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return toDtos(db, lists, access.unit.currentPriceListId);
  }

  /** RN-03.20, CA-03.10: name unique in the unit, never "Normal". */
  async create(
    unitId: string,
    input: { name: string; sortOrder?: number | undefined; active?: boolean | undefined },
  ): Promise<PriceListDto> {
    return this.prisma.transaction(async (db) => {
      const unit = await requireUnit(db, unitId);
      await assertNameFree(db, unitId, input.name, null);
      const last = await db.priceList.aggregate({ where: { unitId }, _max: { sortOrder: true } });
      const list = await uniqueName(() =>
        db.priceList.create({
          data: {
            organizationId: requireOrganizationId(),
            unitId,
            name: input.name,
            sortOrder: input.sortOrder ?? nextSortOrder(last._max.sortOrder),
            active: input.active ?? true,
          },
        }),
      );
      await this.audit.record(db, {
        action: 'price_list.created',
        entityType: 'price_list',
        entityId: list.id,
        after: audited(list),
        metadata: { unitId },
      });
      await this.events.menuChanged(db, unitId);
      const [dto] = await toDtos(db, [list], unit.currentPriceListId);
      return requireDto(dto);
    });
  }

  /** RN-03.20, RN-03.23 (CA-03.10): renames, reorders, (de)activates; the list in use stays active. */
  async update(
    id: string,
    input: {
      name?: string | undefined;
      sortOrder?: number | undefined;
      active?: boolean | undefined;
      version?: number | undefined;
    },
  ): Promise<PriceListDto> {
    return this.prisma.transaction(async (db) => {
      const current = await requireList(db, id);
      const unitId = current.unitId;
      // Same lock as the change of the current list (spec 04): a list is never deactivated while it
      // becomes the current one.
      await db.$queryRaw`
        SELECT id FROM units WHERE id = ${unitId}::uuid AND organization_id = ${requireOrganizationId()}::uuid
        FOR UPDATE`;
      const unit = await requireUnit(db, unitId);
      if (input.name !== undefined && input.name.toLowerCase() !== current.name.toLowerCase()) {
        await assertNameFree(db, unitId, input.name, id);
      }
      if (input.active === false && current.active) {
        if (unit.currentPriceListId === id) {
          throw setupError('PRICE_LIST_IN_USE', { reason: 'current' });
        }
        const events = await db.contractedEvent.count({
          where: { priceListId: id, status: { in: ['scheduled', 'in_progress'] } },
        });
        if (events > 0) {
          throw setupError('PRICE_LIST_IN_USE', { reason: 'event' });
        }
      }
      const list = await uniqueName(() =>
        updateWithVersion<PriceList>(db.priceList, {
          where: { id },
          expectedVersion: input.version ?? current.version,
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
            ...(input.active === undefined ? {} : { active: input.active }),
          },
        }),
      );
      await this.audit.record(db, {
        action: 'price_list.updated',
        entityType: 'price_list',
        entityId: id,
        before: audited(current),
        after: audited(list),
        metadata: { unitId },
      });
      await this.events.menuChanged(db, unitId);
      const [dto] = await toDtos(db, [list], unit.currentPriceListId);
      return requireDto(dto);
    });
  }

  /** `PUT /price-lists/{id}/prices` (RN-03.22): prices of many products of the unit at once. */
  async putListPrices(
    id: string,
    prices: readonly { productId: string; priceCents: number | null }[],
  ): Promise<PriceListPricesDto> {
    return this.prisma.transaction(async (db) => {
      const list = await requireList(db, id);
      const rows = prices.map((row) => ({ ...row, productId: row.productId.toLowerCase() }));
      const products = await db.product.findMany({
        where: { id: { in: rows.map((row) => row.productId) }, unitId: list.unitId },
        select: { id: true },
      });
      const known = new Set(products.map((product) => product.id));
      const missing = rows.filter((row) => !known.has(row.productId)).map((row) => row.productId);
      if (missing.length > 0) {
        throw setupError('INVALID_REFERENCE', { productIds: missing });
      }
      const changes = await writePrices(
        db,
        rows.map((row) => ({ priceListId: id, ...row })),
      );
      await this.audit.record(db, {
        action: 'price_list.prices_updated',
        entityType: 'price_list',
        entityId: id,
        after: { prices: changes },
        metadata: { unitId: list.unitId },
      });
      await this.events.menuChanged(db, list.unitId);
      return this.listPricesOf(db, id);
    });
  }

  /** `PUT /products/{id}/prices` (RN-03.22): the prices of a product in the lists of its unit. */
  async putProductPrices(
    productId: string,
    prices: readonly { priceListId: string; priceCents: number | null }[],
  ): Promise<ProductPricesDto> {
    return this.prisma.transaction(async (db) => {
      const product = await db.product.findUnique({ where: { id: productId } });
      if (!product) {
        throw AppError.of('NOT_FOUND');
      }
      const rows = prices.map((row) => ({ ...row, priceListId: row.priceListId.toLowerCase() }));
      const lists = await db.priceList.findMany({
        where: { id: { in: rows.map((row) => row.priceListId) }, unitId: product.unitId },
        select: { id: true },
      });
      const known = new Set(lists.map((list) => list.id));
      const missing = rows
        .filter((row) => !known.has(row.priceListId))
        .map((row) => row.priceListId);
      if (missing.length > 0) {
        throw setupError('INVALID_REFERENCE', { priceListIds: missing });
      }
      const changes = await writePrices(
        db,
        rows.map((row) => ({ productId, ...row })),
      );
      await this.audit.record(db, {
        action: 'product.prices_updated',
        entityType: 'product',
        entityId: productId,
        after: { prices: changes },
        metadata: { unitId: product.unitId },
      });
      await this.events.menuChanged(db, product.unitId);
      const current = await db.productPrice.findMany({
        where: { productId },
        orderBy: { priceListId: 'asc' },
      });
      return {
        productId,
        prices: current.map((row) => ({
          priceListId: row.priceListId,
          priceCents: row.priceCents,
        })),
      };
    });
  }

  /** `GET /price-lists/{id}`: the list with its prices (owner). */
  async get(id: string): Promise<PriceListPricesDto> {
    const db = this.prisma.db;
    await requireList(db, id);
    return this.listPricesOf(db, id);
  }

  private async listPricesOf(db: TenantDb, id: string): Promise<PriceListPricesDto> {
    const list = await requireList(db, id);
    const unit = await requireUnit(db, list.unitId);
    const [dto] = await toDtos(db, [list], unit.currentPriceListId);
    const prices = await db.productPrice.findMany({
      where: { priceListId: id },
      orderBy: { productId: 'asc' },
    });
    return {
      priceList: requireDto(dto),
      prices: prices.map((row) => ({ productId: row.productId, priceCents: row.priceCents })),
    };
  }
}

/** Upserts or removes (`null`) each price; returns what was written, for the audit. */
async function writePrices(
  db: TenantDb,
  rows: readonly { priceListId: string; productId: string; priceCents: number | null }[],
): Promise<{ priceListId: string; productId: string; priceCents: number | null }[]> {
  const organizationId = requireOrganizationId();
  for (const row of rows) {
    if (row.priceCents === null) {
      await db.productPrice.deleteMany({
        where: { priceListId: row.priceListId, productId: row.productId },
      });
    } else {
      await db.productPrice.upsert({
        where: {
          priceListId_productId: { priceListId: row.priceListId, productId: row.productId },
        },
        create: {
          organizationId,
          priceListId: row.priceListId,
          productId: row.productId,
          priceCents: row.priceCents,
        },
        update: { priceCents: row.priceCents },
      });
    }
  }
  return rows.map((row) => ({ ...row }));
}

async function toDtos(
  db: TenantDb,
  lists: readonly PriceList[],
  currentPriceListId: string | null,
): Promise<PriceListDto[]> {
  if (lists.length === 0) {
    return [];
  }
  const counts = await db.productPrice.groupBy({
    by: ['priceListId'],
    where: { priceListId: { in: lists.map((list) => list.id) } },
    _count: { _all: true },
  });
  return lists.map((list) =>
    toPriceListDto(list, {
      productCount: counts.find((row) => row.priceListId === list.id)?._count._all ?? 0,
      current: list.id === currentPriceListId,
    }),
  );
}

function requireDto(dto: PriceListDto | undefined): PriceListDto {
  if (!dto) {
    throw AppError.of('INTERNAL_ERROR');
  }
  return dto;
}

async function requireList(db: TenantDb, id: string): Promise<PriceList> {
  const list = await db.priceList.findUnique({ where: { id } });
  if (!list) {
    throw AppError.of('NOT_FOUND');
  }
  return list;
}

async function assertNameFree(
  db: TenantDb,
  unitId: string,
  name: string,
  exceptId: string | null,
): Promise<void> {
  if (isReservedPriceListName(name)) {
    throw setupError('PRICE_LIST_NAME_RESERVED');
  }
  const taken = await db.priceList.count({
    where: {
      unitId,
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId === null ? {} : { id: { not: exceptId } }),
    },
  });
  if (taken > 0) {
    throw setupError('PRICE_LIST_NAME_TAKEN');
  }
}

/** The unique index `(unit_id, lower(name))` refuses a name taken by a concurrent request. */
async function uniqueName<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw setupError('PRICE_LIST_NAME_TAKEN');
    }
    throw error;
  }
}

function audited(list: PriceList): Record<string, unknown> {
  return { name: list.name, sortOrder: list.sortOrder, active: list.active };
}
