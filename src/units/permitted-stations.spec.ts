import { describe, expect, it } from 'vitest';

import { activeStationsOf, permittedStations, type StationRow } from './permitted-stations.js';

const UNIT = '01922f2c-7a3b-7c00-8000-0000000000a0';
const OTHER = '01922f2c-7a3b-7c00-8000-0000000000b0';
const row = (id: string, unitId: string, sortOrder: number, active = true): StationRow => ({
  id,
  unitId,
  name: `Estação ${id.slice(-2)}`,
  kind: 'queue',
  sortOrder,
  active,
});
const stations = [
  row('01922f2c-7a3b-7c00-8000-0000000000a2', UNIT, 2),
  row('01922f2c-7a3b-7c00-8000-0000000000a1', UNIT, 1),
  row('01922f2c-7a3b-7c00-8000-0000000000a3', UNIT, 3, false),
  row('01922f2c-7a3b-7c00-8000-0000000000b1', OTHER, 1),
];

describe('stations a permission opens (RN-03.16)', () => {
  it('keeps only active stations of the same unit, in display order', () => {
    const ids = stations.map((station) => station.id);
    expect(permittedStations(UNIT, ids, stations).map((station) => station.id)).toEqual([
      '01922f2c-7a3b-7c00-8000-0000000000a1',
      '01922f2c-7a3b-7c00-8000-0000000000a2',
    ]);
    expect(permittedStations(UNIT, ['01922f2c-7a3b-7c00-8000-0000000000b1'], stations)).toEqual([]);
  });

  it('the owner opens every active station of the unit', () => {
    expect(activeStationsOf(UNIT, stations)).toHaveLength(2);
  });
});
