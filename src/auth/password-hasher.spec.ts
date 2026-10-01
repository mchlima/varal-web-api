import { hash } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';

import {
  ARGON2_OPTIONS,
  hashPassword,
  NewPasswordSchema,
  needsRehash,
  verifyPassword,
} from './password-hasher.js';

describe('passwords (spec 01, section 7.3)', () => {
  it('hashes with argon2id m=19456, t=2, p=1 (plan 2.1)', async () => {
    const hashed = await hashPassword('varal12345');
    expect(hashed.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    await expect(verifyPassword(hashed, 'varal12345')).resolves.toBe(true);
    await expect(verifyPassword(hashed, 'varal12346')).resolves.toBe(false);
  });

  it('never authenticates without a hash, and still spends the argon2 time', async () => {
    const started = performance.now();
    await expect(verifyPassword(null, 'qualquer')).resolves.toBe(false);
    expect(performance.now() - started).toBeGreaterThan(1);
  });

  it('treats a malformed hash as a wrong password', async () => {
    await expect(verifyPassword('not-a-hash', 'x')).resolves.toBe(false);
  });

  it('asks for a rehash when the parameters changed', async () => {
    expect(needsRehash(await hashPassword('x'))).toBe(false);
    expect(needsRehash(await hash('x', { ...ARGON2_OPTIONS, timeCost: 3 }))).toBe(true);
    expect(needsRehash(await hash('x', { ...ARGON2_OPTIONS, memoryCost: 8192 }))).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
  });

  it('requires at least 8 characters and no other composition rule', () => {
    expect(NewPasswordSchema.safeParse('1234567').success).toBe(false);
    expect(NewPasswordSchema.safeParse('12345678').success).toBe(true);
    expect(NewPasswordSchema.safeParse('aaaaaaaa').success).toBe(true);
  });
});
