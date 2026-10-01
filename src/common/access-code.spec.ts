import { describe, expect, it } from 'vitest';

import {
  ACCESS_CODE_ALPHABET,
  ACCESS_CODE_PATTERN,
  generateAccessCode,
  normalizeAccessCode,
} from './access-code.js';

describe('access code (spec 01, section 7.1)', () => {
  it('has no ambiguous characters (0/O, 1/I)', () => {
    for (const ambiguous of ['0', 'O', '1', 'I']) {
      expect(ACCESS_CODE_ALPHABET).not.toContain(ambiguous);
    }
  });

  it('generates 6 uppercase alphanumerics matching the database constraint', () => {
    const codes = Array.from({ length: 500 }, generateAccessCode);
    for (const code of codes) {
      expect(code).toMatch(ACCESS_CODE_PATTERN);
    }
    expect(new Set(codes).size).toBeGreaterThan(490);
  });

  it('normalizes what the user typed', () => {
    expect(normalizeAccessCode(' ab c2d3 ')).toBe('ABC2D3');
  });
});
