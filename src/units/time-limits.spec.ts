import { describe, expect, it } from 'vitest';

import { defaultTimeLimits, validTimeLimits } from './time-limits.js';

describe('time limits of a station (RN-03.25)', () => {
  it('CA-03.12: a unit with 15 minutes gives attention at 7 and delay at 15', () => {
    expect(defaultTimeLimits(15)).toEqual({ attentionAfterMinutes: 7, lateAfterMinutes: 15 });
    expect(defaultTimeLimits(30)).toEqual({ attentionAfterMinutes: 15, lateAfterMinutes: 30 });
  });

  it('keeps room for the attention when the unit default is 1 minute', () => {
    expect(defaultTimeLimits(1)).toEqual({ attentionAfterMinutes: 1, lateAfterMinutes: 2 });
  });

  it('CA-03.12: refuses an attention greater than or equal to the delay', () => {
    expect(validTimeLimits({ attentionAfterMinutes: 7, lateAfterMinutes: 15 })).toBe(true);
    expect(validTimeLimits({ attentionAfterMinutes: 15, lateAfterMinutes: 15 })).toBe(false);
    expect(validTimeLimits({ attentionAfterMinutes: 16, lateAfterMinutes: 15 })).toBe(false);
    expect(validTimeLimits({ attentionAfterMinutes: 0, lateAfterMinutes: 15 })).toBe(false);
    expect(validTimeLimits({ attentionAfterMinutes: 10, lateAfterMinutes: 241 })).toBe(false);
  });
});
