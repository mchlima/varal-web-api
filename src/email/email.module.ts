import { Global, Module } from '@nestjs/common';

import { EmailService } from './email.service.js';
import { MailerService } from './mailer.service.js';

@Global()
@Module({
  providers: [EmailService, MailerService],
  exports: [EmailService],
})
export class EmailModule {}
