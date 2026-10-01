import type { DiscountType } from '../generated/prisma/enums.js';
import { toDate, toInstant } from '../common/time.js';

/*
 * Pure rules of orders and tabs (spec 04, sections 4 and 5): what may be sent, the copy of what was
 * sold, values and lateness. No database access, so they are unit tested on their own.
 */

// ------------------------------------------------------------------------------------------------
// Sending an order (RN-04.16, RN-04.17; CA-03.06, CA-04.06)
// ------------------------------------------------------------------------------------------------

export const ORDER_ITEM_REJECTION_REASONS = [
  'product_unavailable',
  'product_inactive',
  'sold_out',
  'modifier_required',
  'too_many_modifiers',
  'invalid_modifier',
] as const;

/**
 * Why an item of an order was refused (`ORDER_REJECTED`, `details.items[].reason`):
 * - `product_unavailable`: the product does not exist or is of another unit;
 * - `product_inactive`: product or category inactive (RN-03.10);
 * - `sold_out`: product sold out (RN-03.11, CA-04.06);
 * - `modifier_required`: fewer choices than the minimum of a group (RN-03.13, CA-03.06);
 * - `too_many_modifiers`: more choices than the maximum of a group;
 * - `invalid_modifier`: an option that is not of the product, inactive or repeated.
 */
export type OrderItemRejectionReason = (typeof ORDER_ITEM_REJECTION_REASONS)[number];

export interface OrderItemRejection {
  /** Position of the item in the request body, from 0. */
  index: number;
  productId: string;
  reason: OrderItemRejectionReason;
  /** The group of a modifier problem, when there is one. */
  modifierGroupId: string | null;
}

export interface MenuModifierForOrder {
  id: string;
  name: string;
  priceDeltaCents: number;
  sortOrder: number;
  active: boolean;
}

export interface MenuGroupForOrder {
  id: string;
  name: string;
  minChoices: number;
  maxChoices: number;
  sortOrder: number;
  modifiers: readonly MenuModifierForOrder[];
}

export interface MenuProductForOrder {
  id: string;
  unitId: string;
  name: string;
  priceCents: number;
  active: boolean;
  soldOut: boolean;
  categoryActive: boolean;
  groups: readonly MenuGroupForOrder[];
}

export interface RequestedOrderItem {
  productId: string;
  modifierIds: readonly string[];
}

/** RN-04.17: every problem of every item, so the counter can point all of them at once. */
export function checkOrderItems(
  unitId: string,
  items: readonly RequestedOrderItem[],
  products: ReadonlyMap<string, MenuProductForOrder>,
): OrderItemRejection[] {
  const rejections: OrderItemRejection[] = [];
  items.forEach((item, index) => {
    const reject = (reason: OrderItemRejectionReason, modifierGroupId: string | null = null) => {
      rejections.push({ index, productId: item.productId, reason, modifierGroupId });
    };
    const product = products.get(item.productId);
    if (product?.unitId !== unitId) {
      reject('product_unavailable');
      return;
    }
    if (!product.active || !product.categoryActive) {
      reject('product_inactive');
      return;
    }
    if (product.soldOut) {
      reject('sold_out');
      return;
    }
    const chosen = new Set(item.modifierIds);
    const known = new Map<string, { group: MenuGroupForOrder; modifier: MenuModifierForOrder }>();
    for (const group of product.groups) {
      for (const modifier of group.modifiers) {
        known.set(modifier.id, { group, modifier });
      }
    }
    if (chosen.size !== item.modifierIds.length) {
      reject('invalid_modifier');
    }
    for (const modifierId of chosen) {
      const found = known.get(modifierId);
      if (!found?.modifier.active) {
        reject('invalid_modifier', found?.group.id ?? null);
      }
    }
    for (const group of product.groups) {
      const count = group.modifiers.filter(
        (modifier) => modifier.active && chosen.has(modifier.id),
      ).length;
      if (count < group.minChoices) {
        reject('modifier_required', group.id);
      } else if (count > group.maxChoices) {
        reject('too_many_modifiers', group.id);
      }
    }
  });
  return rejections;
}

