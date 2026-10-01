import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import type { Modifier, ModifierGroup } from '../generated/prisma/client.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { setupError } from '../units/setup-errors.js';
import { SetupEvents } from '../units/setup-events.js';
import { nextSortOrder } from './menu.service.js';
import {
  type ModifierDto,
  type ModifierGroupDto,
  toModifierDto,
  toModifierGroupDto,
} from './menu.schemas.js';

export interface NewModifierInput {
  name: string;
  priceDeltaCents: number;
  sortOrder?: number | undefined;
  active?: boolean | undefined;
}

export interface CreateModifierGroupInput {
  productId: string;
  name: string;
  minChoices: number;
  maxChoices: number;
  sortOrder?: number | undefined;
  modifiers: NewModifierInput[];
}

export interface UpdateModifierGroupInput {
  name?: string | undefined;
  minChoices?: number | undefined;
  maxChoices?: number | undefined;
  sortOrder?: number | undefined;
}

export interface UpdateModifierInput {
  name?: string | undefined;
  priceDeltaCents?: number | undefined;
  sortOrder?: number | undefined;
  active?: boolean | undefined;
}

/** RN-03.13: 0 ≤ minimum ≤ maximum and maximum ≥ 1. */
export function validModifierLimits(minChoices: number, maxChoices: number): boolean {
  return minChoices >= 0 && maxChoices >= 1 && minChoices <= maxChoices;
}

/**
 * Modifier groups and modifiers of a product (spec 03, section 5.2). A group with minimum ≥ 1 is
 * required (RN-03.13); removing an ingredient is a modifier with zero delta (RN-03.14). Groups can
 * be deleted (with their modifiers): ordered items keep a copy of name and delta (RN-04.18).
 * Modifiers are deactivated, not deleted.
 */
