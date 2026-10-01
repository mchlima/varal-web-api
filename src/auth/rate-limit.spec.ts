import { describe, expect, it } from 'vitest';

import { RateLimiter } from './rate-limit.js';

describe('RateLimiter (in memory, per instance)', () => {
  const rule = { name: 'test', limit: 3, windowMs: 1_000 };

  it('allows the limit per window and client, then asks to wait', () => {
    const limiter = new RateLimiter();
    const now = 10_000;
    expect([1, 2, 3].map(() => limiter.hit(rule, 'ip-a', now))).toEqual([0, 0, 0]);
    expect(limiter.hit(rule, 'ip-a', now + 100)).toBe(1);
    expect(limiter.hit(rule, 'ip-b', now + 100)).toBe(0);
    expect(limiter.hit(rule, 'ip-a', now + 1_000)).toBe(0);
  });
});
