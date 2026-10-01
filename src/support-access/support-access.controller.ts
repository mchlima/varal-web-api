import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { PaginationQuerySchema, pageArgs, pageSchema, toPage } from '../common/pagination.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerOnly } from '../units/unit-access.js';

export const SupportAccessSchema = z
  .object({
    id: z.uuid(),
    adminName: z.string(),
    reason: z.string().nullable().meta({
      description: 'Motivo, só nos acessos em que foi informado (opcional, RN-02.22).',
    }),
    startedAt: z.iso.datetime(),
    endedAt: z.iso
      .datetime()
      .nullable()
      .meta({ description: 'Fim do acesso; `null` enquanto está em andamento.' }),
    endedBy: z.enum(['admin', 'expired']).nullable().meta({
      description:
        '`expired` só no histórico dos acessos antigos, do tempo do limite de 60 minutos (RN-02.17).',
    }),
    active: z.boolean(),
  })
  .meta({
    id: 'SupportAccess',
    description: 'Acesso de suporte ("entrar como") na conta (RN-02.22).',
  });

export const SupportAccessPageSchema = pageSchema('SupportAccessPage', SupportAccessSchema);

/**
 * `GET /support-access` (RN-02.22, CA-02.09): the "entrar como" made in the owner's organization,
 * newest first. `impersonation_sessions` is tenant data: the tenant client returns only the rows of
 * the session's organization.
 */
@ApiTags('support-access')
@OwnerOnly()
@Controller('support-access')
export class SupportAccessController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({
    summary: 'Acessos de suporte feitos na organização (admin, início e fim; motivo se houver)',
  })
  @ApiOkResponse({ standardSchema: SupportAccessPageSchema })
  async list(
    @Query({ schema: PaginationQuerySchema }) query: z.infer<typeof PaginationQuerySchema>,
  ): Promise<z.infer<typeof SupportAccessPageSchema>> {
    const args = pageArgs(query, 'desc');
    const rows = await this.prisma.db.impersonationSession.findMany({
      ...args,
      include: { platformAdmin: { select: { name: true } } },
    });
    const page = toPage(rows, query.limit);
    return {
      data: page.data.map((row) => ({
        id: row.id,
        adminName: row.platformAdmin.name,
        reason: row.reason,
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt?.toISOString() ?? null,
        endedBy: row.endedBy,
        active: row.endedAt === null,
      })),
      nextCursor: page.nextCursor,
    };
  }
}
