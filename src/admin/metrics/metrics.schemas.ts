import { z } from 'zod';

import { SubscriptionStatusSchema } from '../../openapi/enum-schemas.js';

const PlainDateSchema = z.iso.date({ error: 'Use o formato AAAA-MM-DD.' });

export const MetricsPeriodQuerySchema = z
  .object({
    from: PlainDateSchema.optional().meta({
      description: 'Primeiro dia (AAAA-MM-DD, horário de Brasília). Padrão: 29 dias antes de `to`.',
    }),
    to: PlainDateSchema.optional().meta({
      description: 'Último dia, inclusive (AAAA-MM-DD, horário de Brasília). Padrão: hoje.',
    }),
  })
  .meta({ id: 'MetricsPeriodQuery' });

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
      .meta({ description: 'Organizações com pelo menos um turno aberto no período.' }),
    shifts: z.object({
      total: z.number().int().meta({ description: 'Turnos fechados no período.' }),
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
      'Painel de métricas (spec 02, seção 6). Turnos e comandas vêm das specs 04 a 06; até lá ficam em zero.',
  });

export const OrganizationUsageSortSchema = z.enum([
  'name',
  'shifts',
  'tabs',
  'soldCents',
  'lastAccessAt',
]);

export const OrganizationUsageQuerySchema = MetricsPeriodQuerySchema.extend({
  sort: OrganizationUsageSortSchema.default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
}).meta({ id: 'OrganizationUsageQuery' });

export const OrganizationUsageSchema = z
  .object({
    organizationId: z.uuid(),
    name: z.string(),
    subscriptionStatus: SubscriptionStatusSchema,
    shifts: z.number().int(),
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
