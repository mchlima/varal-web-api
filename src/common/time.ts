/**
 * Dates of the domain with `Temporal` (global in Node 26, plan 1.1). Prisma, `pg` and zod keep
 * using `Date` (UTC instants); conversions happen at the edges with these helpers.
 * Only the ISO calendar is used.
 */

/** Time zone of every date shown to users and of the "day" of a shift (spec 01, convenções). */
export const TIME_ZONE = 'America/Sao_Paulo';

/** Current instant. */
export function nowInstant(): Temporal.Instant {
  return Temporal.Now.instant();
}

/** Current date and time in São Paulo. */
export function nowInSaoPaulo(): Temporal.ZonedDateTime {
  return Temporal.Now.zonedDateTimeISO(TIME_ZONE);
}

/** Today's date in São Paulo (e.g. the day of a shift). */
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
