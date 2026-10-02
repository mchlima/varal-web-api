import { describe, expect, it } from 'vitest';

import { assertCanOpenCashRegister, canOpenCashRegister } from './subscription.js';

describe('subscription effects (RN-01.01, RN-02.12, RN-05.24)', () => {
  it('pilot and active organizations open cash registers', () => {
    expect(canOpenCashRegister('pilot')).toBe(true);
    expect(canOpenCashRegister('active')).toBe(true);
    expect(() => {
      assertCanOpenCashRegister('active');
    }).not.toThrow();
  });

  it('CA-02.05: a suspended organization cannot open a cash register (ORGANIZATION_SUSPENDED)', () => {
    expect(() => {
      assertCanOpenCashRegister('suspended');
    }).toThrow(expect.objectContaining({ code: 'ORGANIZATION_SUSPENDED', status: 409 }) as Error);
  });

  it('a canceled organization cannot open a cash register either (ORGANIZATION_CANCELED)', () => {
    expect(() => {
      assertCanOpenCashRegister('canceled');
    }).toThrow(expect.objectContaining({ code: 'ORGANIZATION_CANCELED' }) as Error);
  });
});
