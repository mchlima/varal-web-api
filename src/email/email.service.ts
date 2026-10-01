import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { JobResult, JobWithMetadata } from 'pg-boss';

import { nowInSaoPaulo, TIME_ZONE, toDate, toSaoPaulo } from '../common/time.js';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PgBossService, type RawSqlTransaction } from '../jobs/pg-boss.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  EMAIL_CRITICALITY,
  EMAIL_MONTHLY_LIMIT,
  EMAIL_QUEUE,
  EMAIL_QUEUE_OPTIONS,
  EMAIL_WARNING_THRESHOLD,
  type EmailJobData,
  type EmailMessage,
  type EmailUsageLevel,
  usageLevel,
} from './email-types.js';
import { MailerService } from './mailer.service.js';
import { PayloadCipher } from './payload-crypto.js';
import { renderEmail } from './templates.js';

/** A transaction (tenant or platform) that can write `email_logs` and enqueue the job. */
export interface EmailTx extends RawSqlTransaction {
  emailLog: {
    create(args: {
      data: Prisma.EmailLogUncheckedCreateInput;
      select: { id: true };
    }): PromiseLike<{ id: string }>;
    count(args: { where: Prisma.EmailLogWhereInput }): PromiseLike<number>;
  };
}

export interface EmailUsage {
  /** `YYYY-MM`, calendar month in America/Sao_Paulo. */
  month: string;
  count: number;
  limit: number;
  warningThreshold: number;
  level: EmailUsageLevel;
}

export type EnqueueResult =
  | { queued: true; emailLogId: string }
  | { queued: false; emailLogId: string; reason: 'monthly_limit_reached' };

/**
 * Up to 10 e-mails per fetch, each settled on its own (a failure retries only that e-mail), and a
 * full batch fetches again at once instead of waiting for the next poll.
 */
const EMAIL_WORKER_OPTIONS = {
  batchSize: 10,
  includeMetadata: true,
  perJobResults: true,
  burstWhenBatchFull: true,
  pollingIntervalSeconds: 2,
} as const;

const LIMIT_REACHED_ERROR = 'Limite mensal de envios atingido (RN-01.04).';

/** First instant of a São Paulo month and of the next one. */
export function monthBounds(month: Temporal.PlainYearMonth): { start: Date; end: Date } {
  const startOf = (value: Temporal.PlainYearMonth) =>
    toDate(value.toPlainDate({ day: 1 }).toZonedDateTime({ timeZone: TIME_ZONE }));
  return { start: startOf(month), end: startOf(month.add({ months: 1 })) };
}

/**
 * E-mail (spec 01, section 9).
 *
 * - {@link enqueue} runs in the transaction of the action: it writes `email_logs` (`queued`) and the
 *   pg-boss job through that same transaction, so a rolled-back action sends nothing and a committed
 *   one always has its e-mail queued.
 * - A worker of the `email.send` queue renders the template, sends it over SMTP and marks the log
 *   `sent`, or `failed` after the last of 3 attempts.
 * - RN-01.04: the monthly usage (São Paulo calendar) drives the admin alert, and at 100% only
 *   critical types keep going.
 */
