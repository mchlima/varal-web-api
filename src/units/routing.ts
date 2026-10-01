import type { StationKind, WorkflowStageTarget } from '../generated/prisma/enums.js';

/*
 * Routing of items to stations (spec 03, sections 4.2 and 4.3). Pure functions, shared by the menu
 * (to show the resolved station) and by spec 04, which resolves the station when the order is sent
 * and copies it into the item (RN-04.18, RN-04.19).
 */

export interface RoutingStation {
  id: string;
  kind: StationKind;
  active: boolean;
}

/**
 * RN-03.08: the preparation station of an item is the product's, when defined; otherwise the
 * category's (CA-03.04).
 */
export function resolvePrepStationId(
  product: { stationId: string | null },
  category: { defaultStationId: string },
): string {
  return product.stationId ?? category.defaultStationId;
}

/** RN-03.08: a preparation station is an active `queue` station. */
export function isValidPrepStation(station: RoutingStation | undefined | null): boolean {
  return station?.kind === 'queue' && station.active;
}

/**
 * Station where an item in `stage` shows up (spec 03, section 4.2): the item's preparation station
 * for `product_station`, the stage's station for `fixed_station`, none for the final stage.
 */
export function stationForStage(
  stage: { target: WorkflowStageTarget; stationId: string | null },
  prepStationId: string,
): string | null {
  switch (stage.target) {
    case 'product_station':
      return prepStationId;
    case 'fixed_station':
      return stage.stationId;
    case 'none':
      return null;
  }
}
