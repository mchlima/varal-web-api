import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { updateWithVersion } from '../common/versioned-update.js';
import { requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import type { Product } from '../generated/prisma/client.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { setupError } from '../units/setup-errors.js';
import { SetupEvents } from '../units/setup-events.js';
import { UnitAccessService } from '../units/unit-access.js';
import { assertPrepStation, assertSameSet, nextSortOrder } from './menu.service.js';
import { type ProductDto, toProductDto } from './menu.schemas.js';

export interface CreateProductInput {
  categoryId: string;
  name: string;
  description?: string | null | undefined;
  priceCents: number;
  stationId?: string | null | undefined;
  sortOrder?: number | undefined;
  active?: boolean | undefined;
}

export interface UpdateProductInput {
  categoryId?: string | undefined;
  name?: string | undefined;
  description?: string | null | undefined;
  priceCents?: number | undefined;
  stationId?: string | null | undefined;
  sortOrder?: number | undefined;
  active?: boolean | undefined;
  version?: number | undefined;
}

/**
 * Products of the menu (spec 03, section 5.1). Price in integer cents (RN-03.09); optional own
 * preparation station that overrides the category's (RN-03.08); sold-out marked by the owner or by
 * staff with a station in the unit (RN-03.11). Products are never deleted, only deactivated.
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: SetupEvents,
    private readonly access: UnitAccessService,
  ) {}

  async create(input: CreateProductInput): Promise<ProductDto> {
    return this.prisma.transaction(async (db) => {
      const category = await db.category.findUnique({
        where: { id: input.categoryId.toLowerCase() },
      });
      if (!category) {
        throw setupError('INVALID_REFERENCE');
      }
      const unitId = category.unitId;
      const stationId = input.stationId?.toLowerCase() ?? null;
      if (stationId !== null) {
        await assertPrepStation(db, unitId, stationId);
      }
      const last = await db.product.aggregate({
        where: { categoryId: category.id },
        _max: { sortOrder: true },
      });
      const product = await db.product.create({
        data: {
          organizationId: requireOrganizationId(),
          unitId,
          categoryId: category.id,
          name: input.name,
          description: emptyToNull(input.description),
          priceCents: input.priceCents,
          stationId,
          sortOrder: input.sortOrder ?? nextSortOrder(last._max.sortOrder),
          active: input.active ?? true,
        },
      });
      await this.audit.record(db, {
        action: 'product.created',
        entityType: 'product',
        entityId: product.id,
        after: audited(product),
        metadata: { unitId },
      });
      await this.events.menuChanged(db, unitId);
      return toProductDto(product, category);
    });
  }

  /** RN-03.12: allowed with an open shift; valid for new orders only. */
  async update(productId: string, input: UpdateProductInput): Promise<ProductDto> {
    return this.prisma.transaction(async (db) => {
      const current = await db.product.findUnique({ where: { id: productId } });
      if (!current) {
        throw AppError.of('NOT_FOUND');
      }
      const unitId = current.unitId;
      let categoryId = current.categoryId;
      let sortOrder = input.sortOrder;
      if (input.categoryId !== undefined && input.categoryId.toLowerCase() !== categoryId) {
        const category = await db.category.findFirst({
          where: { id: input.categoryId.toLowerCase(), unitId },
        });
        if (!category) {
          throw setupError('INVALID_REFERENCE');
        }
        categoryId = category.id;
        if (sortOrder === undefined) {
          const last = await db.product.aggregate({
            where: { categoryId },
            _max: { sortOrder: true },
          });
          sortOrder = nextSortOrder(last._max.sortOrder);
        }
      }
      const stationId =
        input.stationId === undefined ? undefined : (input.stationId?.toLowerCase() ?? null);
      if (stationId != null && stationId !== current.stationId) {
        await assertPrepStation(db, unitId, stationId);
      }
      const product = await updateWithVersion<Product>(db.product, {
        where: { id: productId },
        expectedVersion: input.version ?? current.version,
        data: {
          categoryId,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined
            ? {}
            : { description: emptyToNull(input.description) }),
          ...(input.priceCents === undefined ? {} : { priceCents: input.priceCents }),
          ...(stationId === undefined ? {} : { stationId }),
          ...(sortOrder === undefined ? {} : { sortOrder }),
          ...(input.active === undefined ? {} : { active: input.active }),
        },
      });
      await this.audit.record(db, {
        action: 'product.updated',
        entityType: 'product',
        entityId: productId,
        before: audited(current),
        after: audited(product),
        metadata: { unitId },
      });
      await this.events.menuChanged(db, unitId);
      return this.toDto(db, product);
    });
  }

  /** `PUT /categories/{id}/products/order`: every product of the category, in the new order. */
  async reorder(categoryId: string, productIds: string[]): Promise<ProductDto[]> {
    return this.prisma.transaction(async (db) => {
      const category = await db.category.findUnique({ where: { id: categoryId } });
      if (!category) {
        throw AppError.of('NOT_FOUND');
      }
      const order = [{ sortOrder: 'asc' as const }, { id: 'asc' as const }];
      const current = await db.product.findMany({ where: { categoryId }, orderBy: order });
      const ordered = assertSameSet(
        productIds,
        current.map((product) => product.id),
      );
      for (const [index, id] of ordered.entries()) {
        await db.product.update({
          where: { id },
          data: { sortOrder: index + 1, version: { increment: 1 } },
        });
      }
      await this.audit.record(db, {
        action: 'product.reordered',
        entityType: 'category',
        entityId: categoryId,
        before: { productIds: current.map((product) => product.id) },
        after: { productIds: ordered },
        metadata: { unitId: category.unitId },
      });
      await this.events.menuChanged(db, category.unitId);
      const products = await db.product.findMany({ where: { categoryId }, orderBy: order });
      return products.map((product) => toProductDto(product, category));
    });
  }

  /**
   * RN-03.11: marks or unmarks sold out, by the owner or staff with a station in the unit, at any
   * time (open shift included). Emits `product.sold_out_changed` to the unit after the commit, so
   * every counter blocks the product without reloading (CA-03.05). Setting the current state again
   * changes nothing and emits nothing.
   */
  async setSoldOut(productId: string, soldOut: boolean): Promise<ProductDto> {
    return this.prisma.transaction(async (db) => {
      const current = await db.product.findUnique({ where: { id: productId } });
      if (!current) {
        throw AppError.of('NOT_FOUND');
      }
      await this.access.forStationMember(current.unitId);
      if (current.soldOut === soldOut) {
        return this.toDto(db, current);
      }
      const product = await updateWithVersion<Product>(db.product, {
        where: { id: productId },
        expectedVersion: current.version,
        data: { soldOut },
      });
      await this.audit.record(db, {
        action: 'product.sold_out_changed',
        entityType: 'product',
        entityId: productId,
        before: { soldOut: current.soldOut },
        after: { soldOut: product.soldOut },
        metadata: { unitId: product.unitId },
      });
      this.events.soldOutChanged(product);
      return this.toDto(db, product);
    });
  }

  private async toDto(db: TenantDb, product: Product): Promise<ProductDto> {
    const category = await db.category.findUniqueOrThrow({ where: { id: product.categoryId } });
    return toProductDto(product, category);
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

function audited(product: Product): Record<string, unknown> {
  return {
    categoryId: product.categoryId,
    name: product.name,
    description: product.description,
    priceCents: product.priceCents,
    stationId: product.stationId,
    sortOrder: product.sortOrder,
    active: product.active,
  };
}
