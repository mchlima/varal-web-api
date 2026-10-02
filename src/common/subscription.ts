import { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import type { SubscriptionStatus } from '../generated/prisma/enums.js';

/**
 * Effects of the subscription situation on the operation (RN-01.01, RN-02.12): a `suspended` or
 * `canceled` organization does not open cash registers (spec 05, RN-05.24), so it does not start a
 * new day; registers already open keep working until closed.
 *
 * Spec 05 (opening a cash register) calls {@link assertCanOpenCashRegister} with the organization of
 * the request; the panel shows the banner from `GET /auth/me` (`organization.subscriptionStatus`).
 */
export const SUBSCRIPTION_ERRORS = {
  ORGANIZATION_SUSPENDED: {
    status: 409,
    message:
      'A conta desta barraca está suspensa: não é possível abrir o caixa. Fale com a equipe do Varal.',
  },
  ORGANIZATION_CANCELED: {
    status: 409,
    message:
      'A assinatura desta barraca foi cancelada: não é possível abrir o caixa. Fale com a equipe do Varal.',
  },
} as const satisfies Record<string, { status: number; message: string }>;

export type SubscriptionErrorCode = keyof typeof SUBSCRIPTION_ERRORS;

export const SubscriptionErrorCodeSchema = z
  .enum(Object.keys(SUBSCRIPTION_ERRORS) as [SubscriptionErrorCode, ...SubscriptionErrorCode[]])
  .meta({
    id: 'SubscriptionErrorCode',
    description:
      'Erros da situação da assinatura ao abrir caixa (RN-01.01, RN-02.12, RN-05.24; CA-02.05).',
  });

/** True when cash registers may be opened (RN-01.01, RN-05.24). */
export function canOpenCashRegister(status: SubscriptionStatus): boolean {
  return status === 'pilot' || status === 'active';
}

/** Throws `ORGANIZATION_SUSPENDED` or `ORGANIZATION_CANCELED` (409) when no register may be opened. */
export function assertCanOpenCashRegister(status: SubscriptionStatus): void {
  if (canOpenCashRegister(status)) {
    return;
  }
  const code: SubscriptionErrorCode =
    status === 'suspended' ? 'ORGANIZATION_SUSPENDED' : 'ORGANIZATION_CANCELED';
  const { status: httpStatus, message } = SUBSCRIPTION_ERRORS[code];
  throw new AppError(code, httpStatus, message);
}
