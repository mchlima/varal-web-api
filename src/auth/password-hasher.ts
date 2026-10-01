import { type Algorithm, hash, parseOptions, verify } from '@node-rs/argon2';
import { z } from 'zod';

/** `Algorithm.Argon2id`: a const enum, which `isolatedModules` cannot read, so the value is spelled out. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- see above
const ARGON2ID = 2 as Algorithm;

/**
 * argon2id with the OWASP minimum (plan 2.1; spec 01, section 7.3). Changing these values makes
 * every login with an older hash rehash the password ({@link needsRehash}).
 */
export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Spec 01, section 7.3: at least 8 characters, no other composition rule. */
export const PASSWORD_MIN_LENGTH = 8;
/** Upper bound only to keep hashing cheap for absurd inputs. */
export const PASSWORD_MAX_LENGTH = 128;

export const NewPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, {
    message: `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`,
  })
  .max(PASSWORD_MAX_LENGTH, {
    message: `A senha pode ter no máximo ${PASSWORD_MAX_LENGTH} caracteres.`,
  })
  .meta({
    description: `Nova senha: de ${PASSWORD_MIN_LENGTH} a ${PASSWORD_MAX_LENGTH} caracteres.`,
  });

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** Hash of a random password, used to spend the same time when the user does not exist. */
let dummyHash: Promise<string> | undefined;

/**
 * Checks a password. With `hashed` null (unknown user, or no password defined yet) it still runs a
 * full verification against a dummy hash, so the response time does not reveal whether the user
 * exists (spec 01, section 7.3).
 */
export async function verifyPassword(hashed: string | null, password: string): Promise<boolean> {
  if (hashed === null) {
    dummyHash ??= hashPassword(crypto.randomUUID());
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  try {
    return await verify(hashed, password);
  } catch {
    // Malformed hash in the database: never authenticates.
    return false;
  }
}

/** True when `hashed` was made with other parameters than {@link ARGON2_OPTIONS} (rehash on login). */
export function needsRehash(hashed: string): boolean {
  try {
    const options = parseOptions(hashed);
    return (
      options.algorithm !== ARGON2_OPTIONS.algorithm ||
      options.memoryCost !== ARGON2_OPTIONS.memoryCost ||
      options.timeCost !== ARGON2_OPTIONS.timeCost ||
      options.parallelism !== ARGON2_OPTIONS.parallelism
    );
  } catch {
    return true;
  }
}