export interface CopiedModifier {
  modifierId: string;
  groupName: string;
  modifierName: string;
  priceDeltaCents: number;
}

/**
 * RN-04.18: copy of the chosen modifiers (name of the group and of the option, price delta), in
 * menu order. Call it only for items accepted by {@link checkOrderItems}.
 */
export function copyModifiers(
  product: MenuProductForOrder,
  modifierIds: readonly string[],
): CopiedModifier[] {
  const chosen = new Set(modifierIds);
  return [...product.groups]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    .flatMap((group) =>
      [...group.modifiers]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
        .filter((modifier) => chosen.has(modifier.id))
        .map((modifier) => ({
          modifierId: modifier.id,
          groupName: group.name,
          modifierName: modifier.name,
          priceDeltaCents: modifier.priceDeltaCents,
        })),
    );
}

/** RN-04.06, CA-04.07: the price of the shift table when the product is in it, else the menu's. */
export function unitPriceFor(
  product: { id: string; priceCents: number },
  shiftPrices: ReadonlyMap<string, number>,
): number {
  return shiftPrices.get(product.id) ?? product.priceCents;
}

// ------------------------------------------------------------------------------------------------
// Values (RN-04.14; spec 05, RN-05.03)
// ------------------------------------------------------------------------------------------------

/** Spec 04, section 6: `(unit_price_cents + Σ price_delta_cents) × quantity`. */
export function lineTotalCents(line: {
  unitPriceCents: number;
  quantity: number;
  modifiers: readonly { priceDeltaCents: number }[];
}): number {
  const deltas = line.modifiers.reduce((sum, modifier) => sum + modifier.priceDeltaCents, 0);
  return (line.unitPriceCents + deltas) * line.quantity;
}

/**
 * Spec 05, RN-05.01/RN-05.03: an amount (never more than the subtotal) or a percentage of the
 * subtotal, rounded down to the cent.
 */
export function discountCents(
  type: DiscountType | null,
  value: number | null,
  subtotalCents: number,
): number {
  if (type === null || value === null) {
    return 0;
  }
  const raw = type === 'amount' ? value : Math.floor((subtotalCents * value) / 100);
  return Math.max(0, Math.min(raw, subtotalCents));
}

export interface TabTotals {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}

/** RN-04.14: subtotal of the lines not canceled; total = subtotal − discount (never negative). */
export function tabTotals(
  lines: readonly {
    canceledAt: Date | null;
    unitPriceCents: number;
    quantity: number;
    modifiers: readonly { priceDeltaCents: number }[];
  }[],
  discount: { type: DiscountType | null; value: number | null } = { type: null, value: null },
): TabTotals {
  const subtotalCents = lines
    .filter((line) => line.canceledAt === null)
    .reduce((sum, line) => sum + lineTotalCents(line), 0);
  const discount_ = discountCents(discount.type, discount.value, subtotalCents);
  return { subtotalCents, discountCents: discount_, totalCents: subtotalCents - discount_ };
}

// ------------------------------------------------------------------------------------------------
// Lateness (RN-04.23; CA-04.11)
// ------------------------------------------------------------------------------------------------

/**
 * When an item becomes late: `late_after_minutes` after the order was sent. `null` for lines that
 * cannot be late (canceled or in the final stage).
 */
export function lateAtOf(
  line: { canceledAt: Date | null; inFinalStage: boolean; sentAt: Date },
  lateAfterMinutes: number,
): Date | null {
  if (line.canceledAt !== null || line.inFinalStage) {
    return null;
  }
  return toDate(toInstant(line.sentAt).add({ minutes: lateAfterMinutes }));
}

export function isLate(lateAt: Date | null, now: Date): boolean {
  return lateAt !== null && now.getTime() >= lateAt.getTime();
}

/** RN-04.27: canceling after the item left the first stage marks it as waste. */
export function isWaste(stageSortOrder: number, firstStageSortOrder: number): boolean {
  return stageSortOrder > firstStageSortOrder;
}
