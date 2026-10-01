import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service.js';
import { HealthService } from './health.service.js';

function serviceWith(queryRaw: () => Promise<unknown>): HealthService {
  return new HealthService({ db: { $queryRaw: vi.fn(queryRaw) } } as unknown as PrismaService);
}

describe('HealthService', () => {
  it('reports db ok when the database answers', async () => {
    await expect(serviceWith(() => Promise.resolve([{ '?column?': 1 }])).check()).resolves.toEqual({
      status: 'ok',
      db: 'ok',
    });
  });

  it('reports db unavailable instead of failing when the database is down', async () => {
    await expect(
      serviceWith(() => Promise.reject(new Error('ECONNREFUSED'))).check(),
    ).resolves.toEqual({ status: 'ok', db: 'unavailable' });
  });
});
