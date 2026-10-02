/**
 * Dates of the domain with `Temporal` (global in Node 26, plan 1.1). Prisma, `pg` and zod keep
 * using `Date` (UTC instants); conversions happen at the edges with these helpers.
 * Only the ISO calendar is used.
 */

/** Time zone of every date shown to users and of the day of operation (spec 01, convenções). */
export const TIME_ZONE = 'America/Sao_Paulo';

/** Current instant. */
export function nowInstant(): Temporal.Instant {
  return Temporal.Now.instant();
}

/** Current date and time in São Paulo. */
export function nowInSaoPaulo(): Temporal.ZonedDateTime {
  return Temporal.Now.zonedDateTimeISO(TIME_ZONE);
}

/** Today's date in São Paulo (e.g. the day of operation of a register opened now, RN-04.29). */
export function todayInSaoPaulo(): Temporal.PlainDate {
  return nowInSaoPaulo().toPlainDate();
}

/** `Date` (from the database) → instant. */
export function toInstant(date: Date): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime());
}

/** Instant or zoned date-time → `Date` for the database (millisecond precision). */
export function toDate(value: Temporal.Instant | Temporal.ZonedDateTime): Date {
  return new Date(value.epochMilliseconds);
}

/** `Date` (UTC instant) → the same moment on the São Paulo clock. */
export function toSaoPaulo(date: Date): Temporal.ZonedDateTime {
  return toInstant(date).toZonedDateTimeISO(TIME_ZONE);
}

/** First instant of a São Paulo calendar day, as a `Date` (for `>=` filters in reports). */
export function startOfDayInSaoPaulo(day: Temporal.PlainDate): Date {
  return toDate(day.toZonedDateTime({ timeZone: TIME_ZONE }));
}

/**
 * A `date` column (day of operation, RN-04.29) → `Date` for Prisma. Prisma reads and writes `@db.Date`
 * as a `Date` at UTC midnight, so the day is kept as is, with no time zone shift.
 */
export function dateColumn(day: Temporal.PlainDate | string): Date {
  return new Date(`${day.toString()}T00:00:00.000Z`);
}

/** A `date` column read by Prisma (`Date` at UTC midnight) → the day it holds. */
export function plainDateOf(value: Date): Temporal.PlainDate {
  return Temporal.PlainDate.from(value.toISOString().slice(0, 10));
}

/** A `date` column as `AAAA-MM-DD` (contracts). */
export function isoDateOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}
