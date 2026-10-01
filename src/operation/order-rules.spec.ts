import { describe, expect, it } from 'vitest';

import {
  checkOrderItems,
  copyModifiers,
  discountCents,
  isLate,
  isWaste,
  lateAtOf,
  lineTotalCents,
  type MenuProductForOrder,
  tabTotals,
  unitPriceFor,
} from './order-rules.js';

const UNIT = '01920000-0000-7000-8000-000000000001';

function product(overrides: Partial<MenuProductForOrder> = {}): MenuProductForOrder {
  return {
    id: 'p-carne',
    unitId: UNIT,
    name: 'Espeto de carne',
    priceCents: 1200,
    active: true,
    soldOut: false,
    categoryActive: true,
    groups: [
      {
        id: 'g-ponto',
        name: 'Ponto da carne',
        minChoices: 1,
        maxChoices: 1,
        sortOrder: 1,
        modifiers: [
          { id: 'm-mal', name: 'Mal passado', priceDeltaCents: 0, sortOrder: 1, active: true },
          { id: 'm-ponto', name: 'Ao ponto', priceDeltaCents: 0, sortOrder: 2, active: true },
        ],
      },
      {
        id: 'g-acomp',
        name: 'Acompanhamentos',
        minChoices: 0,
        maxChoices: 2,
        sortOrder: 2,
        modifiers: [
          { id: 'm-farofa', name: 'Farofa', priceDeltaCents: 0, sortOrder: 1, active: true },
          { id: 'm-alho', name: 'Pão de alho', priceDeltaCents: 300, sortOrder: 2, active: true },
          { id: 'm-velho', name: 'Antigo', priceDeltaCents: 100, sortOrder: 3, active: false },
        ],
      },
    ],
    ...overrides,
  };
}

function check(items: { productId: string; modifierIds: string[] }[], p = product()) {
  return checkOrderItems(UNIT, items, new Map([[p.id, p]]));
}

describe('checkOrderItems (RN-04.16, RN-04.17)', () => {
  it('accepts an item with the required choice and optional ones', () => {
    expect(check([{ productId: 'p-carne', modifierIds: ['m-ponto', 'm-alho'] }])).toEqual([]);
  });

  it('CA-03.06: refuses an item without a choice in a required group, pointing the group', () => {
    expect(check([{ productId: 'p-carne', modifierIds: [] }])).toEqual([
      { index: 0, productId: 'p-carne', reason: 'modifier_required', modifierGroupId: 'g-ponto' },
    ]);
  });

  it('refuses more choices than the maximum, unknown, inactive and repeated options', () => {
    const reasons = (modifierIds: string[]) =>
      check([{ productId: 'p-carne', modifierIds }]).map((rejection) => rejection.reason);
    expect(reasons(['m-mal', 'm-ponto'])).toEqual(['too_many_modifiers']);
    expect(reasons(['m-ponto', 'm-outro'])).toEqual(['invalid_modifier']);
    expect(reasons(['m-ponto', 'm-velho'])).toEqual(['invalid_modifier']);
    expect(reasons(['m-ponto', 'm-ponto'])).toEqual(['invalid_modifier']);
  });

  it('CA-04.06: refuses sold-out, inactive and unknown products, with the index of each item', () => {
    const soldOut = product({ soldOut: true });
    expect(check([{ productId: 'p-carne', modifierIds: ['m-ponto'] }], soldOut)).toEqual([
      { index: 0, productId: 'p-carne', reason: 'sold_out', modifierGroupId: null },
    ]);
    expect(
      check([{ productId: 'p-carne', modifierIds: ['m-ponto'] }], product({ active: false }))[0]
        ?.reason,
    ).toBe('product_inactive');
    expect(
      check(
        [{ productId: 'p-carne', modifierIds: ['m-ponto'] }],
        product({ categoryActive: false }),
      )[0]?.reason,
    ).toBe('product_inactive');
    expect(
      check(
        [
          { productId: 'p-carne', modifierIds: ['m-ponto'] },
          { productId: 'p-nada', modifierIds: [] },
        ],
        product(),
      ),
    ).toEqual([
      { index: 1, productId: 'p-nada', reason: 'product_unavailable', modifierGroupId: null },
    ]);
    expect(
      check([{ productId: 'p-carne', modifierIds: ['m-ponto'] }], product({ unitId: 'outra' }))[0]
        ?.reason,
    ).toBe('product_unavailable');
  });
});

