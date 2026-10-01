import { z } from 'zod';

import { PaginationQuerySchema, pageSchema } from '../common/pagination.js';
import { EmailStatusSchema, EmailTypeSchema } from '../openapi/enum-schemas.js';
import { InstantFilterSchema } from './admin-schemas.js';

export const EmailUsageLevelSchema = z.enum(['ok', 'warning', 'critical']).meta({
  id: 'EmailUsageLevel',
  description:
    'RN-01.04: `warning` a partir de 8.000 envios no mês (alerta no admin); `critical` a partir de 10.000 (só convites e redefinições continuam).',
});

export const EmailUsageSchema = z
  .object({
    month: z
      .string()
      .meta({ description: 'Mês em `America/Sao_Paulo` (AAAA-MM).', examples: ['2026-10'] }),
    count: z
      .number()
      .int()
      .meta({ description: 'E-mails enfileirados ou enviados no mês (falhas não contam).' }),
    limit: z.number().int(),
    warningThreshold: z.number().int(),
    level: EmailUsageLevelSchema,
  })
  .meta({ id: 'EmailUsage' });

export type EmailUsageResponse = z.infer<typeof EmailUsageSchema>;

export const EmailLogSchema = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid().nullable(),
    to: z.string(),
    type: EmailTypeSchema,
    status: EmailStatusSchema,
    error: z.string().nullable().meta({ description: 'Erro da última tentativa, se falhou.' }),
    createdAt: z.iso.datetime(),
    sentAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'EmailLog' });

export const EmailLogPageSchema = pageSchema('EmailLogPage', EmailLogSchema);

export const EmailLogListQuerySchema = PaginationQuerySchema.extend({
  type: EmailTypeSchema.optional(),
  status: EmailStatusSchema.optional(),
  organizationId: z.uuid().optional(),
  from: InstantFilterSchema.meta({ description: 'Criados a partir deste instante (inclusive).' }),
  to: InstantFilterSchema.meta({ description: 'Criados antes deste instante.' }),
}).meta({ id: 'EmailLogListQuery' });
