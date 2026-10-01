import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';

import { AdminArea, AdminAuth } from '../../auth/auth.decorators.js';
import { IdParamSchema } from '../admin-schemas.js';
import { RequirePermission } from '../rbac/require-permission.js';
import {
  CreateOrganizationRequestSchema,
  type OrganizationDetail,
  OrganizationDetailSchema,
  OrganizationListQuerySchema,
  OrganizationPageSchema,
  OwnerInviteResponseSchema,
  ReactivateOrganizationRequestSchema,
  SubscriptionStatusChangeRequestSchema,
  SuspendOrganizationRequestSchema,
  UpdateOrganizationRequestSchema,
} from './organizations.schemas.js';
import { OrganizationsService } from './organizations.service.js';

/** Organizations and subscription situation (spec 02, sections 4 and 10). */
@ApiTags('admin-organizations')
@AdminArea()
@AdminAuth()
@Controller('admin/organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  @RequirePermission('organizations:read')
  @ApiOperation({ summary: 'Organizações, com busca e filtro por situação (mais novas primeiro)' })
  @ApiOkResponse({ standardSchema: OrganizationPageSchema })
  list(
    @Query({ schema: OrganizationListQuerySchema })
    query: z.infer<typeof OrganizationListQuerySchema>,
  ): Promise<z.infer<typeof OrganizationPageSchema>> {
    return this.organizations.list(query);
  }

  @Get(':id')
  @RequirePermission('organizations:read')
  @ApiOperation({ summary: 'Detalhe da organização (spec 02, seção 4)' })
  @ApiOkResponse({ standardSchema: OrganizationDetailSchema })
  get(@Param('id', { schema: IdParamSchema }) id: string): Promise<OrganizationDetail> {
    return this.organizations.get(id);
  }

  @Post()
  @RequirePermission('organizations:create')
  @ApiOperation({
    summary:
      'Cria a organização com a primeira unidade, o dono e o convite por e-mail (RN-02.09, RN-02.10)',
  })
  @ApiCreatedResponse({ standardSchema: OrganizationDetailSchema })
  create(
    @Body({ schema: CreateOrganizationRequestSchema })
    body: z.infer<typeof CreateOrganizationRequestSchema>,
  ): Promise<OrganizationDetail> {
    return this.organizations.create(body);
  }

  @Patch(':id')
  @RequirePermission('organizations:update')
  @ApiOperation({ summary: 'Edita o nome da organização e o nome ou e-mail do dono' })
  @ApiOkResponse({ standardSchema: OrganizationDetailSchema })
  update(
    @Param('id', { schema: IdParamSchema }) id: string,
    @Body({ schema: UpdateOrganizationRequestSchema })
    body: z.infer<typeof UpdateOrganizationRequestSchema>,
  ): Promise<OrganizationDetail> {
    return this.organizations.update(id, body);
  }

  @Post(':id/owner-invite')
  @RequirePermission('organizations:update')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Reenvia o convite do dono (o link anterior deixa de valer)' })
  @ApiAcceptedResponse({ standardSchema: OwnerInviteResponseSchema })
  resendOwnerInvite(
    @Param('id', { schema: IdParamSchema }) id: string,
  ): Promise<z.infer<typeof OwnerInviteResponseSchema>> {
    return this.organizations.resendOwnerInvite(id);
  }

  @Post(':id/suspend')
  @RequirePermission('organizations:suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspende a organização, com motivo (RN-02.11, RN-02.12)' })
  @ApiOkResponse({ standardSchema: OrganizationDetailSchema })
  suspend(
    @Param('id', { schema: IdParamSchema }) id: string,
    @Body({ schema: SuspendOrganizationRequestSchema })
    body: z.infer<typeof SuspendOrganizationRequestSchema>,
  ): Promise<OrganizationDetail> {
    return this.organizations.suspend(id, body.reason);
  }

  @Post(':id/reactivate')
  @RequirePermission('organizations:suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reativa a organização para `active` ou `pilot` (RN-02.12)' })
  @ApiOkResponse({ standardSchema: OrganizationDetailSchema })
  reactivate(
    @Param('id', { schema: IdParamSchema }) id: string,
    @Body({ schema: ReactivateOrganizationRequestSchema })
    body: z.infer<typeof ReactivateOrganizationRequestSchema>,
  ): Promise<OrganizationDetail> {
    return this.organizations.reactivate(id, body.status, body.reason);
  }

  @Put(':id/subscription-status')
  @RequirePermission('subscriptions:update')
  @ApiOperation({ summary: 'Muda a situação da assinatura, com motivo (RN-02.11)' })
  @ApiOkResponse({ standardSchema: OrganizationDetailSchema })
  setSubscriptionStatus(
    @Param('id', { schema: IdParamSchema }) id: string,
    @Body({ schema: SubscriptionStatusChangeRequestSchema })
    body: z.infer<typeof SubscriptionStatusChangeRequestSchema>,
  ): Promise<OrganizationDetail> {
    return this.organizations.setSubscriptionStatus(id, body.status, body.reason);
  }
}
