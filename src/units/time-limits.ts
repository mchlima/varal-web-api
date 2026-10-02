/*
 * Time limits of a `queue` station (spec 03, RN-03.25): "atenção" and "atraso", in minutes since the
 * order was sent. Pure rules, unit tested on their own.
 */

export const MAX_LATE_AFTER_MINUTES = 240;

export interface TimeLimits {
  attentionAfterMinutes: number;
  lateAfterMinutes: number;
}

/**
 * RN-03.25: a new station gets the default delay of the unit and the attention at half of it,
 * rounded down (CA-03.12: 15 → 7 and 15). The attention goes from 1 to the delay − 1, so the
 * smallest delay of a station is 2 (a unit default of 1 becomes 2).
 */
export function defaultTimeLimits(unitLateAfterMinutes: number): TimeLimits {
  const lateAfterMinutes = Math.min(MAX_LATE_AFTER_MINUTES, Math.max(2, unitLateAfterMinutes));
  return {
    attentionAfterMinutes: Math.max(1, Math.floor(lateAfterMinutes / 2)),
    lateAfterMinutes,
  };
}

/** RN-03.25: `1 ≤ atenção < atraso ≤ 240` (`INVALID_TIME_LIMITS` otherwise). */
export function validTimeLimits(limits: TimeLimits): boolean {
  return (
    Number.isInteger(limits.attentionAfterMinutes) &&
    Number.isInteger(limits.lateAfterMinutes) &&
    limits.attentionAfterMinutes >= 1 &&
    limits.attentionAfterMinutes < limits.lateAfterMinutes &&
    limits.lateAfterMinutes <= MAX_LATE_AFTER_MINUTES
  );
}
