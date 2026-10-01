import { describe, expect, it } from 'vitest';

import { assertCanOpenShift, canOpenShift } from './subscription.js';

describe('subscription effects (RN-01.01, RN-02.12)', () => {
  it('pilot and active organizations open shifts', () => {
    expect(canOpenShift('pilot')).toBe(true);
    expect(canOpenShift('active')).toBe(true);
    expect(() => {
      assertCanOpenShift('active');
    }).not.toThrow();
  });

  it('CA-02.05: a suspended organization cannot open a shift (ORGANIZATION_SUSPENDED)', () => {
    expect(() => {
      assertCanOpenShift('suspended');
    }).toThrow(expect.objectContaining({ code: 'ORGANIZATION_SUSPENDED', status: 409 }) as Error);
  });

  it('a canceled organization cannot open a shift either (ORGANIZATION_CANCELED)', () => {
    expect(() => {
      assertCanOpenShift('canceled');
    }).toThrow(expect.objectContaining({ code: 'ORGANIZATION_CANCELED' }) as Error);
  });
});
