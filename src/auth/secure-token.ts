import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Random secret for links and refresh tokens: 32 bytes (spec 01, section 7.4), base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * SHA-256 of a high-entropy token, as stored in the database. A plain hash is enough (no salt, no
 * argon2): the token is random, so there is nothing to brute-force, and lookups stay indexable.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
