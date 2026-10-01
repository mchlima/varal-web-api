import { describe, expect, it } from 'vitest';

import { isValidPrepStation, resolvePrepStationId, stationForStage } from './routing.js';

const KITCHEN = '01922f2c-7a3b-7c00-8000-000000000001';
const FRYER = '01922f2c-7a3b-7c00-8000-000000000002';
const DELIVERY = '01922f2c-7a3b-7c00-8000-000000000003';

describe('routing (spec 03, section 4.3)', () => {
  it('CA-03.04 / RN-03.08: a product with its own station goes there; without it, to the category station', () => {
    expect(resolvePrepStationId({ stationId: FRYER }, { defaultStationId: KITCHEN })).toBe(FRYER);
    expect(resolvePrepStationId({ stationId: null }, { defaultStationId: KITCHEN })).toBe(KITCHEN);
  });

  it('RN-03.08: only an active queue station prepares items', () => {
    expect(isValidPrepStation({ id: KITCHEN, kind: 'queue', active: true })).toBe(true);
    expect(isValidPrepStation({ id: KITCHEN, kind: 'counter', active: true })).toBe(false);
    expect(isValidPrepStation({ id: KITCHEN, kind: 'queue', active: false })).toBe(false);
    expect(isValidPrepStation(null)).toBe(false);
  });

  it('section 4.2: the stage decides where the item shows up', () => {
    expect(stationForStage({ target: 'product_station', stationId: null }, FRYER)).toBe(FRYER);
    expect(stationForStage({ target: 'fixed_station', stationId: DELIVERY }, FRYER)).toBe(DELIVERY);
    expect(stationForStage({ target: 'none', stationId: null }, FRYER)).toBeNull();
  });
});
