import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createTransport, type SMTPSentMessageInfo, type Transporter } from 'nodemailer';

import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import type { RenderedEmail } from './templates.js';

/**
 * SMTP sending with nodemailer (spec 01, section 9). Production: SMTP Locaweb with user and password
 * from the environment (never in the code) and STARTTLS required. Development: Mailpit on
 * localhost:1025, without authentication or TLS.
 */
@Injectable()
export class MailerService implements OnApplicationShutdown {
  private readonly transport: Transporter<SMTPSentMessageInfo>;
  private readonly from: string;

  constructor(@Inject(APP_ENV) env: Env) {
    const production = env.NODE_ENV === 'production';
    this.from = env.SMTP_FROM;
    this.transport = createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      // In production a plain connection must upgrade with STARTTLS; Mailpit offers no TLS.
      requireTLS: production && !env.SMTP_SECURE,
      ignoreTLS: !production && !env.SMTP_SECURE && env.SMTP_USER === undefined,
      ...(env.SMTP_USER !== undefined
        ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } }
        : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }

  async send(to: string, email: RenderedEmail): Promise<{ messageId: string }> {
    const info = await this.transport.sendMail({
      from: this.from,
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    return { messageId: info.messageId };
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }
}