describe('copy of what was sold (RN-04.18) and prices (RN-04.06)', () => {
  it('copies group and option names and deltas in menu order', () => {
    expect(copyModifiers(product(), ['m-alho', 'm-ponto'])).toEqual([
      {
        modifierId: 'm-ponto',
        groupName: 'Ponto da carne',
        modifierName: 'Ao ponto',
        priceDeltaCents: 0,
      },
      {
        modifierId: 'm-alho',
        groupName: 'Acompanhamentos',
        modifierName: 'Pão de alho',
        priceDeltaCents: 300,
      },
    ]);
  });

  it('CA-04.07: the shift price wins over the menu price, only for the products listed', () => {
    const prices = new Map([['p-carne', 1000]]);
    expect(unitPriceFor({ id: 'p-carne', priceCents: 1200 }, prices)).toBe(1000);
    expect(unitPriceFor({ id: 'p-frango', priceCents: 900 }, prices)).toBe(900);
    expect(unitPriceFor({ id: 'p-carne', priceCents: 1200 }, new Map())).toBe(1200);
  });
});

describe('values (RN-04.14; spec 05, RN-05.03)', () => {
  const line = (quantity: number, canceledAt: Date | null = null) => ({
    unitPriceCents: 1200,
    quantity,
    canceledAt,
    modifiers: [{ priceDeltaCents: 300 }, { priceDeltaCents: 0 }],
  });

  it('a line is (unit price + deltas) × quantity', () => {
    expect(lineTotalCents(line(3))).toBe(4500);
  });

  it('the subtotal ignores canceled lines; a split keeps the total (CA-04.13)', () => {
    expect(tabTotals([line(3)]).subtotalCents).toBe(4500);
    expect(tabTotals([line(1), line(2)]).subtotalCents).toBe(4500);
    expect(tabTotals([line(2), line(1, new Date())])).toEqual({
      subtotalCents: 3000,
      discountCents: 0,
      totalCents: 3000,
    });
  });

  it('discounts: amount capped at the subtotal, percent rounded down, never negative', () => {
    expect(discountCents('amount', 500, 4500)).toBe(500);
    expect(discountCents('amount', 9000, 4500)).toBe(4500);
    expect(discountCents('percent', 10, 4555)).toBe(455);
    expect(discountCents(null, null, 4500)).toBe(0);
    expect(tabTotals([line(3)], { type: 'percent', value: 100 }).totalCents).toBe(0);
  });
});

describe('lateness (RN-04.23) and waste (RN-04.27)', () => {
  const sentAt = new Date('2026-10-01T20:00:00.000Z');

  it('CA-04.11: late after late_after_minutes since the order was sent', () => {
    const lateAt = lateAtOf({ canceledAt: null, inFinalStage: false, sentAt }, 15);
    expect(lateAt?.toISOString()).toBe('2026-10-01T20:15:00.000Z');
    expect(isLate(lateAt, new Date('2026-10-01T20:14:59.999Z'))).toBe(false);
    expect(isLate(lateAt, new Date('2026-10-01T20:15:00.000Z'))).toBe(true);
  });

  it('final and canceled lines are never late', () => {
    expect(lateAtOf({ canceledAt: null, inFinalStage: true, sentAt }, 15)).toBeNull();
    expect(lateAtOf({ canceledAt: sentAt, inFinalStage: false, sentAt }, 15)).toBeNull();
    expect(isLate(null, new Date())).toBe(false);
  });

  it('canceling after the first stage is waste', () => {
    expect(isWaste(1, 1)).toBe(false);
    expect(isWaste(2, 1)).toBe(true);
  });
});
