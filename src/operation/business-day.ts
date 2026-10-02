/*
 * Day of operation and tab numbers (spec 04, section 3.1 and RN-04.09). Pure rules, unit tested on
 * their own.
 */

/**
 * RN-04.29 (CA-04.16): the day of operation when a cash register opens. It changes only when no
 * other register of the unit is open and today differs from the current day; then the numbering of
 * the tabs starts again at 1. A fair that goes past midnight keeps its day until the last register
 * closes, and closing and reopening on the same day keeps the day and the numbering.
 */
export function businessDateOnOpen(
  current: Temporal.PlainDate | null,
  today: Temporal.PlainDate,
  anotherRegisterOpen: boolean,
): { businessDate: Temporal.PlainDate; newDay: boolean } {
  if (current !== null && (anotherRegisterOpen || current.equals(today))) {
    return { businessDate: current, newDay: false };
  }
  return { businessDate: today, newDay: true };
}

/**
 * RN-04.09 (CA-04.02): the next tab number from `next`, skipping the numbers of tabs of earlier days
 * that are still open, so a number never repeats among the open tabs of the unit.
 */
export function nextTabNumber(next: number, openNumbers: ReadonlySet<number>): number {
  let number = Math.max(1, next);
  while (openNumbers.has(number)) {
    number += 1;
  }
  return number;
}

/**
 * RN-01.28 (CA-01.19): a tab is "aberta há mais de 2 dias" when its day of operation is before the
 * current day minus 2 (on 05/10, the tabs opened on 02/10 or before).
 */
export function isStaleTab(tabDay: Temporal.PlainDate, current: Temporal.PlainDate): boolean {
  return Temporal.PlainDate.compare(tabDay, current.subtract({ days: 2 })) < 0;
}
