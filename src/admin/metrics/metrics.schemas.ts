import { z } from 'zod';

import { SubscriptionStatusSchema } from '../../openapi/enum-schemas.js';

const PlainDateSchema = z.iso.date({ error: 'Use o formato AAAA-MM-DD.' });

export const MetricsPeriodQuerySchema = z.object({
  from: PlainDateSchema.optional().meta({
    description: 'Primeiro dia (AAAA-MM-DD, horário de Brasília). Padrão: 29 dias antes de `to`.',
  }),
  to: PlainDateSchema.optional().meta({
    description: 'Último dia, inclusive (AAAA-MM-DD, horário de Brasília). Padrão: hoje.',
  }),
});

export const MetricsPeriodSchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date().meta({ description: 'Inclusive.' }),
    timeZone: z.literal('America/Sao_Paulo'),
  })
  .meta({ id: 'MetricsPeriod' });

export const MetricsOverviewSchema = z
  .object({
    period: MetricsPeriodSchema,
    organizationsByStatus: z
      .record(SubscriptionStatusSchema, z.number().int())
      .meta({ description: 'Contagem atual por situação da assinatura.' }),
    activeOrganizations: z
      .number()
      .int()
      .meta({ description: 'Organizações com pelo menos um caixa aberto no período.' }),
    operationDays: z.object({
      total: z.number().int().meta({
        description:
          'Dias de operação: pares (unidade, dia de operação) com caixa aberto no período (spec 02, seção 6).',
      }),
      byWeek: z.array(
        z.object({
          weekStart: z.iso.date().meta({ description: 'Segunda-feira da semana.' }),
          count: z.number().int(),
        }),
      ),
    }),
    tabs: z
      .number()
      .int()
      .meta({ description: 'Comandas pagas, penduradas ou quitadas no período.' }),
    soldCents: z.number().int().meta({ description: 'Valor vendido registrado, em centavos.' }),
    averageTicketCents: z
      .number()
      .int()
      .meta({ description: 'Valor vendido / comandas, em centavos (0 sem comandas).' }),
  })
  .meta({
    id: 'MetricsOverview',
    description:
      'Painel de métricas (spec 02, seção 6). Dias de operação e comandas vêm das specs 04 a 06.',
  });

export const OrganizationUsageSortSchema = z.enum([
  'name',
  'operationDays',
  'tabs',
  'soldCents',
  'lastAccessAt',
]);

export const OrganizationUsageQuerySchema = MetricsPeriodQuerySchema.extend({
  sort: OrganizationUsageSortSchema.default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

export const OrganizationUsageSchema = z
  .object({
    organizationId: z.uuid(),
    name: z.string(),
    subscriptionStatus: SubscriptionStatusSchema,
    operationDays: z.number().int().meta({ description: 'Dias de operação no período.' }),
    tabs: z.number().int(),
    soldCents: z.number().int(),
    lastAccessAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'OrganizationUsage' });

export const OrganizationUsageListSchema = z
  .object({ period: MetricsPeriodSchema, data: z.array(OrganizationUsageSchema) })
  .meta({ id: 'OrganizationUsageList', description: 'Uso por organização (todas, ordenadas).' });

export type MetricsOverview = z.infer<typeof MetricsOverviewSchema>;
export type OrganizationUsage = z.infer<typeof OrganizationUsageSchema>;
