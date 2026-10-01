import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';

import { AdminArea, AdminAuth } from '../auth/auth.decorators.js';
import { pageArgs, toPage } from '../common/pagination.js';
import { EmailService } from '../email/email.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PlatformPrismaService } from '../prisma/platform-prisma.service.js';
import {
  EmailLogListQuerySchema,
  EmailLogPageSchema,
  EmailUsageQuerySchema,
  EmailUsageSchema,
  type EmailUsageResponse,
} from './admin-emails.schemas.js';
import { RequirePermission } from './rbac/require-permission.js';

/** E-mail usage (RN-01.04; CA-01.09) and history (spec 02, section 8), with `emails:read`. */
@ApiTags('admin-emails')
@AdminArea()
@AdminAuth()
@RequirePermission('emails:read')
@Controller('admin/emails')
export class AdminEmailsController {
  constructor(
    private readonly email: EmailService,
    private readonly platform: PlatformPrismaService,
  ) {}

  @Get('usage')
  @ApiOperation({ summary: 'Consumo de e-mails do mês e nível do alerta (RN-01.04)' })
  @ApiOkResponse({ standardSchema: EmailUsageSchema })
  usage(
    @Query({ schema: EmailUsageQuerySchema }) query: z.infer<typeof EmailUsageQuerySchema>,
  ): Promise<EmailUsageResponse> {
    const month = query.month === undefined ? undefined : Temporal.PlainYearMonth.from(query.month);
    return this.email.usage(month);
  }

  @Get()
  @ApiOperation({
    summary: 'Histórico de e-mails (mais novos primeiro), com filtros e o erro das falhas',
  })
  @ApiOkResponse({ standardSchema: EmailLogPageSchema })
  async list(
    @Query({ schema: EmailLogListQuerySchema }) query: z.infer<typeof EmailLogListQuerySchema>,
  ): Promise<z.infer<typeof EmailLogPageSchema>> {
    const args = pageArgs(query, 'desc');
    const filters: Prisma.EmailLogWhereInput = {
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.organizationId === undefined ? {} : { organizationId: query.organizationId }),
      ...(query.from === undefined && query.to === undefined
        ? {}
        : {
            createdAt: {
              ...(query.from === undefined ? {} : { gte: new Date(query.from) }),
              ...(query.to === undefined ? {} : { lt: new Date(query.to) }),
            },
          }),
    };
    const rows = await this.platform.emailLog.findMany({
      ...args,
      where: { AND: [filters, args.where] },
    });
    const page = toPage(rows, query.limit);
    return {
      data: page.data.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        to: row.to,
        type: row.type,
        status: row.status,
        error: row.error,
        createdAt: row.createdAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  }
}
