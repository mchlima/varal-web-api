import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AdminArea, AdminAuth } from '../auth/auth.decorators.js';
import { EmailService } from '../email/email.service.js';
import { EmailUsageSchema, type EmailUsageResponse } from './admin-emails.schemas.js';

const EmailUsageQuerySchema = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Use o formato AAAA-MM.' })
      .optional()
      .meta({ description: 'Mês em `America/Sao_Paulo` (AAAA-MM). Padrão: o mês atual.' }),
  })
  .meta({ id: 'EmailUsageQuery' });

/**
 * E-mail usage of the month for the admin panel (RN-01.04; CA-01.09). Spec 02 protects it with the
 * `emails:read` permission; until RBAC arrives (phase 3) any logged-in platform admin can read it.
 */
@ApiTags('admin-emails')
@AdminArea()
@AdminAuth()
@Controller('admin/emails')
export class AdminEmailsController {
  constructor(private readonly email: EmailService) {}

  @Get('usage')
  @ApiOperation({ summary: 'Consumo de e-mails do mês e nível do alerta (RN-01.04)' })
  @ApiOkResponse({ standardSchema: EmailUsageSchema })
  usage(
    @Query({ schema: EmailUsageQuerySchema }) query: z.infer<typeof EmailUsageQuerySchema>,
  ): Promise<EmailUsageResponse> {
    const month = query.month === undefined ? undefined : Temporal.PlainYearMonth.from(query.month);
    return this.email.usage(month);
  }
}
