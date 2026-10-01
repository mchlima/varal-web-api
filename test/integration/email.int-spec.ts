import { setTimeout as sleep } from 'node:timers/promises';

import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { RateLimiter } from '../../src/auth/rate-limit.js';
import { DEFAULT_SMTP_FROM } from '../../src/config/env.js';
import { EMAIL_CRITICALITY, EMAIL_QUEUE, type EmailMessage } from '../../src/email/email-types.js';
import { EmailService, monthBounds } from '../../src/email/email.service.js';
import { PgBossService } from '../../src/jobs/pg-boss.service.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import {
  createPlatformAdmin,
  credentialsOf,
  loginAdmin,
  loginOwner,
  setPassword,
} from '../support/auth-kit.js';
import { createTenant } from '../support/isolation-kit.js';
import { createTestApp } from '../support/test-app.js';

const databaseUrl = inject('databaseUrl');
const API = '/api/v1';
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';

async function mailpitReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${MAILPIT_URL}/api/v1/info`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const mailpitUp = databaseUrl ? await mailpitReachable() : false;

function message(to: string, type: EmailMessage['type'] = 'owner_password_reset'): EmailMessage {
  return {
    type,
    to,
    variables: {
      recipientName: 'Fulano',
      organizationName: 'Barraca Teste',
      link: 'http://localhost:3100/definir-senha#token=abc&tipo=redefinicao',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  };
}

describe.skipIf(!databaseUrl)('e-mail (spec 01, section 9)', () => {
  let app: NestExpressApplication;
  let platform: PlatformPrismaService;
  let email: EmailService;

  beforeAll(async () => {
    app = await createTestApp({ auth: 'real', databaseUrl: databaseUrl ?? '' });
    platform = app.get(PlatformPrismaService);
    email = app.get(EmailService);
    await app.get(PgBossService).whenReady(15_000);
  });

  beforeEach(() => {
    app.get(RateLimiter).reset();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  async function jobsFor(emailLogId: string): Promise<number> {
    const rows = await platform.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM pgboss.job
      WHERE name = ${EMAIL_QUEUE} AND data->>'emailLogId' = ${emailLogId}`;
    return Number(rows[0]?.count ?? 0);
  }

  describe('queue in the transaction of the action (plan 2.1)', () => {
    it('a rolled-back action leaves neither the log nor the job', async () => {
      const to = `rollback.${crypto.randomUUID()}@teste.local`;
      let emailLogId = '';
      await expect(
        platform.$transaction(async (tx) => {
          const result = await email.enqueue(tx, message(to), null);
          emailLogId = result.emailLogId;
          throw new Error('action failed');
        }),
      ).rejects.toThrow('action failed');
      expect(emailLogId).not.toBe('');
      await expect(platform.emailLog.count({ where: { to } })).resolves.toBe(0);
      await expect(jobsFor(emailLogId)).resolves.toBe(0);
    });

    it('a committed action has its log (queued) and its job, with the payload encrypted', async () => {
      const to = `commit.${crypto.randomUUID()}@teste.local`;
      const result = await platform.$transaction((tx) => email.enqueue(tx, message(to), null));
      expect(result.queued).toBe(true);
      await expect(
        platform.emailLog.findUnique({ where: { id: result.emailLogId } }),
      ).resolves.toMatchObject({
        to,
        type: 'owner_password_reset',
      });
      await expect(jobsFor(result.emailLogId)).resolves.toBe(1);
      const [job] = await platform.$queryRaw<{ data: string }[]>`
        SELECT data::text AS data FROM pgboss.job WHERE data->>'emailLogId' = ${result.emailLogId}`;
      expect(job?.data).not.toContain(to);
      expect(job?.data).not.toContain('token=abc');
    });
  });

  describe('worker', () => {
    it('keeps the log queued with the error until the last attempt, then marks it failed', async () => {
      const log = await platform.emailLog.create({
        data: { to: 'falha@teste.local', type: 'owner_invite', status: 'queued' },
      });
      const job = { data: { emailLogId: log.id, payload: 'v1.corrompido' }, retryLimit: 2 };
      await expect(email.deliver({ ...job, retryCount: 0 })).rejects.toThrow();
      await expect(platform.emailLog.findUnique({ where: { id: log.id } })).resolves.toMatchObject({
        status: 'queued',
        error: expect.any(String) as string,
      });
      await expect(email.deliver({ ...job, retryCount: 2 })).rejects.toThrow();
      await expect(platform.emailLog.findUnique({ where: { id: log.id } })).resolves.toMatchObject({
        status: 'failed',
      });
    });

    it('does nothing for a log that is no longer queued (retry after a crash)', async () => {
      const log = await platform.emailLog.create({
        data: { to: 'ja@teste.local', type: 'owner_invite', status: 'sent', sentAt: new Date() },
      });
      await expect(
        email.deliver({
          data: { emailLogId: log.id, payload: 'v1.x' },
          retryCount: 0,
          retryLimit: 2,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('monthly limit (RN-01.04)', () => {
    // A past month only these tests write to (São Paulo calendar).
    const month = Temporal.PlainYearMonth.from('2020-03');
    const { start } = monthBounds(month);
    const inMonth = new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000);

    async function addLogs(count: number, status: 'sent' | 'failed' = 'sent'): Promise<void> {
      const rows = Array.from({ length: count }, () => ({
        to: 'volume@teste.local',
        type: 'owner_invite' as const,
        status,
        createdAt: inMonth,
      }));
      for (let i = 0; i < rows.length; i += 2_500) {
        await platform.emailLog.createMany({ data: rows.slice(i, i + 2_500) });
      }
    }

    it('counts by São Paulo month: midnight UTC of the 1st is still the previous month there', () => {
      expect(start.toISOString()).toBe('2020-03-01T03:00:00.000Z');
    });

    it('CA-01.09: from 8,000 e-mails in the month the admin sees the warning, from 10,000 the critical alert', async () => {
      const admin = await createPlatformAdmin(platform);
      const { jar } = await loginAdmin(app, admin.email);
      const usage = async () =>
        (
          await request(app.getHttpServer())
            .get(`${API}/admin/emails/usage?month=2020-03`)
            .set('Cookie', jar.header())
            .expect(200)
        ).body as { count: number; level: string };

      await addLogs(7_999);
      await addLogs(500, 'failed'); // failures do not count
      await expect(usage()).resolves.toMatchObject({ count: 7_999, level: 'ok' });
      await addLogs(1);
      await expect(usage()).resolves.toMatchObject({ count: 8_000, level: 'warning' });
      await addLogs(2_000);
      await expect(usage()).resolves.toMatchObject({ count: 10_000, level: 'critical' });
    });

    it('at 100% only critical types keep going (invites and resets)', async () => {
      // 10,000 already in 2020-03 (previous test). Every MVP type is critical; simulate one that is not.
      const original = EMAIL_CRITICALITY.owner_invite;
      EMAIL_CRITICALITY.owner_invite = 'non_critical';
      try {
        const blocked = await platform.$transaction((tx) =>
          email.enqueue(tx, message('bloqueado@teste.local', 'owner_invite'), null, inMonth),
        );
        expect(blocked).toMatchObject({ queued: false, reason: 'monthly_limit_reached' });
        await expect(
          platform.emailLog.findUnique({ where: { id: blocked.emailLogId } }),
        ).resolves.toMatchObject({
          status: 'failed',
          error: expect.stringContaining('RN-01.04') as string,
        });
        await expect(jobsFor(blocked.emailLogId)).resolves.toBe(0);

        const critical = await platform.$transaction((tx) =>
          email.enqueue(tx, message('critico@teste.local', 'owner_password_reset'), null, inMonth),
        );
        expect(critical.queued).toBe(true);
      } finally {
        EMAIL_CRITICALITY.owner_invite = original;
      }
    });
  });

  describe.skipIf(!mailpitUp)('end to end with Mailpit', () => {
    interface MailpitSummary {
      ID: string;
      Subject: string;
      From: { Address: string; Name: string };
    }

    async function waitForMessage(to: string, timeoutMs = 20_000): Promise<MailpitSummary> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const response = await fetch(
          `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
        );
        const { messages } = (await response.json()) as { messages: MailpitSummary[] };
        if (messages[0]) {
          return messages[0];
        }
        await sleep(500);
      }
      throw new Error(`no e-mail to ${to} in Mailpit after ${timeoutMs} ms`);
    }

    it('"Esqueci a senha" e-mails a working, single-use link (RN-01.03, RN-01.21)', async () => {
      const tenant = await createTenant(platform, 'Mailpit');
      await setPassword(platform, { owner: tenant.ownerId });
      const { email: to } = await credentialsOf(platform, tenant);

      await request(app.getHttpServer())
        .post(`${API}/auth/password/forgot`)
        .send({ email: to })
        .expect(202);

      const summary = await waitForMessage(to);
      expect(summary.Subject).toBe('Redefinição de senha do Varal');
      expect(`${summary.From.Name} <${summary.From.Address}>`).toBe(DEFAULT_SMTP_FROM);
      const full = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${summary.ID}`)).json()) as {
        Text: string;
        HTML: string;
      };
      expect(full.Text).toContain('Não responda');
      expect(full.HTML).toContain('#BE185D');
      const link =
        /http:\/\/localhost:3100\/definir-senha#token=([A-Za-z0-9_-]{43})&tipo=redefinicao/.exec(
          full.Text,
        );
      expect(link).not.toBeNull();
      const token = link?.[1] ?? '';

      await request(app.getHttpServer())
        .post(`${API}/auth/password/reset`)
        .send({ token, password: 'senha-do-email-1' })
        .expect(204);
      await loginOwner(app, to, 'senha-do-email-1');
      await request(app.getHttpServer())
        .post(`${API}/auth/password/reset`)
        .send({ token, password: 'senha-do-email-2' })
        .expect(400);

      const log = await platform.emailLog.findFirstOrThrow({
        where: { to, type: 'owner_password_reset' },
      });
      expect(log.status).toBe('sent');
      expect(log.sentAt).not.toBeNull();
    }, 60_000);
  });
});
