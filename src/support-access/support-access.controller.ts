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
    reason: z.string(),
    startedAt: z.iso.datetime(),
    endedAt: z.iso
      .datetime()
      .nullable()
      .meta({ description: 'Fim do acesso; `null` enquanto está em andamento.' }),
    endedBy: z.enum(['admin', 'expired']).nullable(),
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
    summary: 'Acessos de suporte feitos na organização (admin, motivo, início e fim)',
  })
  @ApiOkResponse({ standardSchema: SupportAccessPageSchema })
  async list(
    @Query({ schema: PaginationQuerySchema }) query: z.infer<typeof PaginationQuerySchema>,
  ): Promise<z.infer<typeof SupportAccessPageSchema>> {
    const now = new Date();
    const args = pageArgs(query, 'desc');
    const rows = await this.prisma.db.impersonationSession.findMany({
      ...args,
      include: { platformAdmin: { select: { name: true } } },
    });
    const page = toPage(rows, query.limit);
    return {
      data: page.data.map((row) => {
        const expired = row.endedAt === null && row.expiresAt <= now;
        return {
          id: row.id,
          adminName: row.platformAdmin.name,
          reason: row.reason,
          startedAt: row.startedAt.toISOString(),
          endedAt: (row.endedAt ?? (expired ? row.expiresAt : null))?.toISOString() ?? null,
          endedBy: row.endedBy ?? (expired ? 'expired' : null),
          active: row.endedAt === null && !expired,
        };
      }),
      nextCursor: page.nextCursor,
    };
  }
}
