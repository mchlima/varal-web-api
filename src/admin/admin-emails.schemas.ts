import { z } from 'zod';

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
