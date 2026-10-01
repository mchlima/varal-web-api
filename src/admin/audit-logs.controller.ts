import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AdminArea, AdminAuth } from '../auth/auth.decorators.js';
import { PaginationQuerySchema, pageArgs, pageSchema, toPage } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ActorTypeSchema } from '../openapi/enum-schemas.js';
import { PlatformPrismaService } from '../prisma/platform-prisma.service.js';
import { InstantFilterSchema } from './admin-schemas.js';
import { RequirePermission } from './rbac/require-permission.js';

export const AuditLogEntrySchema = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid().nullable(),
    actorType: ActorTypeSchema,
    actorId: z.uuid().nullable(),
    impersonatorId: z.uuid().nullable().meta({
      description: 'Admin responsável, quando a ação foi feita num "entrar como" (RN-02.20).',
    }),
    impersonationId: z
      .uuid()
      .nullable()
      .meta({ description: 'Sessão de "entrar como" em que a ação foi feita (RN-02.20).' }),
    action: z.string().meta({ examples: ['organization.suspended'] }),
    entityType: z.string(),
    entityId: z.uuid().nullable(),
    changes: z
      .record(z.string(), z.unknown())
      .meta({ description: '`{ before, after, metadata? }`, só com os campos alterados.' }),
    deviceId: z.uuid().nullable(),
    ip: z.string().nullable(),
    requestId: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AuditLogEntry' });

export const AuditLogPageSchema = pageSchema('AuditLogPage', AuditLogEntrySchema);

export const AuditLogListQuerySchema = PaginationQuerySchema.extend({
  organizationId: z.uuid().optional(),
  actorType: ActorTypeSchema.optional(),
  actorId: z.uuid().optional(),
  impersonatorId: z.uuid().optional(),
  action: z.string().trim().max(100).optional().meta({
    description:
      'Ação exata (`organization.suspended`) ou prefixo terminado em ponto (`organization.`).',
  }),
  entityType: z.string().trim().max(60).optional(),
  entityId: z.uuid().optional(),
  from: InstantFilterSchema.meta({ description: 'A partir deste instante (inclusive).' }),
  to: InstantFilterSchema.meta({ description: 'Antes deste instante.' }),
});

/** Audit search (spec 02, section 8): newest first, with the changes of each entry. Read-only. */
@ApiTags('admin-audit')
@AdminArea()
@AdminAuth()
@Controller('admin/audit-logs')
export class AuditLogsController {
  constructor(private readonly platform: PlatformPrismaService) {}

  @Get()
  @RequirePermission('audit:read')
  @ApiOperation({
    summary: 'Auditoria com filtros por organização, ator, ação, entidade e período',
  })
  @ApiOkResponse({ standardSchema: AuditLogPageSchema })
  async list(
    @Query({ schema: AuditLogListQuerySchema }) query: z.infer<typeof AuditLogListQuerySchema>,
  ): Promise<z.infer<typeof AuditLogPageSchema>> {
    const args = pageArgs(query, 'desc');
    const action = query.action === '' ? undefined : query.action;
    const filters: Prisma.AuditLogWhereInput = {
      ...(query.organizationId === undefined ? {} : { organizationId: query.organizationId }),
      ...(query.actorType === undefined ? {} : { actorType: query.actorType }),
      ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
      ...(query.impersonatorId === undefined ? {} : { impersonatorId: query.impersonatorId }),
      ...(action === undefined
        ? {}
        : { action: action.endsWith('.') ? { startsWith: action } : action }),
      ...(query.entityType === undefined ? {} : { entityType: query.entityType }),
      ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
      ...(query.from === undefined && query.to === undefined
        ? {}
        : {
            createdAt: {
              ...(query.from === undefined ? {} : { gte: new Date(query.from) }),
              ...(query.to === undefined ? {} : { lt: new Date(query.to) }),
            },
          }),
    };
    const rows = await this.platform.auditLog.findMany({
      ...args,
      where: { AND: [filters, args.where] },
    });
    const page = toPage(rows, query.limit);
    return {
      data: page.data.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        actorType: row.actorType,
        actorId: row.actorId,
        impersonatorId: row.impersonatorId,
        impersonationId: row.impersonationId,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        changes: row.changes as Record<string, unknown>,
        deviceId: row.deviceId,
        ip: row.ip,
        requestId: row.requestId,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }
}
