import { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import type { SubscriptionStatus } from '../generated/prisma/enums.js';

/**
 * Effects of the subscription situation on the operation (RN-01.01, RN-02.12): a `suspended` or
 * `canceled` organization does not open new shifts; shifts already open keep working until closed.
 *
 * Spec 04 (opening a shift) calls {@link assertCanOpenShift} with the organization of the request;
 * the panel shows the banner from `GET /auth/me` (`organization.subscriptionStatus`).
 */
export const SUBSCRIPTION_ERRORS = {
  ORGANIZATION_SUSPENDED: {
    status: 409,
    message:
      'A conta desta barraca está suspensa: não é possível abrir turno. Fale com a equipe do Varal.',
  },
  ORGANIZATION_CANCELED: {
    status: 409,
    message:
      'A assinatura desta barraca foi cancelada: não é possível abrir turno. Fale com a equipe do Varal.',
  },
} as const satisfies Record<string, { status: number; message: string }>;

export type SubscriptionErrorCode = keyof typeof SUBSCRIPTION_ERRORS;

export const SubscriptionErrorCodeSchema = z
  .enum(Object.keys(SUBSCRIPTION_ERRORS) as [SubscriptionErrorCode, ...SubscriptionErrorCode[]])
  .meta({
    id: 'SubscriptionErrorCode',
    description: 'Erros da situação da assinatura ao abrir turno (RN-01.01, RN-02.12; CA-02.05).',
  });

/** True when new shifts may be opened (RN-01.01). */
export function canOpenShift(status: SubscriptionStatus): boolean {
  return status === 'pilot' || status === 'active';
}

/** Throws `ORGANIZATION_SUSPENDED` or `ORGANIZATION_CANCELED` (409) when no shift may be opened. */
export function assertCanOpenShift(status: SubscriptionStatus): void {
  if (canOpenShift(status)) {
    return;
  }
  const code: SubscriptionErrorCode =
    status === 'suspended' ? 'ORGANIZATION_SUSPENDED' : 'ORGANIZATION_CANCELED';
  const { status: httpStatus, message } = SUBSCRIPTION_ERRORS[code];
  throw new AppError(code, httpStatus, message);
}
