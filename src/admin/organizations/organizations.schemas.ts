import { z } from 'zod';

import { PaginationQuerySchema, pageSchema } from '../../common/pagination.js';
import { SubscriptionStatusSchema } from '../../openapi/enum-schemas.js';
import {
  EmailInputSchema,
  PersonNameSchema,
  reasonSchema,
  SearchSchema,
} from '../admin-schemas.js';

const OrganizationNameSchema = z
  .string({ error: 'Informe o nome da organização.' })
  .trim()
  .min(2, { error: 'O nome precisa ter pelo menos 2 caracteres.' })
  .max(120, { error: 'O nome pode ter no máximo 120 caracteres.' });

const UnitNameSchema = z
  .string({ error: 'Informe o nome da unidade.' })
  .trim()
  .min(2, { error: 'O nome precisa ter pelo menos 2 caracteres.' })
  .max(80, { error: 'O nome pode ter no máximo 80 caracteres.' });

/** RN-02.11: every change of situation has a reason (at least 3 characters), kept in the audit. */
const StatusReasonSchema = reasonSchema(3);

export const OwnerInviteStatusSchema = z.enum(['pending', 'expired', 'accepted']).meta({
  id: 'OwnerInviteStatus',
  description:
    '`accepted`: o dono já definiu a senha; `pending`: convite válido sem uso; `expired`: convite vencido (reenvie).',
});

export const OrganizationOwnerSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    active: z.boolean(),
    inviteStatus: OwnerInviteStatusSchema,
    inviteExpiresAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'OrganizationOwner' });

export const OrganizationSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    accessCode: z.string(),
    subscriptionStatus: SubscriptionStatusSchema,
    suspendedReason: z
      .string()
      .nullable()
      .meta({ description: 'Motivo da suspensão ou do cancelamento.' }),
    createdAt: z.iso.datetime(),
    owner: OrganizationOwnerSchema.nullable(),
  })
  .meta({ id: 'OrganizationSummary' });

export const OrganizationPageSchema = pageSchema('OrganizationPage', OrganizationSummarySchema);

export const OrganizationListQuerySchema = PaginationQuerySchema.extend({
  search: SearchSchema.meta({
    description:
      'Parte do nome da organização ou do e-mail do dono, ou o código do estabelecimento.',
  }),
  status: SubscriptionStatusSchema.optional(),
});

export const OrganizationUnitSchema = z
  .object({ id: z.uuid(), name: z.string(), active: z.boolean() })
  .meta({ id: 'OrganizationUnit' });

export const OrganizationOperationDaySchema = z
  .object({
    unitId: z.uuid(),
    unitName: z.string(),
    businessDate: z.iso.date().meta({ description: 'Dia de operação.' }),
    salesCents: z.number().int().meta({ description: 'Venda do dia (spec 07, RN-07.01).' }),
  })
  .meta({
    id: 'OrganizationOperationDay',
    description: 'Dia de operação no detalhe da organização (spec 02, seção 4).',
  });

export const OrganizationDetailSchema = OrganizationSummarySchema.extend({
  units: z.array(OrganizationUnitSchema),
  activeStaffCount: z.number().int(),
  recentOperationDays: z
    .array(OrganizationOperationDaySchema)
    .meta({ description: 'Últimos 10 dias de operação (unidade, dia, venda), do mais novo.' }),
  lastAccessAt: z.iso.datetime().nullable().meta({
    description:
      'Último login ou renovação de sessão de qualquer usuário da organização (sem contar o "entrar como").',
  }),
  unreadAnnouncements: z
    .number()
    .int()
    .meta({ description: 'Comunicados publicados para a organização que o dono ainda não leu.' }),
}).meta({ id: 'OrganizationDetail' });

export const CreateOrganizationRequestSchema = z
  .object({
    name: OrganizationNameSchema,
    unitName: UnitNameSchema.meta({ description: 'Nome da primeira unidade.' }),
    owner: z.object({ name: PersonNameSchema, email: EmailInputSchema }),
    subscriptionStatus: z
      .enum(['pilot', 'active'])
      .default('active')
      .meta({ description: 'Situação inicial (padrão `active`).' }),
  })
  .meta({ id: 'CreateOrganizationRequest' });

export const UpdateOrganizationRequestSchema = z
  .object({
    name: OrganizationNameSchema.optional(),
    owner: z
      .object({ name: PersonNameSchema.optional(), email: EmailInputSchema.optional() })
      .optional()
      .meta({
        description:
          'Trocar o e-mail de um dono que ainda não aceitou o convite envia um convite novo para o e-mail novo.',
      }),
  })
  .meta({ id: 'UpdateOrganizationRequest' });

export const SuspendOrganizationRequestSchema = z
  .object({ reason: StatusReasonSchema })
  .meta({ id: 'SuspendOrganizationRequest' });

export const ReactivateOrganizationRequestSchema = z
  .object({
    reason: StatusReasonSchema,
    status: z
      .enum(['active', 'pilot'])
      .default('active')
      .meta({ description: 'Situação depois de reativar (RN-02.12).' }),
  })
  .meta({ id: 'ReactivateOrganizationRequest' });

export const SubscriptionStatusChangeRequestSchema = z
  .object({ status: SubscriptionStatusSchema, reason: StatusReasonSchema })
  .meta({ id: 'SubscriptionStatusChangeRequest' });

export const OwnerInviteResponseSchema = z
  .object({ expiresAt: z.iso.datetime() })
  .meta({ id: 'OwnerInviteResponse' });

export type OrganizationSummary = z.infer<typeof OrganizationSummarySchema>;
export type OrganizationDetail = z.infer<typeof OrganizationDetailSchema>;
export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequestSchema>;
export type UpdateOrganizationRequest = z.infer<typeof UpdateOrganizationRequestSchema>;
