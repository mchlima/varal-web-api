import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { z } from 'zod';

import { AdminArea, AdminAuth } from '../../auth/auth.decorators.js';
import { IdParamSchema } from '../admin-schemas.js';
import { adminAccessOf, AnyAdmin, RequirePermission } from '../rbac/require-permission.js';
import {
  ImpersonationListQuerySchema,
  ImpersonationPageSchema,
  type ImpersonationResponse,
  ImpersonationSchema,
  StartedImpersonationSchema,
  StartImpersonationRequestSchema,
} from './impersonations.schemas.js';
import { ImpersonationsService } from './impersonations.service.js';

/** "Entrar como" (spec 02, sections 7 and 10). */
@ApiTags('admin-impersonations')
@AdminArea()
@AdminAuth()
@Controller('admin/impersonations')
export class ImpersonationsController {
  constructor(private readonly impersonations: ImpersonationsService) {}

  @Post()
  @RequirePermission('impersonation:use')
  @ApiOperation({
    summary:
      'Abre um "entrar como" (sem prazo, até o admin encerrar) e devolve o link de uso único do app (RN-02.17)',
  })
  @ApiCreatedResponse({ standardSchema: StartedImpersonationSchema })
  start(
    @Req() request: Request,
    @Body({ schema: StartImpersonationRequestSchema })
    body: z.infer<typeof StartImpersonationRequestSchema>,
  ): Promise<z.infer<typeof StartedImpersonationSchema>> {
    return this.impersonations.start(adminAccessOf(request).adminId, body);
  }

  @Get()
  @RequirePermission('impersonation:use')
  @ApiOperation({ summary: 'Acessos de "entrar como" (mais novos primeiro)' })
  @ApiOkResponse({ standardSchema: ImpersonationPageSchema })
  list(
    @Req() request: Request,
    @Query({ schema: ImpersonationListQuerySchema })
    query: z.infer<typeof ImpersonationListQuerySchema>,
  ): Promise<z.infer<typeof ImpersonationPageSchema>> {
    return this.impersonations.list(adminAccessOf(request).adminId, query);
  }

  @Post(':id/end')
  @AnyAdmin()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Encerra o "entrar como" (só o próprio admin da sessão); a sessão do app cai na hora',
  })
  @ApiOkResponse({ standardSchema: ImpersonationSchema })
  end(
    @Req() request: Request,
    @Param('id', { schema: IdParamSchema }) id: string,
  ): Promise<ImpersonationResponse> {
    return this.impersonations.end(adminAccessOf(request).adminId, id);
  }
}
