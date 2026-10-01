import type { StationKind } from '../generated/prisma/enums.js';

export interface StationRow {
  id: string;
  unitId: string;
  name: string;
  kind: StationKind;
  sortOrder: number;
  active: boolean;
}

export interface StationSummary {
  id: string;
  name: string;
  kind: StationKind;
}

/**
 * Stations a permission really opens (RN-03.16): among `stationIds`, the active stations of that
 * unit, in display order. `station_ids` has no foreign key, so ids of another unit, of a
 * deactivated station or of nothing are dropped here (spec 03, README).
 */
export function permittedStations(
  unitId: string,
  stationIds: readonly string[],
  stations: readonly StationRow[],
): StationSummary[] {
  const wanted = new Set(stationIds.map((id) => id.toLowerCase()));
  return stations
    .filter((station) => station.unitId === unitId && station.active && wanted.has(station.id))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    .map((station) => ({ id: station.id, name: station.name, kind: station.kind }));
}

/** Every active station of a unit, in display order (the owner opens any of them). */
export function activeStationsOf(
  unitId: string,
  stations: readonly StationRow[],
): StationSummary[] {
  return permittedStations(
    unitId,
    stations.map((station) => station.id),
    stations,
  );
}
