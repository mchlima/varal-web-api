import { z } from 'zod';

import { PaginationQuerySchema, pageSchema } from '../../common/pagination.js';
import { SubscriptionStatusSchema } from '../../openapi/enum-schemas.js';

export const AnnouncementAudienceTypeSchema = z.enum(['all', 'by_status', 'selected']).meta({
  id: 'AnnouncementAudienceType',
  description:
    'Público (RN-02.14): todas as organizações, as de certas situações de assinatura, ou as escolhidas uma a uma.',
});

export const AnnouncementStatusSchema = z
  .enum(['draft', 'scheduled', 'published', 'archived'])
  .meta({
    id: 'AnnouncementStatus',
    description:
      'Situação do comunicado (RN-02.15). Um agendado vira publicado na data marcada; publicado só pode ser arquivado.',
  });

const TitleSchema = z
  .string({ error: 'Informe o título.' })
  .trim()
  .min(1, { error: 'Informe o título.' })
  .max(80, { error: 'O título pode ter no máximo 80 caracteres.' });

const BodySchema = z
  .string({ error: 'Informe o texto.' })
  .trim()
  .min(1, { error: 'Informe o texto.' })
  .max(2000, { error: 'O texto pode ter no máximo 2.000 caracteres.' })
  .meta({ description: 'Markdown simples (RN-02.13).' });

const StatusesSchema = z.array(SubscriptionStatusSchema).max(4);

const OrganizationIdsSchema = z.array(z.uuid()).max(500);

export const AnnouncementSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    body: z.string(),
    audienceType: AnnouncementAudienceTypeSchema,
    audienceStatuses: z.array(SubscriptionStatusSchema).meta({ description: 'Só em `by_status`.' }),
    organizationIds: z.array(z.uuid()).meta({ description: 'Só em `selected`.' }),
    status: AnnouncementStatusSchema,
    publishAt: z.iso.datetime().nullable(),
    publishedAt: z.iso.datetime().nullable(),
    archivedAt: z.iso.datetime().nullable(),
    createdBy: z.object({ id: z.uuid(), name: z.string() }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    readCount: z.number().int().meta({ description: 'Donos do público que já leram.' }),
    audienceOwnerCount: z
      .number()
      .int()
      .meta({ description: 'Donos ativos no público hoje (para "X de Y leram").' }),
  })
  .meta({ id: 'Announcement' });

export const AnnouncementPageSchema = pageSchema('AnnouncementPage', AnnouncementSchema);

export const AnnouncementListQuerySchema = PaginationQuerySchema.extend({
  status: AnnouncementStatusSchema.optional(),
});

interface AudienceInput {
  audienceType?: 'all' | 'by_status' | 'selected' | undefined;
  audienceStatuses?: string[] | undefined;
  organizationIds?: string[] | undefined;
}

/** RN-02.14: `by_status` needs at least one situation and `selected` at least one organization. */
export function checkAudience(value: AudienceInput, context: z.RefinementCtx): void {
  if (value.audienceType === 'by_status' && (value.audienceStatuses?.length ?? 0) === 0) {
    context.addIssue({
      code: 'custom',
      path: ['audienceStatuses'],
      message: 'Escolha pelo menos uma situação de assinatura.',
    });
  }
  if (value.audienceType === 'selected' && (value.organizationIds?.length ?? 0) === 0) {
    context.addIssue({
      code: 'custom',
      path: ['organizationIds'],
      message: 'Escolha pelo menos uma organização.',
    });
  }
}

export const CreateAnnouncementRequestSchema = z
  .object({
    title: TitleSchema,
    body: BodySchema,
    audienceType: AnnouncementAudienceTypeSchema,
    audienceStatuses: StatusesSchema.default([]),
    organizationIds: OrganizationIdsSchema.default([]),
  })
  .superRefine(checkAudience)
  .meta({ id: 'CreateAnnouncementRequest', description: 'Cria o comunicado como rascunho.' });

export const UpdateAnnouncementRequestSchema = z
  .object({
    title: TitleSchema.optional(),
    body: BodySchema.optional(),
    audienceType: AnnouncementAudienceTypeSchema.optional(),
    audienceStatuses: StatusesSchema.optional(),
    organizationIds: OrganizationIdsSchema.optional(),
  })
  .meta({
    id: 'UpdateAnnouncementRequest',
    description: 'Só rascunhos e agendados ainda não publicados (RN-02.15).',
  });

export const PublishAnnouncementRequestSchema = z
  .object({
    publishAt: z.iso.datetime({ offset: true }).optional().meta({
      description:
        'Data e hora da publicação. Ausente ou no passado: publica agora; no futuro: agenda.',
    }),
  })
  .meta({ id: 'PublishAnnouncementRequest' });

export type AnnouncementResponse = z.infer<typeof AnnouncementSchema>;
export type CreateAnnouncementRequest = z.infer<typeof CreateAnnouncementRequestSchema>;
export type UpdateAnnouncementRequest = z.infer<typeof UpdateAnnouncementRequestSchema>;
