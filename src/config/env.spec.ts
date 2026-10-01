import { describe, expect, it } from 'vitest';

import { InvalidEnvError, parseEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://varal:varal@localhost:5432/varal',
  CORS_ORIGINS: 'http://localhost:3100,http://localhost:3200',
};

describe('parseEnv', () => {
  it('applies defaults for PORT and NODE_ENV', () => {
    const env = parseEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces PORT from the string environment', () => {
    expect(parseEnv({ ...valid, PORT: '3007' }).PORT).toBe(3007);
  });

  it('splits CORS_ORIGINS into exact origins, trimming spaces and empty entries (RN-01.20)', () => {
    const env = parseEnv({
      ...valid,
      CORS_ORIGINS: ' https://varal.kratinho.com.br , https://admin-varal.kratinho.com.br/,',
    });
    expect(env.CORS_ORIGINS).toEqual([
      'https://varal.kratinho.com.br',
      'https://admin-varal.kratinho.com.br',
    ]);
  });

  it.each([
    ['wildcard', '*'],
    ['wildcard host', 'https://*.kratinho.com.br'],
    ['path', 'https://varal.kratinho.com.br/app'],
    ['not a URL', 'localhost:3100'],
    ['empty list', ' , '],
  ])('rejects CORS_ORIGINS with %s (RN-01.20)', (_case, CORS_ORIGINS) => {
    expect(() => parseEnv({ ...valid, CORS_ORIGINS })).toThrow(InvalidEnvError);
  });

  it('requires a PostgreSQL DATABASE_URL', () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => parseEnv({ ...valid, DATABASE_URL: 'mysql://localhost/varal' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects an invalid PORT or NODE_ENV and lists every problem', () => {
    try {
      parseEnv({ ...valid, PORT: 'abc', NODE_ENV: 'staging' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEnvError);
      const { issues } = error as InvalidEnvError;
      expect(issues.some((issue) => issue.startsWith('PORT'))).toBe(true);
      expect(issues.some((issue) => issue.startsWith('NODE_ENV'))).toBe(true);
    }
  });
});
