import { randomInt } from 'node:crypto';

/** Uppercase letters and digits without the ambiguous 0/O and 1/I (spec 01, section 7.1). */
export const ACCESS_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ACCESS_CODE_LENGTH = 6;

/** Same rule as the `organizations_access_code_check` constraint of the database. */
export const ACCESS_CODE_PATTERN = /^[2-9A-HJ-NP-Z]{6}$/;

/**
 * Random establishment code for a new organization (`organizations.access_code`). Uniqueness is
 * enforced by the database: on a unique violation, generate another one and retry.
 */
export function generateAccessCode(): string {
  let code = '';
  for (let index = 0; index < ACCESS_CODE_LENGTH; index++) {
    code += ACCESS_CODE_ALPHABET.charAt(randomInt(ACCESS_CODE_ALPHABET.length));
  }
  return code;
}

/** Normalizes a code typed by the user (spaces, lowercase) before looking it up. */
export function normalizeAccessCode(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}
