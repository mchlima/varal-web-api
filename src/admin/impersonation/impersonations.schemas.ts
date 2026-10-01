import { z } from 'zod';

import { PaginationQuerySchema, pageSchema } from '../../common/pagination.js';
import { QueryFlagSchema, reasonSchema } from '../admin-schemas.js';

export const ImpersonationEndedBySchema = z.enum(['admin', 'expired']).meta({
  id: 'ImpersonationEndedBy',
  description:
    'Como o "entrar como" terminou: pelo admin (ou "Encerrar acesso" no app). `expired` só aparece no histórico dos acessos antigos, do tempo em que havia limite de 60 minutos (RN-02.17).',
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
    reason: z.string().nullable().meta({
      description: 'Motivo, só nos acessos em que foi informado (opcional, RN-02.17).',
    }),
    startedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable().meta({
      deprecated: true,
      description:
        'Sempre `null`: o "entrar como" não tem prazo e dura até o admin encerrar (RN-02.17). Preenchido só nos acessos antigos, do tempo do limite de 60 minutos.',
    }),
    endedAt: z.iso
      .datetime()
      .nullable()
      .meta({ description: 'Fim do acesso; `null` enquanto está em andamento.' }),
    endedBy: ImpersonationEndedBySchema.nullable(),
    active: z.boolean(),
  })
  .meta({ id: 'Impersonation' });

export const ImpersonationPageSchema = pageSchema('ImpersonationPage', ImpersonationSchema);

export const StartImpersonationRequestSchema = z
  .object({
    organizationId: z.uuid(),
    reason: reasonSchema(10).optional().meta({
      description:
        'Opcional, aceito só por compatibilidade: o admin não informa mais motivo (RN-02.17). Se vier, precisa ter pelo menos 10 caracteres.',
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
