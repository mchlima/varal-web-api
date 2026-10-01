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
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';

import { type Page, PaginationQuerySchema, type PaginationQuery } from '../common/pagination.js';
import { ErrorResponseSchema } from '../errors/error-response.schema.js';
import { Idempotent } from '../idempotency/idempotent.decorator.js';
import { accessQrSvg } from './access-qr.js';
import { IdPipe, NotFoundResponse, OwnerOnly } from '../units/unit-access.js';
import {
  CreateStaffMemberRequestSchema,
  type OrganizationAccess,
  OrganizationAccessSchema,
  PutStaffPermissionsRequestSchema,
  SetStaffPasswordRequestSchema,
  type StaffMemberDto,
  StaffMemberPageSchema,
  StaffMemberSchema,
  type StaffPasswordResetResponse,
  StaffPasswordResetRequestSchema,
  StaffPasswordResetResponseSchema,
  UpdateStaffMemberRequestSchema,
} from './staff.schemas.js';
import { StaffService } from './staff.service.js';

/** Staff members and team access (spec 03, section 6). Owner only. */
@ApiTags('staff')
@OwnerOnly()
@Controller()
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get('staff')
  @ApiOperation({ summary: 'Colaboradores da organização, com as permissões por unidade' })
  @ApiOkResponse({ standardSchema: StaffMemberPageSchema })
  list(
    @Query({ schema: PaginationQuerySchema }) query: PaginationQuery,
  ): Promise<Page<StaffMemberDto>> {
    return this.staff.list(query);
  }

  @Post('staff')
  @Idempotent()
  @ApiOperation({ summary: 'Cadastra um colaborador com senha inicial (RN-03.15)' })
  @ApiCreatedResponse({ standardSchema: StaffMemberSchema })
  @ApiBadRequestResponse({
    description: '`VALIDATION_FAILED` ou `INVALID_REFERENCE` (unidade ou estação inválida).',
    standardSchema: ErrorResponseSchema,
  })
  @ApiConflictResponse({
    description: '`USERNAME_TAKEN` (CA-03.07).',
    standardSchema: ErrorResponseSchema,
  })
  create(
    @Body({ schema: CreateStaffMemberRequestSchema })
    body: z.infer<typeof CreateStaffMemberRequestSchema>,
  ): Promise<StaffMemberDto> {
    return this.staff.create(body);
  }

  @Patch('staff/:id')
  @ApiOperation({
    summary: 'Altera nome, usuário, e-mail ou situação (desativar encerra as sessões, RN-03.17)',
  })
  @ApiOkResponse({ standardSchema: StaffMemberSchema })
  @NotFoundResponse()
  @ApiConflictResponse({
    description: '`USERNAME_TAKEN` (CA-03.07).',
    standardSchema: ErrorResponseSchema,
  })
  update(
    @Param('id', IdPipe) id: string,
    @Body({ schema: UpdateStaffMemberRequestSchema })
    body: z.infer<typeof UpdateStaffMemberRequestSchema>,
  ): Promise<StaffMemberDto> {
    return this.staff.update(id, body);
  }

  @Put('staff/:id/permissions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Substitui as permissões por unidade (estações e caixa, RN-03.16); vale na hora, inclusive no tempo real',
  })
  @ApiOkResponse({ standardSchema: StaffMemberSchema })
  @NotFoundResponse()
  @ApiBadRequestResponse({
    description:
      '`INVALID_REFERENCE`: unidade repetida, de fora da organização, ou estação que não é ativa daquela unidade.',
    standardSchema: ErrorResponseSchema,
  })
  setPermissions(
    @Param('id', IdPipe) id: string,
    @Body({ schema: PutStaffPermissionsRequestSchema })
    body: z.infer<typeof PutStaffPermissionsRequestSchema>,
  ): Promise<StaffMemberDto> {
    return this.staff.setPermissions(id, body.units);
  }

  @Post('staff/:id/password-reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Gera o link de redefinição de senha (RN-03.18): para copiar, enviar por WhatsApp e, opcionalmente, por e-mail',
  })
  @ApiOkResponse({ standardSchema: StaffPasswordResetResponseSchema })
  @NotFoundResponse()
  @ApiTooManyRequestsResponse({
    description: '`PASSWORD_RESET_LIMIT_REACHED`: 3 links na última hora (RN-01.02).',
    standardSchema: ErrorResponseSchema,
  })
  passwordReset(
    @Param('id', IdPipe) id: string,
    @Body({ schema: StaffPasswordResetRequestSchema })
    body: z.infer<typeof StaffPasswordResetRequestSchema>,
  ): Promise<StaffPasswordResetResponse> {
    return this.staff.issuePasswordReset(id, body);
  }

  @Put('staff/:id/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'O dono define a senha do colaborador (RN-03.19); as sessões dele são encerradas',
  })
  @ApiNoContentResponse({ description: 'Senha definida.' })
  @NotFoundResponse()
  setPassword(
    @Param('id', IdPipe) id: string,
    @Body({ schema: SetStaffPasswordRequestSchema })
    body: z.infer<typeof SetStaffPasswordRequestSchema>,
  ): Promise<void> {
    return this.staff.setPassword(id, body.password);
  }

  @Get('organization/access')
  @ApiOperation({ summary: 'Código do estabelecimento, link `/e/{code}` e QR code (SVG)' })
  @ApiOkResponse({ standardSchema: OrganizationAccessSchema })
  async access(): Promise<OrganizationAccess> {
    const { accessCode, link } = await this.staff.organizationAccess();
    return { accessCode, link, qrSvg: accessQrSvg(link) };
  }
}
