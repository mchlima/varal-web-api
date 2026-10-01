import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { z } from 'zod';

import { AdminArea, AdminAuth } from '../../auth/auth.decorators.js';
import { IdParamSchema } from '../admin-schemas.js';
import { adminAccessOf, RequirePermission } from '../rbac/require-permission.js';
import {
  AnnouncementListQuerySchema,
  AnnouncementPageSchema,
  type AnnouncementResponse,
  AnnouncementSchema,
  CreateAnnouncementRequestSchema,
  PublishAnnouncementRequestSchema,
  UpdateAnnouncementRequestSchema,
} from './announcements.schemas.js';
import { AnnouncementsService } from './announcements.service.js';

/** Announcements (spec 02, sections 5 and 10). */
@ApiTags('admin-announcements')
@AdminArea()
@AdminAuth()
@Controller('admin/announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  @RequirePermission('announcements:read')
  @ApiOperation({ summary: 'Comunicados (mais novos primeiro), com contagem de leituras' })
  @ApiOkResponse({ standardSchema: AnnouncementPageSchema })
  list(
    @Query({ schema: AnnouncementListQuerySchema })
    query: z.infer<typeof AnnouncementListQuerySchema>,
  ): Promise<z.infer<typeof AnnouncementPageSchema>> {
    return this.announcements.list(query);
  }

  @Get(':id')
  @RequirePermission('announcements:read')
  @ApiOperation({ summary: 'Comunicado, com quantos donos do público já leram' })
  @ApiOkResponse({ standardSchema: AnnouncementSchema })
  get(@Param('id', { schema: IdParamSchema }) id: string): Promise<AnnouncementResponse> {
    return this.announcements.get(id);
  }

  @Post()
  @RequirePermission('announcements:manage')
  @ApiOperation({ summary: 'Cria um comunicado como rascunho (RN-02.13, RN-02.14)' })
  @ApiCreatedResponse({ standardSchema: AnnouncementSchema })
  create(
    @Req() request: Request,
    @Body({ schema: CreateAnnouncementRequestSchema })
    body: z.infer<typeof CreateAnnouncementRequestSchema>,
  ): Promise<AnnouncementResponse> {
    return this.announcements.create(adminAccessOf(request).adminId, body);
  }

  @Patch(':id')
  @RequirePermission('announcements:manage')
  @ApiOperation({ summary: 'Edita rascunho ou agendado (RN-02.15)' })
  @ApiOkResponse({ standardSchema: AnnouncementSchema })
  update(
    @Param('id', { schema: IdParamSchema }) id: string,
    @Body({ schema: UpdateAnnouncementRequestSchema })
    body: z.infer<typeof UpdateAnnouncementRequestSchema>,
  ): Promise<AnnouncementResponse> {
    return this.announcements.update(id, body);
  }

  @Post(':id/publish')
  @RequirePermission('announcements:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publica agora ou agenda para `publishAt` (RN-02.15)' })
  @ApiOkResponse({ standardSchema: AnnouncementSchema })
  publish(
    @Param('id', { schema: IdParamSchema }) id: string,
    @Body({ schema: PublishAnnouncementRequestSchema })
    body: z.infer<typeof PublishAnnouncementRequestSchema>,
  ): Promise<AnnouncementResponse> {
    return this.announcements.publish(
      id,
      body.publishAt === undefined ? undefined : new Date(body.publishAt),
    );
  }

  @Post(':id/archive')
  @RequirePermission('announcements:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Arquiva o comunicado: some da faixa dos donos (RN-02.15)' })
  @ApiOkResponse({ standardSchema: AnnouncementSchema })
  archive(@Param('id', { schema: IdParamSchema }) id: string): Promise<AnnouncementResponse> {
    return this.announcements.archive(id);
  }
}
