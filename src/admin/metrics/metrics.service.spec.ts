import { describe, expect, it } from 'vitest';

import { resolvePeriod, weekStarts } from './metrics.service.js';

describe('metrics period (spec 02, section 6)', () => {
  const today = Temporal.PlainDate.from('2026-10-01');

  it('defaults to the last 30 days, today included, in Brasília time', () => {
    const period = resolvePeriod({}, today);
    expect(period.from.toString()).toBe('2026-09-02');
    expect(period.to.toString()).toBe('2026-10-01');
    expect(period.start.toISOString()).toBe('2026-09-02T03:00:00.000Z');
    expect(period.end.toISOString()).toBe('2026-10-02T03:00:00.000Z');
  });

  it('refuses an inverted or too long period', () => {
    expect(() => resolvePeriod({ from: '2026-10-02', to: '2026-10-01' }, today)).toThrow();
    expect(() => resolvePeriod({ from: '2024-01-01', to: '2026-10-01' }, today)).toThrow();
  });

  it('buckets weeks by Monday', () => {
    const period = resolvePeriod({ from: '2026-09-30', to: '2026-10-06' }, today);
    expect(weekStarts(period).map(String)).toEqual(['2026-09-28', '2026-10-05']);
  });
});
