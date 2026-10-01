import type { CashMovementType, PaymentMethod } from '../generated/prisma/enums.js';

/*
 * Pure rules of payments and cash registers (spec 05, sections 4 and 5). No database access, so
 * they are unit tested on their own.
 */

/** Order the methods are shown and counted in (RN-05.04, section 5 table). */
export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  'cash',
  'pix',
  'credit_card',
  'debit_card',
];

/** RN-05.07: the payments that count (not reversed). */
export function paidCents(
  payments: readonly { amountCents: number; reversedAt: Date | null }[],
): number {
  return payments
    .filter((payment) => payment.reversedAt === null)
    .reduce((sum, payment) => sum + payment.amountCents, 0);
}

export type PaymentRefusal =
  /** RN-05.11: nothing left to pay. */
  | 'nothing_to_pay'
  /** RN-05.08: pix and cards never go past the balance. */
  | 'exceeds_balance'
  /** RN-05.09: cash needs the tendered amount; the other methods need the amount. */
  | 'missing_amount';

export interface AppliedPayment {
  amountCents: number;
  tenderedCents: number | null;
  changeCents: number | null;
}

/**
 * RN-05.08, RN-05.09: what a payment applies to a balance. Pix and cards apply `amount`, never more
 * than the balance. Cash applies the smaller of what was tendered and the balance; the change is
 * the rest (CA-05.02).
 */
export function applyPayment(
  input: {
    method: PaymentMethod;
    amountCents?: number | undefined;
    tenderedCents?: number | undefined;
  },
  balanceCents: number,
): AppliedPayment | PaymentRefusal {
  if (balanceCents <= 0) {
    return 'nothing_to_pay';
  }
  if (input.method === 'cash') {
    if (input.tenderedCents === undefined) {
      return 'missing_amount';
    }
    const amountCents = Math.min(input.tenderedCents, balanceCents);
    return {
      amountCents,
      tenderedCents: input.tenderedCents,
      changeCents: input.tenderedCents - amountCents,
    };
  }
  if (input.amountCents === undefined) {
    return 'missing_amount';
  }
  if (input.amountCents > balanceCents) {
    return 'exceeds_balance';
  }
  return { amountCents: input.amountCents, tenderedCents: null, changeCents: null };
}

export type ExpectedByMethod = Record<PaymentMethod, number>;

export interface CashBreakdown {
  openingFloatCents: number;
  paymentsCents: number;
  /** RN-05.22: part of `paymentsCents` that settled tabs on credit (spec 06). */
  creditSettlementsCents: number;
  depositsCents: number;
  withdrawalsCents: number;
}

/**
 * RN-05.19 and the table of section 5: expected per method. Cash = float + cash payments (applied,
 * not reversed) + deposits − withdrawals (CA-05.06); the other methods, the sum of their payments
 * not reversed (RN-05.15).
 */
export function expectedOf(
  register: { openingFloatCents: number },
  payments: readonly {
    method: PaymentMethod;
    amountCents: number;
    reversedAt: Date | null;
    isCreditSettlement?: boolean;
  }[],
  movements: readonly { type: CashMovementType; amountCents: number }[],
): { expected: ExpectedByMethod; cash: CashBreakdown; creditSettlements: ExpectedByMethod } {
  const byMethod = (method: PaymentMethod) =>
    paidCents(payments.filter((payment) => payment.method === method));
  // RN-05.22: settlements of tabs on credit are in the expected value and also shown apart.
  const settledBy = (method: PaymentMethod) =>
    paidCents(
      payments.filter(
        (payment) => payment.method === method && payment.isCreditSettlement === true,
      ),
    );
  const sumOf = (type: CashMovementType) =>
    movements
      .filter((movement) => movement.type === type)
      .reduce((sum, movement) => sum + movement.amountCents, 0);
  const cash: CashBreakdown = {
    openingFloatCents: register.openingFloatCents,
    paymentsCents: byMethod('cash'),
    creditSettlementsCents: settledBy('cash'),
    depositsCents: sumOf('deposit'),
    withdrawalsCents: sumOf('withdrawal'),
  };
  return {
    expected: {
      cash:
        cash.openingFloatCents + cash.paymentsCents + cash.depositsCents - cash.withdrawalsCents,
      pix: byMethod('pix'),
      credit_card: byMethod('credit_card'),
      debit_card: byMethod('debit_card'),
    },
    cash,
    creditSettlements: {
      cash: settledBy('cash'),
      pix: settledBy('pix'),
      credit_card: settledBy('credit_card'),
      debit_card: settledBy('debit_card'),
    },
  };
}

export interface CountResult {
  method: PaymentMethod;
  expectedCents: number;
  informedCents: number;
  differenceCents: number;
}

/** RN-05.20: difference of each method = informed − expected. */
export function countsOf(
  expected: ExpectedByMethod,
  informed: ReadonlyMap<PaymentMethod, number>,
): CountResult[] {
  return PAYMENT_METHODS.map((method) => {
    const informedCents = informed.get(method) ?? 0;
    const expectedCents = expected[method];
    return { method, expectedCents, informedCents, differenceCents: informedCents - expectedCents };
  });
}
