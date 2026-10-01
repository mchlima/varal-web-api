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

  describe('authentication and e-mail (phase 1b)', () => {
    const production = {
      ...valid,
      NODE_ENV: 'production',
      AUTH_PANEL_JWT_SECRET: 'p'.repeat(32),
      AUTH_ADMIN_JWT_SECRET: 'a'.repeat(32),
      EMAIL_PAYLOAD_SECRET: 'e'.repeat(32),
      SMTP_HOST: 'email-ssl.com.br',
      SMTP_PORT: '587',
      SMTP_USER: 'nao-responda@kratinho.com.br',
      SMTP_PASSWORD: 'segredo',
      PANEL_URL: 'https://varal.kratinho.com.br/',
      ADMIN_URL: 'https://admin-varal.kratinho.com.br',
    };

    it('defaults to Mailpit and the local fronts in development, with random secrets', () => {
      const env = parseEnv(valid);
      expect(env).toMatchObject({
        SMTP_HOST: 'localhost',
        SMTP_PORT: 1025,
        SMTP_SECURE: false,
        SMTP_FROM: 'Varal <nao-responda@kratinho.com.br>',
        PANEL_URL: 'http://localhost:3100',
        ADMIN_URL: 'http://localhost:3200',
      });
      expect(env.AUTH_PANEL_JWT_SECRET.length).toBeGreaterThanOrEqual(32);
      expect(env.AUTH_PANEL_JWT_SECRET).not.toBe(env.AUTH_ADMIN_JWT_SECRET);
    });

    it('accepts a complete production configuration and trims the trailing slash of URLs', () => {
      const env = parseEnv(production);
      expect(env.PANEL_URL).toBe('https://varal.kratinho.com.br');
      expect(env.SMTP_PORT).toBe(587);
    });

    it.each([
      'AUTH_PANEL_JWT_SECRET',
      'AUTH_ADMIN_JWT_SECRET',
      'EMAIL_PAYLOAD_SECRET',
      'SMTP_USER',
      'SMTP_PASSWORD',
    ])('requires %s in production', (key) => {
      expect(() => parseEnv({ ...production, [key]: undefined })).toThrow(new RegExp(key));
      expect(() => parseEnv({ ...production, [key]: '' })).toThrow(new RegExp(key));
    });

    it('requires https fronts in production', () => {
      expect(() => parseEnv({ ...production, PANEL_URL: 'http://varal.kratinho.com.br' })).toThrow(
        /PANEL_URL/,
      );
    });

    it('rejects short secrets and the same secret for both contexts (CA-01.04)', () => {
      expect(() => parseEnv({ ...valid, AUTH_PANEL_JWT_SECRET: 'curto' })).toThrow(
        /AUTH_PANEL_JWT_SECRET/,
      );
      expect(() =>
        parseEnv({
          ...valid,
          AUTH_PANEL_JWT_SECRET: 'x'.repeat(32),
          AUTH_ADMIN_JWT_SECRET: 'x'.repeat(32),
        }),
      ).toThrow(/AUTH_ADMIN_JWT_SECRET/);
    });
  });
});