@Injectable()
export class ModifiersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: SetupEvents,
  ) {}

  async createGroup(input: CreateModifierGroupInput): Promise<ModifierGroupDto> {
    if (!validModifierLimits(input.minChoices, input.maxChoices)) {
      throw setupError('INVALID_MODIFIER_LIMITS');
    }
    return this.prisma.transaction(async (db) => {
      const product = await db.product.findUnique({ where: { id: input.productId.toLowerCase() } });
      if (!product) {
        throw setupError('INVALID_REFERENCE');
      }
      const organizationId = requireOrganizationId();
      const last = await db.modifierGroup.aggregate({
        where: { productId: product.id },
        _max: { sortOrder: true },
      });
      const group = await db.modifierGroup.create({
        data: {
          organizationId,
          productId: product.id,
          name: input.name,
          minChoices: input.minChoices,
          maxChoices: input.maxChoices,
          sortOrder: input.sortOrder ?? nextSortOrder(last._max.sortOrder),
        },
      });
      const modifiers: Modifier[] = [];
      for (const [index, modifier] of input.modifiers.entries()) {
        modifiers.push(
          await db.modifier.create({
            data: {
              organizationId,
              modifierGroupId: group.id,
              name: modifier.name,
              priceDeltaCents: modifier.priceDeltaCents,
              sortOrder: modifier.sortOrder ?? index + 1,
              active: modifier.active ?? true,
            },
          }),
        );
      }
      await this.audit.record(db, {
        action: 'modifier_group.created',
        entityType: 'modifier_group',
        entityId: group.id,
        after: { ...auditedGroup(group), modifiers: modifiers.map(auditedModifier) },
        metadata: { productId: product.id },
      });
      await this.events.menuChanged(db, product.unitId);
      return toModifierGroupDto(group, sorted(modifiers));
    });
  }

  async updateGroup(groupId: string, input: UpdateModifierGroupInput): Promise<ModifierGroupDto> {
    return this.prisma.transaction(async (db) => {
      const { group: current, unitId } = await this.groupWithUnit(db, groupId);
      const minChoices = input.minChoices ?? current.minChoices;
      const maxChoices = input.maxChoices ?? current.maxChoices;
      if (!validModifierLimits(minChoices, maxChoices)) {
        throw setupError('INVALID_MODIFIER_LIMITS');
      }
      const group = await db.modifierGroup.update({
        where: { id: groupId },
        data: {
          minChoices,
          maxChoices,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        },
      });
      await this.audit.record(db, {
        action: 'modifier_group.updated',
        entityType: 'modifier_group',
        entityId: groupId,
        before: auditedGroup(current),
        after: auditedGroup(group),
        metadata: { productId: group.productId },
      });
      await this.events.menuChanged(db, unitId);
      return toModifierGroupDto(group, await this.modifiersOf(db, groupId));
    });
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.prisma.transaction(async (db) => {
      const { group, unitId } = await this.groupWithUnit(db, groupId);
      const modifiers = await this.modifiersOf(db, groupId);
      // Modifiers go with the group (ON DELETE CASCADE on the composite key, same organization).
      await db.modifierGroup.delete({ where: { id: groupId } });
      await this.audit.record(db, {
        action: 'modifier_group.deleted',
        entityType: 'modifier_group',
        entityId: groupId,
        before: { ...auditedGroup(group), modifiers: modifiers.map(auditedModifier) },
        metadata: { productId: group.productId },
      });
      await this.events.menuChanged(db, unitId);
    });
  }

  async createModifier(
    input: NewModifierInput & { modifierGroupId: string },
  ): Promise<ModifierDto> {
    return this.prisma.transaction(async (db) => {
      const found = await db.modifierGroup.findUnique({
        where: { id: input.modifierGroupId.toLowerCase() },
        include: { product: { select: { unitId: true } } },
      });
      if (!found) {
        throw setupError('INVALID_REFERENCE');
      }
      const last = await db.modifier.aggregate({
        where: { modifierGroupId: found.id },
        _max: { sortOrder: true },
      });
      const modifier = await db.modifier.create({
        data: {
          organizationId: requireOrganizationId(),
          modifierGroupId: found.id,
          name: input.name,
          priceDeltaCents: input.priceDeltaCents,
          sortOrder: input.sortOrder ?? nextSortOrder(last._max.sortOrder),
          active: input.active ?? true,
        },
      });
      await this.audit.record(db, {
        action: 'modifier.created',
        entityType: 'modifier',
        entityId: modifier.id,
        after: auditedModifier(modifier),
        metadata: { modifierGroupId: found.id },
      });
      await this.events.menuChanged(db, found.product.unitId);
      return toModifierDto(modifier);
    });
  }

  async updateModifier(modifierId: string, input: UpdateModifierInput): Promise<ModifierDto> {
    return this.prisma.transaction(async (db) => {
      const current = await db.modifier.findUnique({
        where: { id: modifierId },
        include: { modifierGroup: { include: { product: { select: { unitId: true } } } } },
      });
      if (!current) {
        throw AppError.of('NOT_FOUND');
      }
      const modifier = await db.modifier.update({
        where: { id: modifierId },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.priceDeltaCents === undefined
            ? {}
            : { priceDeltaCents: input.priceDeltaCents }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
          ...(input.active === undefined ? {} : { active: input.active }),
        },
      });
      await this.audit.record(db, {
        action: 'modifier.updated',
        entityType: 'modifier',
        entityId: modifierId,
        before: auditedModifier(current),
        after: auditedModifier(modifier),
        metadata: { modifierGroupId: modifier.modifierGroupId },
      });
      await this.events.menuChanged(db, current.modifierGroup.product.unitId);
      return toModifierDto(modifier);
    });
  }

  private async groupWithUnit(
    db: TenantDb,
    groupId: string,
  ): Promise<{ group: ModifierGroup; unitId: string }> {
    const found = await db.modifierGroup.findUnique({
      where: { id: groupId },
      include: { product: { select: { unitId: true } } },
    });
    if (!found) {
      throw AppError.of('NOT_FOUND');
    }
    const { product, ...group } = found;
    return { group, unitId: product.unitId };
  }

  private modifiersOf(db: TenantDb, groupId: string): Promise<Modifier[]> {
    return db.modifier.findMany({
      where: { modifierGroupId: groupId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
  }
}

function sorted(modifiers: Modifier[]): Modifier[] {
  return [...modifiers].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

function auditedGroup(group: ModifierGroup): Record<string, unknown> {
  return {
    name: group.name,
    minChoices: group.minChoices,
    maxChoices: group.maxChoices,
    sortOrder: group.sortOrder,
  };
}

function auditedModifier(modifier: Modifier): Record<string, unknown> {
  return {
    name: modifier.name,
    priceDeltaCents: modifier.priceDeltaCents,
    sortOrder: modifier.sortOrder,
    active: modifier.active,
  };
}
