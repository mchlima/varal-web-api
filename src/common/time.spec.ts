import { describe, expect, it } from 'vitest';

import {
  nowInSaoPaulo,
  startOfDayInSaoPaulo,
  TIME_ZONE,
  toDate,
  toInstant,
  toSaoPaulo,
  todayInSaoPaulo,
} from './time.js';

describe('Temporal (plan 1.1)', () => {
  it('is available as a global in this Node version', () => {
    expect(typeof Temporal).toBe('object');
  });
});

describe('time helpers (America/Sao_Paulo ↔ UTC Date at the edges)', () => {
  it('uses the São Paulo time zone and the ISO calendar', () => {
    const now = nowInSaoPaulo();
    expect(now.timeZoneId).toBe(TIME_ZONE);
    expect(now.calendarId).toBe('iso8601');
    expect(todayInSaoPaulo().equals(now.toPlainDate())).toBe(true);
  });

  it('converts a UTC Date to the São Paulo clock (UTC-3) and back', () => {
    const date = new Date('2026-10-01T02:30:00.123Z');
    const local = toSaoPaulo(date);
    expect(local.toPlainDate().toString()).toBe('2026-09-30');
    expect(local.hour).toBe(23);
    expect(toDate(local).toISOString()).toBe(date.toISOString());
    expect(toDate(toInstant(date)).getTime()).toBe(date.getTime());
  });

  it('gives the first instant of a São Paulo day as a UTC Date', () => {
    expect(startOfDayInSaoPaulo(Temporal.PlainDate.from('2026-10-01')).toISOString()).toBe(
      '2026-10-01T03:00:00.000Z',
    );
  });
});
