import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import { OwnerOnly } from '../units/unit-access.js';
import { OwnerAnnouncementsService } from './owner-announcements.service.js';

export const OwnerAnnouncementSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    body: z.string().meta({ description: 'Markdown simples (RN-02.13).' }),
    publishedAt: z.iso.datetime(),
  })
  .meta({ id: 'OwnerAnnouncement' });

export const OwnerAnnouncementListSchema = z
  .object({ data: z.array(OwnerAnnouncementSchema) })
  .meta({ id: 'OwnerAnnouncementList' });

const IdSchema = z.uuid();

/** Announcements banner of the owner's panel (RN-02.16; spec 02, section 10). */
@ApiTags('announcements')
@OwnerOnly()
@Controller('announcements')
export class OwnerAnnouncementsController {
  constructor(private readonly announcements: OwnerAnnouncementsService) {}

  @Get('unread')
  @ApiOperation({
    summary:
      'Comunicados publicados para a organização que o dono ainda não leu (mais novos primeiro)',
  })
  @ApiOkResponse({ standardSchema: OwnerAnnouncementListSchema })
  async unread(): Promise<z.infer<typeof OwnerAnnouncementListSchema>> {
    return { data: await this.announcements.unread() };
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Marca o comunicado como lido pelo dono (RN-02.16)',
    description:
      'Repetir não muda nada. Num "entrar como" a leitura não é registrada: o comunicado continua não lido para o dono.',
  })
  @ApiNoContentResponse({ description: 'Lido.' })
  async read(@Param('id') id: string): Promise<void> {
    // Another organization's announcement, or an unknown id, is the same 404 (CA-01.02).
    if (!IdSchema.safeParse(id).success) {
      throw AppError.of('NOT_FOUND');
    }
    await this.announcements.markRead(id);
  }
}
