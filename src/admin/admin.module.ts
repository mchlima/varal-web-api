import { Module } from '@nestjs/common';

import { AdminEmailsController } from './admin-emails.controller.js';

/** Platform admin (spec 02). Every route is under `/api/v1/admin` and needs the admin session. */
@Module({ controllers: [AdminEmailsController] })
export class AdminModule {}
