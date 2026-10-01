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
  type AdminUser,
  AdminPasswordLinkSchema,
  AdminUserListQuerySchema,
  AdminUserPageSchema,
  AdminUserSchema,
  CreateAdminUserRequestSchema,
  SetAdminUserPermissionsRequestSchema,
  SetAdminUserRolesRequestSchema,
  UpdateAdminUserRequestSchema,
} from './admin-users.schemas.js';
import { AdminUsersService } from './admin-users.service.js';

/** Users of the admin (spec 02, section 10). Every route needs `admin.users:manage`. */
@ApiTags('admin-users')
@AdminArea()
@AdminAuth()
@RequirePermission('admin.users:manage')
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @ApiOperation({ summary: 'Usuários do admin' })
  @ApiOkResponse({ standardSchema: AdminUserPageSchema })
  list(
    @Query({ schema: AdminUserListQuerySchema }) query: z.infer<typeof AdminUserListQuerySchema>,
  ): Promise<z.infer<typeof AdminUserPageSchema>> {
    return this.users.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Usuário do admin, com papéis e permissões efetivas' })
  @ApiOkResponse({ standardSchema: AdminUserSchema })
  get(@Param('id', { schema: IdParamSchema }) id: string): Promise<AdminUser> {
    return this.users.get(id);
  }

  @Post()
  @ApiOperation({ summary: 'Convida um usuário do admin (e-mail com link de 7 dias)' })
  @ApiCreatedResponse({ standardSchema: AdminUserSchema })
  invite(
    @Body({ schema: CreateAdminUserRequestSchema })
    body: z.infer<typeof CreateAdminUserRequestSchema>,
  ): Promise<AdminUser> {
    return this.users.invite(body);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edita nome e situação (desativar encerra as sessões; RN-02.05, RN-02.06)',
  })
  @ApiOkResponse({ standardSchema: AdminUserSchema })
  update(
    @Param('id', { schema: IdParamSchema }) id: string,
    @Body({ schema: UpdateAdminUserRequestSchema })
    body: z.infer<typeof UpdateAdminUserRequestSchema>,
  ): Promise<AdminUser> {
    return this.users.update(id, body);
  }

  @Put(':id/roles')
  @ApiOperation({ summary: 'Define os papéis do usuário (RN-02.05, RN-02.06)' })
  @ApiOkResponse({ standardSchema: AdminUserSchema })
  setRoles(
    @Param('id', { schema: IdParamSchema }) id: string,
    @Body({ schema: SetAdminUserRolesRequestSchema })
    body: z.infer<typeof SetAdminUserRolesRequestSchema>,
  ): Promise<AdminUser> {
    return this.users.setRoles(id, body.roleIds);
  }

  @Put(':id/permissions')
  @ApiOperation({ summary: 'Define as permissões avulsas do usuário (RN-02.02, RN-02.06)' })
  @ApiOkResponse({ standardSchema: AdminUserSchema })
  setPermissions(
    @Param('id', { schema: IdParamSchema }) id: string,
    @Body({ schema: SetAdminUserPermissionsRequestSchema })
    body: z.infer<typeof SetAdminUserPermissionsRequestSchema>,
  ): Promise<AdminUser> {
    return this.users.setPermissions(id, body.permissions);
  }

  @Post(':id/password-link')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Reenvia o convite (sem senha) ou envia um link de redefinição por e-mail (spec 01, seção 7.4)',
  })
  @ApiAcceptedResponse({ standardSchema: AdminPasswordLinkSchema })
  passwordLink(
    @Param('id', { schema: IdParamSchema }) id: string,
  ): Promise<z.infer<typeof AdminPasswordLinkSchema>> {
    return this.users.sendPasswordLink(id);
  }
}
