import { z } from 'zod';

import { PaginationQuerySchema, pageSchema } from '../../common/pagination.js';
import { QueryFlagSchema, reasonSchema } from '../admin-schemas.js';

export const ImpersonationEndedBySchema = z.enum(['admin', 'expired']).meta({
  id: 'ImpersonationEndedBy',
  description:
    'Como o "entrar como" terminou: pelo admin (ou "Encerrar acesso" no app) ou por tempo.',
});

/** An "entrar como" session (spec 02, sections 7 and 9). */
export const ImpersonationSchema = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    organizationName: z.string(),
    platformAdminId: z.uuid(),
    adminName: z.string(),
    ownerId: z.uuid(),
    reason: z.string(),
    startedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    endedAt: z.iso
      .datetime()
      .nullable()
      .meta({ description: 'Fim real; num acesso que venceu, o horário do vencimento.' }),
    endedBy: ImpersonationEndedBySchema.nullable(),
    active: z.boolean(),
  })
  .meta({ id: 'Impersonation' });

export const ImpersonationPageSchema = pageSchema('ImpersonationPage', ImpersonationSchema);

export const StartImpersonationRequestSchema = z
  .object({
    organizationId: z.uuid(),
    reason: reasonSchema(10).meta({
      description: 'Motivo do acesso, pelo menos 10 caracteres (RN-02.17).',
    }),
  })
  .meta({ id: 'StartImpersonationRequest' });

export const StartedImpersonationSchema = z
  .object({
    impersonation: ImpersonationSchema,
    handoffUrl: z.url().meta({
      description:
        'Link de uso único do app dos clientes (`{PANEL_URL}/entrar-como#token=...`), válido por 2 minutos. O admin abre numa nova aba, no mesmo navegador em que está logado no admin.',
    }),
    handoffExpiresAt: z.iso.datetime(),
  })
  .meta({ id: 'StartedImpersonation' });

export const ImpersonationListQuerySchema = PaginationQuerySchema.extend({
  organizationId: z.uuid().optional(),
  active: QueryFlagSchema,
  mine: QueryFlagSchema.meta({ description: 'Só os acessos do admin logado.' }),
});

export type ImpersonationResponse = z.infer<typeof ImpersonationSchema>;
