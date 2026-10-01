import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { SUPER_ADMIN_KEY } from '../../src/admin/rbac/permissions.js';
import {
  type CliOutput,
  createPlatformAdminCommand,
  EXIT,
} from '../../src/cli/create-platform-admin.command.js';
import type { Env } from '../../src/config/env.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';

const databaseUrl = inject('databaseUrl');

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

describe.skipIf(!databaseUrl)('create-platform-admin and the roles of spec 02', () => {
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

  async function rolesOf(email: string): Promise<(string | null)[]> {
    const admin = await platform.platformAdmin.findUniqueOrThrow({
      where: { email },
      include: { roles: { include: { role: true } } },
    });
    return admin.roles.map((row) => row.role.systemKey);
  }

  it('the first admin (no active Super admin yet) gets Super admin (RN-02.05)', async () => {
    const active = await platform.platformAdmin.findMany({
      where: { active: true, roles: { some: { role: { systemKey: SUPER_ADMIN_KEY } } } },
      select: { id: true },
    });
    const ids = active.map((row) => row.id);
    await platform.platformAdmin.updateMany({
      where: { id: { in: ids } },
      data: { active: false },
    });
    try {
      const email = uniqueEmail('primeiro');
      const result = await run('--name', 'Primeiro Admin', '--email', email);
      expect(result.code).toBe(EXIT.ok);
      expect(result.out).toContain('Papel: Super admin.');
      await expect(rolesOf(email)).resolves.toEqual([SUPER_ADMIN_KEY]);
    } finally {
      await platform.platformAdmin.updateMany({
        where: { id: { in: ids } },
        data: { active: true },
      });
    }
  });

  it('later admins without --role get no role, to be given in the users screen', async () => {
    const email = uniqueEmail('depois');
    const result = await run('--name', 'Outro Admin', '--email', email);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain('Sem papel');
    await expect(rolesOf(email)).resolves.toEqual([]);
  });

  it('--role chooses the role by name, ignoring case', async () => {
    const email = uniqueEmail('suporte');
    const result = await run('--name', 'Admin Suporte', '--email', email, '--role', 'suporte');
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain('Papel: Suporte.');
    await expect(rolesOf(email)).resolves.toEqual(['support']);
    await expect(
      platform.auditLog.findFirst({
        where: {
          action: 'platform_admin.created',
          changes: { path: ['after', 'email'], equals: email },
        },
      }),
    ).resolves.toMatchObject({ changes: { after: { roles: ['Suporte'] } } });
  });

  it('an unknown --role creates nothing (exit code 1)', async () => {
    const email = uniqueEmail('desconhecido');
    const result = await run('--name', 'Fulano', '--email', email, '--role', 'Gerente');
    expect(result.code).toBe(EXIT.failed);
    expect(result.err).toContain('--role: Papel não encontrado.');
    await expect(platform.platformAdmin.count({ where: { email } })).resolves.toBe(0);
  });
});
