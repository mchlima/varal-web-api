import type { ContractedEvent } from '../generated/prisma/client.js';
import type { TenantDb } from '../prisma/prisma.service.js';

/** RN-03.20: "Normal" is the normal price of the menu, never the name of a list. */
export const NORMAL_PRICE_LIST_NAME = 'Normal';

export interface PriceListRef {
  id: string;
  name: string;
}

export interface UnitPricing {
  /** The current list of the unit (RN-04.06); null = "Normal". */
  current: PriceListRef | null;
  /** The list that prices new items (RN-04.32): the event's while one is in progress. */
  effective: PriceListRef | null;
  /** The event in progress of the unit, if any (RN-04.35). */
  eventInProgress: ContractedEvent | null;
}

/** RN-04.32: the effective list is the event's (or "Normal") while an event is in progress. */
export function effectivePriceListId(
  currentPriceListId: string | null,
  eventInProgress: { priceListId: string | null } | null,
): string | null {
  return eventInProgress === null ? currentPriceListId : eventInProgress.priceListId;
}

/** RN-03.21: the price of the list when the product has one, else the normal price. */
export function priceFor(
  product: { id: string; priceCents: number },
  listPrices: ReadonlyMap<string, number>,
): { priceCents: number; fromList: boolean } {
  const listed = listPrices.get(product.id);
  return listed === undefined
    ? { priceCents: product.priceCents, fromList: false }
    : { priceCents: listed, fromList: true };
}

/** Current and effective price lists of a unit (RN-04.06, RN-04.32). */
export async function loadUnitPricing(db: TenantDb, unitId: string): Promise<UnitPricing> {
  const [unit, eventInProgress] = await Promise.all([
    db.unit.findUniqueOrThrow({ where: { id: unitId }, select: { currentPriceListId: true } }),
    db.contractedEvent.findFirst({ where: { unitId, status: 'in_progress' } }),
  ]);
  const effectiveId = effectivePriceListId(unit.currentPriceListId, eventInProgress);
  const ids = [
    ...new Set([unit.currentPriceListId, effectiveId].filter((id): id is string => id !== null)),
  ];
  const lists =
    ids.length === 0
      ? []
      : await db.priceList.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true },
        });
  const ref = (id: string | null) => lists.find((list) => list.id === id) ?? null;
  return { current: ref(unit.currentPriceListId), effective: ref(effectiveId), eventInProgress };
}

/** Prices of one list by product (empty for "Normal"). */
export async function listPrices(
  db: TenantDb,
  priceListId: string | null,
): Promise<Map<string, number>> {
  if (priceListId === null) {
    return new Map();
  }
  const rows = await db.productPrice.findMany({ where: { priceListId } });
  return new Map(rows.map((row) => [row.productId, row.priceCents]));
}
