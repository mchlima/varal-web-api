import { setTimeout as sleep } from 'node:timers/promises';

import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { PASSWORD_TOKEN_TTL_MS } from '../../src/auth/password-token.service.js';
import {
  type CliOutput,
  createPlatformAdminCommand,
  EXIT,
} from '../../src/cli/create-platform-admin.command.js';
import type { Env } from '../../src/config/env.js';
import { EMAIL_QUEUE } from '../../src/email/email-types.js';
import { PgBossService } from '../../src/jobs/pg-boss.service.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { loginAdmin, TEST_PASSWORD } from '../support/auth-kit.js';
import { createTestApp } from '../support/test-app.js';

const databaseUrl = inject('databaseUrl');
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

/** Runs the command as `node dist/cli/create-platform-admin.js <args>` would, capturing the output. */
async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const output: CliOutput = { out: (line) => out.push(line), err: (line) => err.push(line) };
  const code = await createPlatformAdminCommand(args, output, { logger: false });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function uniqueEmail(prefix: string): string {
  return `${prefix}.${crypto.randomUUID()}@teste.local`;
}

describe.skipIf(!databaseUrl)('create-platform-admin command (first admin access)', () => {
  const platform = new PlatformPrismaService({ DATABASE_URL: databaseUrl ?? '' } as Env);

  beforeAll(() => {
    vi.stubEnv('DATABASE_URL', databaseUrl ?? '');
    vi.stubEnv('CORS_ORIGINS', 'http://localhost:3100');
    vi.stubEnv('NODE_ENV', 'test');
  });

  afterAll(async () => {
    await platform.$disconnect();
    vi.unstubAllEnvs();
  });

  it('creates an active admin without password and queues the 7-day invite in the same transaction', async () => {
    const email = uniqueEmail('Novo.Admin');
    const before = Date.now();
    const result = await run('--name', '  Admin Novo  ', '--email', email.toUpperCase());

    expect(result.code).toBe(EXIT.ok);
    const lower = email.toLowerCase();
    const admin = await platform.platformAdmin.findUniqueOrThrow({ where: { email: lower } });
    expect(admin).toMatchObject({ name: 'Admin Novo', active: true, passwordHash: null });

    const token = await platform.passwordToken.findFirstOrThrow({
      where: { subjectType: 'platform_admin', subjectId: admin.id, purpose: 'invite' },
    });
    expect(token.usedAt).toBeNull();
    expect(token.expiresAt.getTime()).toBeGreaterThanOrEqual(before + PASSWORD_TOKEN_TTL_MS.invite);
    expect(token.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + PASSWORD_TOKEN_TTL_MS.invite,
    );

    const log = await platform.emailLog.findFirstOrThrow({ where: { to: lower } });
    expect(log).toMatchObject({ type: 'admin_invite', status: 'queued', organizationId: null });
    const jobs = await platform.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM pgboss.job
      WHERE name = ${EMAIL_QUEUE} AND data->>'emailLogId' = ${log.id}`;
    expect(Number(jobs[0]?.count ?? 0)).toBe(1);

    // Never prints the token or the link.
    expect(result.out).toContain(`Convite enviado para ${lower}`);
    expect(`${result.out}\n${result.err}`).not.toMatch(/token|definir-senha|https?:\/\//i);
  });

  it('records the creation in the audit log with the system actor (spec 01, section 8)', async () => {
    const email = uniqueEmail('auditado');
    expect((await run('--name', 'Admin Auditado', '--email', email)).code).toBe(EXIT.ok);
    const admin = await platform.platformAdmin.findUniqueOrThrow({ where: { email } });

    const rows = await platform.auditLog.findMany({
      where: { entityType: 'platform_admin', entityId: admin.id },
      orderBy: { createdAt: 'asc' },
    });
    const created = rows.filter((row) => row.action === 'platform_admin.created');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      actorType: 'system',
      actorId: null,
      impersonatorId: null,
      organizationId: null,
      changes: {
        before: null,
        after: { name: 'Admin Auditado', email, active: true },
        metadata: { source: 'cli' },
      },
    });
    expect(created[0]?.requestId).toMatch(/^cli-/);
    // The invite of the same transaction, with the same request id.
    expect(rows.map((row) => row.action)).toContain('auth.password_link_issued');
    expect(new Set(rows.map((row) => row.requestId)).size).toBe(1);
  });

  it('refuses an e-mail that already has an admin (any case), with a non-zero exit code', async () => {
    const email = uniqueEmail('duplicado');
    expect((await run('--name', 'Primeiro', '--email', email)).code).toBe(EXIT.ok);

    const second = await run('--name', 'Segundo', '--email', email.toUpperCase());
    expect(second.code).toBe(EXIT.failed);
    expect(second.err).toContain('Já existe um admin da plataforma com este e-mail.');
    await expect(platform.platformAdmin.count({ where: { email } })).resolves.toBe(1);
    await expect(platform.emailLog.count({ where: { to: email } })).resolves.toBe(1);
    await expect(
      platform.auditLog.count({
        where: {
          action: 'platform_admin.created',
          changes: { path: ['after', 'email'], equals: email },
        },
      }),
    ).resolves.toBe(1);
  });

  it('rejects invalid or missing arguments before touching the database (exit code 2)', async () => {
    const adminsBefore = await platform.platformAdmin.count();
    for (const args of [
      ['--name', 'Sem Email'],
      ['--email', uniqueEmail('sem-nome')],
      ['--name', 'Fulano', '--email', 'nao-e-email'],
      ['--name', 'Fulano', '--email', uniqueEmail('x'), '--papel', 'super'],
    ]) {
      const result = await run(...args);
      expect(result.code, args.join(' ')).toBe(EXIT.usage);
      expect(result.err).toContain('Uso:');
    }
    await expect(platform.platformAdmin.count()).resolves.toBe(adminsBefore);
  });

  it('accepts the `--` that `pnpm admin:create -- ...` passes along, and --help', async () => {
    const email = uniqueEmail('pnpm');
    expect((await run('--', '--name', 'Via Pnpm', '--email', email)).code).toBe(EXIT.ok);
    const help = await run('--help');
    expect(help.code).toBe(EXIT.ok);
    expect(help.out).toContain('docker exec varal-api node dist/cli/create-platform-admin.js');
  });

  describe.skipIf(!mailpitUp)('end to end with Mailpit and the worker of the running API', () => {
    let app: NestExpressApplication;

    beforeAll(async () => {
      // Plays the running API: its pg-boss workers send what the command queued.
      app = await createTestApp({ auth: 'real', databaseUrl: databaseUrl ?? '' });
      await app.get(PgBossService).whenReady(15_000);
    });

    afterAll(async () => {
      await app.close();
    });

    it('the invite arrives and its link lets the new admin set the password and log in', async () => {
      const email = uniqueEmail('mailpit-admin');
      expect((await run('--name', 'Admin Mailpit', '--email', email)).code).toBe(EXIT.ok);

      const deadline = Date.now() + 20_000;
      let id: string | undefined;
      let subject = '';
      while (!id && Date.now() < deadline) {
        const response = await fetch(
          `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
        );
        const { messages } = (await response.json()) as {
          messages: { ID: string; Subject: string }[];
        };
        id = messages[0]?.ID;
        subject = messages[0]?.Subject ?? '';
        if (!id) {
          await sleep(500);
        }
      }
      expect(id, `no e-mail to ${email} in Mailpit`).toBeDefined();
      expect(subject).toBe('Convite para o admin do Varal');

      const { Text } = (await (
        await fetch(`${MAILPIT_URL}/api/v1/message/${id ?? ''}`)
      ).json()) as {
        Text: string;
      };
      const token = /\/definir-senha#token=([^&\s]+)&tipo=convite/.exec(Text)?.[1];
      expect(token).toBeDefined();

      await request(app.getHttpServer())
        .post('/api/v1/admin/auth/password/reset')
        .send({ token, password: TEST_PASSWORD })
        .expect(204);
      const login = await loginAdmin(app, email);
      expect(login.body).toBeDefined();
      await expect(
        platform.emailLog.findFirstOrThrow({ where: { to: email } }),
      ).resolves.toMatchObject({ status: 'sent' });
    });
  });
});
