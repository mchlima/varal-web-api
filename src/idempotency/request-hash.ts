import { createHash } from 'node:crypto';

/** JSON with object keys sorted recursively, so `{a,b}` and `{b,a}` hash the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, (item as Record<string, unknown>)[key]]),
      );
    }
    return item;
  });
}

/** Fingerprint of a request: the same `Idempotency-Key` with another fingerprint is a 409. */
export function hashRequest(method: string, url: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${url}\n${canonicalJson(body ?? null)}`)
    .digest('hex');
}
