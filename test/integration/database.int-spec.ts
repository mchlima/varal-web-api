import { afterAll, describe, expect, inject, it } from 'vitest';

import type { Env } from '../../src/config/env.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

const databaseUrl = inject('databaseUrl');

describe.skipIf(!databaseUrl)('test database (RN-01.06)', () => {
  const prisma = new PrismaService({ DATABASE_URL: databaseUrl ?? '' } as Env);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('connects to the recreated worktree test database', async () => {
    const [row] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    expect(row?.db).toMatch(/_test$/);
  });
});
