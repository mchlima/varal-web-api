import { isDeepStrictEqual } from 'node:util';

type Row = Record<string, unknown>;

export interface AuditChanges {
  /** Changed fields with their previous values; `null` when the entity was created. */
  before: Row | null;
  /** Changed fields with their new values; `null` when the entity was removed. */
  after: Row | null;
}

/** Bookkeeping fields that change on every write and say nothing about the action. */
const IGNORED_FIELDS = new Set(['createdAt', 'updatedAt']);

/** Secrets never reach the audit log; the entry only shows that they changed. */
const REDACTED_FIELDS = new Set(['passwordHash', 'tokenHash', 'refreshTokenHash']);
export const REDACTED = '[redacted]';

/** JSON-safe value: dates as ISO 8601, bigints as strings. */
function normalize(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function present(field: string, value: unknown): unknown {
  return REDACTED_FIELDS.has(field) && value !== null && value !== undefined
    ? REDACTED
    : normalize(value);
}

/**
 * Keeps only the fields that changed between `before` and `after` (spec 01, section 8).
 * Pass `before = null` for a creation and `after = null` for a removal.
 */
export function diffChanges(before: Row | null, after: Row | null): AuditChanges {
  const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changedBefore: Row = {};
  const changedAfter: Row = {};
  for (const field of fields) {
    if (IGNORED_FIELDS.has(field)) {
      continue;
    }
    const previous = normalize(before?.[field]);
    const next = normalize(after?.[field]);
    if (before !== null && after !== null && isDeepStrictEqual(previous, next)) {
      continue;
    }
    if (before !== null) {
      changedBefore[field] = present(field, before[field] ?? null);
    }
    if (after !== null) {
      changedAfter[field] = present(field, after[field] ?? null);
    }
  }
  return {
    before: before === null ? null : changedBefore,
    after: after === null ? null : changedAfter,
  };
}
