import { describe, expect, it } from 'vitest';

import { applyPayment, countsOf, expectedOf, paidCents } from './payment-rules.js';

describe('payment rules (spec 05, section 4)', () => {
  it('RN-05.07: reversed payments do not count', () => {
    expect(
      paidCents([
        { amountCents: 5000, reversedAt: null },
        { amountCents: 3000, reversedAt: new Date() },
      ]),
    ).toBe(5000);
  });

  it('CA-05.02, RN-05.09: cash applies the smaller of tendered and balance; the rest is change', () => {
    expect(applyPayment({ method: 'cash', tenderedCents: 5000 }, 4600)).toEqual({
      amountCents: 4600,
      tenderedCents: 5000,
      changeCents: 400,
    });
    expect(applyPayment({ method: 'cash', tenderedCents: 2000 }, 4600)).toEqual({
      amountCents: 2000,
      tenderedCents: 2000,
      changeCents: 0,
    });
  });

  it('CA-05.03, RN-05.08: pix and cards never go past the balance', () => {
    expect(applyPayment({ method: 'pix', amountCents: 5001 }, 5000)).toBe('exceeds_balance');
    expect(applyPayment({ method: 'credit_card', amountCents: 5000 }, 5000)).toEqual({
      amountCents: 5000,
      tenderedCents: null,
      changeCents: null,
    });
    expect(applyPayment({ method: 'debit_card' }, 5000)).toBe('missing_amount');
  });

  it('RN-05.11: nothing to pay without balance', () => {
    expect(applyPayment({ method: 'cash', tenderedCents: 100 }, 0)).toBe('nothing_to_pay');
  });
});

describe('cash register rules (spec 05, section 5)', () => {
  it('CA-05.06, RN-05.19: float 100 + cash 300 − withdrawal 200 + deposit 50 = 250', () => {
    const { expected, cash } = expectedOf(
      { openingFloatCents: 10_000 },
      [
        { method: 'cash', amountCents: 30_000, reversedAt: null },
        { method: 'cash', amountCents: 9_999, reversedAt: new Date() },
        { method: 'pix', amountCents: 1_000, reversedAt: null },
        { method: 'credit_card', amountCents: 700, reversedAt: null },
        { method: 'debit_card', amountCents: 300, reversedAt: null },
      ],
      [
        { type: 'withdrawal', amountCents: 20_000 },
        { type: 'deposit', amountCents: 5_000 },
      ],
    );
    expect(expected).toEqual({ cash: 25_000, pix: 1_000, credit_card: 700, debit_card: 300 });
    expect(cash).toEqual({
      openingFloatCents: 10_000,
      paymentsCents: 30_000,
      creditSettlementsCents: 0,
      depositsCents: 5_000,
      withdrawalsCents: 20_000,
    });
  });

  it('RN-05.20: difference = informed − expected, per method', () => {
    const counts = countsOf(
      { cash: 25_000, pix: 1_000, credit_card: 700, debit_card: 300 },
      new Map([
        ['cash', 24_900],
        ['pix', 1_000],
        ['credit_card', 800],
        ['debit_card', 300],
      ] as const),
    );
    expect(counts.map((count) => [count.method, count.differenceCents])).toEqual([
      ['cash', -100],
      ['pix', 0],
      ['credit_card', 100],
      ['debit_card', 0],
    ]);
  });
});
