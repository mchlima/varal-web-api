import { describe, expect, it } from 'vitest';

import { digitsOf, isValidCpf, isValidPhone } from './credit-rules.js';

describe('credit rules (spec 06)', () => {
  it('RN-06.01: phone with DDD, 10 or 11 digits, mobile starting with 9', () => {
    expect(isValidPhone(digitsOf('(11) 98765-4321'))).toBe(true);
    expect(isValidPhone('1133334444')).toBe(true);
    expect(isValidPhone('11887654321')).toBe(false);
    expect(isValidPhone('0198765432')).toBe(false);
    expect(isValidPhone('987654321')).toBe(false);
    expect(isValidPhone('119876543210')).toBe(false);
  });

  it('RN-06.01: CPF validated by its check digits', () => {
    expect(isValidCpf(digitsOf('529.982.247-25'))).toBe(true);
    expect(isValidCpf('11144477735')).toBe(true);
    expect(isValidCpf('52998224724')).toBe(false);
    expect(isValidCpf('11111111111')).toBe(false);
    expect(isValidCpf('1234567890')).toBe(false);
  });
});
