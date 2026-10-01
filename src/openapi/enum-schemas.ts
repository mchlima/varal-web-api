import { z } from 'zod';

import {
  ActorType,
  EmailStatus,
  EmailType,
  SubscriptionStatus,
} from '../generated/prisma/enums.js';

/*
 * State enums published in `components.schemas` (RN-01.10). Built from the Prisma enums, so the
 * database, the API and the apps share one list of values.
 */

export const SubscriptionStatusSchema = z.enum(SubscriptionStatus).meta({
  id: 'SubscriptionStatus',
  description: 'Situação da assinatura da organização (RN-02.11).',
});

export const ActorTypeSchema = z
  .enum(ActorType)
  .meta({ id: 'ActorType', description: 'Quem fez a ação registrada na auditoria.' });

export const EmailTypeSchema = z
  .enum(EmailType)
  .meta({ id: 'EmailType', description: 'Tipos de e-mail do MVP (spec 01, seção 9).' });

export const EmailStatusSchema = z
  .enum(EmailStatus)
  .meta({ id: 'EmailStatus', description: 'Situação de um envio de e-mail.' });