@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger('EmailService');
  private readonly cipher: PayloadCipher;

  constructor(
    @Inject(APP_ENV) private readonly env: Env,
    private readonly boss: PgBossService,
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
  ) {
    this.cipher = new PayloadCipher(env.EMAIL_PAYLOAD_SECRET);
  }

  onModuleInit(): void {
    this.boss.register({
      name: EMAIL_QUEUE,
      options: EMAIL_QUEUE_OPTIONS,
      work: (boss) =>
        boss.work<EmailJobData, unknown, typeof EMAIL_WORKER_OPTIONS>(
          EMAIL_QUEUE,
          EMAIL_WORKER_OPTIONS,
          async (jobs) => {
            const results: JobResult[] = [];
            for (const job of jobs) {
              try {
                await this.deliver(job);
                results.push({ id: job.id, status: 'completed' });
              } catch {
                // Logged by deliver; pg-boss retries it (spec 01, section 9).
                results.push({ id: job.id, status: 'failed' });
              }
            }
            return results;
          },
        ),
    });
  }

  /** Queues an e-mail in the transaction `tx` of the action that generates it. */
  async enqueue(
    tx: EmailTx,
    message: EmailMessage,
    organizationId: string | null,
    now = new Date(),
  ): Promise<EnqueueResult> {
    const count = await this.countInMonth(tx, toSaoPaulo(now).toPlainDate().toPlainYearMonth());
    if (usageLevel(count) === 'critical' && EMAIL_CRITICALITY[message.type] !== 'critical') {
      const log = await tx.emailLog.create({
        data: {
          organizationId,
          to: message.to,
          type: message.type,
          status: 'failed',
          error: LIMIT_REACHED_ERROR,
        },
        select: { id: true },
      });
      this.logger.warn(`${message.type} not sent: monthly limit reached (RN-01.04)`);
      return { queued: false, emailLogId: log.id, reason: 'monthly_limit_reached' };
    }

    const log = await tx.emailLog.create({
      data: { organizationId, to: message.to, type: message.type, status: 'queued' },
      select: { id: true },
    });
    const data: EmailJobData = { emailLogId: log.id, payload: this.cipher.encrypt(message) };
    await this.boss.sendInTransaction(tx, EMAIL_QUEUE, data);
    return { queued: true, emailLogId: log.id };
  }

  /** Usage of a São Paulo calendar month (default: the current one), for the admin (RN-01.04). */
  async usage(
    month: Temporal.PlainYearMonth = nowInSaoPaulo().toPlainDate().toPlainYearMonth(),
  ): Promise<EmailUsage> {
    const count = await this.countInMonth(this.prisma.client, month);
    return {
      month: month.toString(),
      count,
      limit: EMAIL_MONTHLY_LIMIT,
      warningThreshold: EMAIL_WARNING_THRESHOLD,
      level: usageLevel(count),
    };
  }

  /**
   * E-mails of the month that count against the plan: queued or sent. Failed ones (blocked by the
   * limit or refused by the SMTP after every attempt) are not counted.
   */
  private countInMonth(
    db: Pick<EmailTx, 'emailLog'>,
    month: Temporal.PlainYearMonth,
  ): PromiseLike<number> {
    const { start, end } = monthBounds(month);
    return db.emailLog.count({
      where: { createdAt: { gte: start, lt: end }, status: { in: ['queued', 'sent'] } },
    });
  }

  /** Worker of `email.send`. Throws to let pg-boss retry; the last failure marks the log `failed`. */
  async deliver(
    job: Pick<JobWithMetadata<EmailJobData>, 'data' | 'retryCount' | 'retryLimit'>,
  ): Promise<void> {
    const { emailLogId } = job.data;
    const db = this.prisma.client;
    const log = await db.emailLog.findUnique({
      where: { id: emailLogId },
      select: { status: true },
    });
    if (log?.status !== 'queued') {
      // Already sent (a retry after a crash) or removed: nothing to do.
      return;
    }
    try {
      const message = this.cipher.decrypt(job.data.payload) as EmailMessage;
      const rendered = renderEmail(message.type, message.variables, {
        supportContact: this.env.SUPPORT_CONTACT,
      });
      await this.mailer.send(message.to, rendered);
      await db.emailLog.update({
        where: { id: emailLogId },
        data: { status: 'sent', sentAt: new Date(), error: null },
      });
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
      const lastAttempt = job.retryCount >= job.retryLimit;
      await db.emailLog.update({
        where: { id: emailLogId },
        data: lastAttempt ? { status: 'failed', error: reason } : { error: reason },
      });
      this.logger.warn(`e-mail ${emailLogId} failed (attempt ${job.retryCount + 1}): ${reason}`);
      throw error;
    }
  }
}
