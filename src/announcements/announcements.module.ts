import { Module } from '@nestjs/common';

import { OwnerAnnouncementsController } from './owner-announcements.controller.js';
import { OwnerAnnouncementsService } from './owner-announcements.service.js';

/** Announcements banner of the owner's panel (spec 02, section 5). The admin side is in src/admin. */
@Module({ controllers: [OwnerAnnouncementsController], providers: [OwnerAnnouncementsService] })
export class AnnouncementsModule {}
