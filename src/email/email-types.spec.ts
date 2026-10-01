import { describe, expect, it } from 'vitest';

import { EmailType } from '../generated/prisma/enums.js';
import { EMAIL_CRITICALITY, EMAIL_QUEUE_OPTIONS, usageLevel } from './email-types.js';

describe('e-mail limits (RN-01.04)', () => {
  it.each([
    [0, 'ok'],
    [7_999, 'ok'],
    [8_000, 'warning'],
    [9_999, 'warning'],
    [10_000, 'critical'],
    [12_000, 'critical'],
  ])('%i e-mails in the month → %s', (count, level) => {
    expect(usageLevel(count)).toBe(level);
  });

  it('classifies every type; invites and resets are critical', () => {
    expect(Object.keys(EMAIL_CRITICALITY).sort()).toEqual(Object.values(EmailType).sort());
    expect(Object.values(EMAIL_CRITICALITY).every((value) => value === 'critical')).toBe(true);
  });

  it('tries 3 times with a growing wait (spec 01, section 9)', () => {
    expect(EMAIL_QUEUE_OPTIONS.retryLimit + 1).toBe(3);
    expect(EMAIL_QUEUE_OPTIONS.retryBackoff).toBe(true);
  });
});
