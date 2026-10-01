import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';

import { AdminArea, AdminAuth } from '../../auth/auth.decorators.js';
import { IdParamSchema } from '../admin-schemas.js';
import {
  CreateRoleRequestSchema,
  PermissionCatalogSchema,
  type RoleResponse,
  RoleListSchema,
  RoleSchema,
  UpdateRoleRequestSchema,
} from './rbac.schemas.js';
import { AnyAdmin, RequirePermission } from './require-permission.js';
import { RolesService } from './roles.service.js';

/** Permission catalog and roles (spec 02, sections 3 and 10). */
@ApiTags('admin-rbac')
@AdminArea()
@AdminAuth()
@Controller('admin')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  @AnyAdmin()
  @ApiOperation({ summary: 'Catálogo de permissões (RN-02.03)' })
  @ApiOkResponse({ standardSchema: PermissionCatalogSchema })
  permissions(): z.infer<typeof PermissionCatalogSchema> {
    return { data: this.roles.catalog() };
  }

  @Get('roles')
  @RequirePermission('admin.roles:manage', 'admin.users:manage')
  @ApiOperation({ summary: 'Papéis com as permissões de cada um' })
  @ApiOkResponse({ standardSchema: RoleListSchema })
  async list(): Promise<z.infer<typeof RoleListSchema>> {
    return { data: await this.roles.list() };
  }

  @Post('roles')
  @RequirePermission('admin.roles:manage')
  @ApiOperation({ summary: 'Cria um papel personalizado (RN-02.07)' })
  @ApiCreatedResponse({ standardSchema: RoleSchema })
  create(
    @Body({ schema: CreateRoleRequestSchema }) body: z.infer<typeof CreateRoleRequestSchema>,
  ): Promise<RoleResponse> {
    return this.roles.create(body);
  }

  @Patch('roles/:id')
  @RequirePermission('admin.roles:manage')
  @ApiOperation({
    summary: 'Edita um papel (Super admin não pode ser editado; RN-02.04)',
  })
  @ApiOkResponse({ standardSchema: RoleSchema })
  update(
    @Param('id', { schema: IdParamSchema }) id: string,
    @Body({ schema: UpdateRoleRequestSchema }) body: z.infer<typeof UpdateRoleRequestSchema>,
  ): Promise<RoleResponse> {
    return this.roles.update(id, body);
  }

  @Delete('roles/:id')
  @RequirePermission('admin.roles:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Exclui um papel personalizado sem usuários (RN-02.07)' })
  @ApiNoContentResponse({ description: 'Papel excluído.' })
  async remove(@Param('id', { schema: IdParamSchema }) id: string): Promise<void> {
    await this.roles.remove(id);
  }
}
