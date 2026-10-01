import { describe, expect, it } from 'vitest';

import { DB_POOL_MAX } from './platform-prisma.service.js';

describe('database pool (plan 2.1, RN-01.16)', () => {
  it('uses at most 7 connections in the API (pg-boss gets 3 of the 10 of Varal)', () => {
    expect(DB_POOL_MAX).toBe(7);
  });
});
