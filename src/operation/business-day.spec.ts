import { describe, expect, it } from 'vitest';

import { businessDateOnOpen, isStaleTab, nextTabNumber } from './business-day.js';

const day = (value: string) => Temporal.PlainDate.from(value);

describe('day of operation (RN-04.29)', () => {
  it('the first register ever starts the day of today', () => {
    expect(businessDateOnOpen(null, day('2026-10-01'), false)).toEqual({
      businessDate: day('2026-10-01'),
      newDay: true,
    });
  });

  it('CA-04.16: a fair opened at 18h on 01/10 keeps 01/10 after midnight while a register is open', () => {
    const result = businessDateOnOpen(day('2026-10-01'), day('2026-10-02'), true);
    expect(result.businessDate.toString()).toBe('2026-10-01');
    expect(result.newDay).toBe(false);
  });

  it('CA-04.16: the register opened at 17h on 02/10, with none open, starts 02/10 and the numbering', () => {
    const result = businessDateOnOpen(day('2026-10-01'), day('2026-10-02'), false);
    expect(result.businessDate.toString()).toBe('2026-10-02');
    expect(result.newDay).toBe(true);
  });

  it('closing and reopening on the same day keeps the day (lunch and dinner)', () => {
    expect(businessDateOnOpen(day('2026-10-02'), day('2026-10-02'), false).newDay).toBe(false);
  });
});

describe('tab numbers (RN-04.09)', () => {
  it('CA-04.02: skips the numbers of tabs of earlier days that are still open', () => {
    expect(nextTabNumber(1, new Set([3]))).toBe(1);
    expect(nextTabNumber(3, new Set([3]))).toBe(4);
    expect(nextTabNumber(3, new Set([3, 4, 6]))).toBe(5);
  });
});

describe('tabs open for more than 2 days (RN-01.28)', () => {
  it('CA-01.19: on 05/10, a tab of 02/10 is stale and one of 03/10 is not', () => {
    expect(isStaleTab(day('2026-10-02'), day('2026-10-05'))).toBe(true);
    expect(isStaleTab(day('2026-10-03'), day('2026-10-05'))).toBe(false);
  });
});
