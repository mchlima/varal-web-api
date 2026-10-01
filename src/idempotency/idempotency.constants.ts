export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
/** Set on responses replayed from a stored idempotent response. */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/** Stored responses are kept for 24 h (spec 01, section 5). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Longest time a write may hold its transaction while an idempotency key is claimed. */
export const IDEMPOTENT_TRANSACTION_TIMEOUT_MS = 15_000;

/**
 * An in-progress claim older than this is treated as abandoned (process crash) and can be taken
 * over by a retry of the same request. It is longer than the transaction timeout, and the action
 * and the stored response commit together, so a stale claim never hides a committed action.
 */
export const IDEMPOTENCY_LOCK_TIMEOUT_MS = 60_000;
