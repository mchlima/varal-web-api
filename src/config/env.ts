import { z } from 'zod';

const DEFAULT_PORT = 3000;

/**
 * One exact origin (scheme + host + optional port). Wildcards and paths are rejected,
 * because CORS with credentials must list exact origins only (RN-01.20).
 */
const originSchema = z.string().transform((value, ctx) => {
  const url = URL.parse(value);
  const isExactOrigin =
    url !== null &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    !value.includes('*') &&
    url.origin === value.replace(/\/$/, '');
  if (!isExactOrigin) {
    ctx.addIssue({
      code: 'custom',
      message: `"${value}" is not an exact origin (scheme://host[:port], no wildcard or path)`,
    });
    return z.NEVER;
  }
  return url.origin;
});

/** Minimum length of a signing or encryption secret (256 bits of base64/hex text or more). */
export const MIN_SECRET_LENGTH = 32;

const secretSchema = z
  .string()
  .min(MIN_SECRET_LENGTH, { message: `must have at least ${MIN_SECRET_LENGTH} characters` });

/** Treats `VAR=` (empty) like an unset variable, as .env files often leave optional keys empty. */
function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

const booleanSchema = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const baseUrlSchema = z
  .url({ protocol: /^https?$/ })
  .transform((value) => value.replace(/\/+$/, ''));

export const DEFAULT_SMTP_FROM = 'Varal <nao-responda@kratinho.com.br>';

const rawEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  CORS_ORIGINS: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    )
    .pipe(z.array(originSchema).min(1, { message: 'at least one origin is required' })),

  // Signing secrets of the access tokens, one per context (spec 01, section 7.2; CA-01.04).
  AUTH_PANEL_JWT_SECRET: optional(secretSchema),
  AUTH_ADMIN_JWT_SECRET: optional(secretSchema),
  // Encrypts the e-mail job payload (recipient and link with the password token) in the pg-boss table.
  EMAIL_PAYLOAD_SECRET: optional(secretSchema),

  // SMTP (spec 01, section 9). Development points to Mailpit (localhost:1025, no auth, no TLS).
  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_SECURE: optional(booleanSchema),
  SMTP_USER: optional(z.string().min(1)),
  SMTP_PASSWORD: optional(z.string().min(1)),
  SMTP_FROM: z.string().min(3).default(DEFAULT_SMTP_FROM),
  /** Where to ask for help, printed in the footer of every e-mail (RN-01.21). */
  SUPPORT_CONTACT: optional(z.string().min(3)),

  // Fronts that receive the links of the e-mails (invite and reset).
  PANEL_URL: baseUrlSchema.default('http://localhost:3100'),
  ADMIN_URL: baseUrlSchema.default('http://localhost:3200'),
});

/**
 * Secrets are optional outside production: a missing one gets a random value for the life of the
 * process (sessions do not survive a restart). `scripts/worktree.sh` writes fixed ones to `.env.local`.
 */
export const envSchema = rawEnvSchema
  .superRefine((env, ctx) => {
    if (
      env.AUTH_PANEL_JWT_SECRET !== undefined &&
      env.AUTH_PANEL_JWT_SECRET === env.AUTH_ADMIN_JWT_SECRET
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_ADMIN_JWT_SECRET'],
        message: 'must differ from AUTH_PANEL_JWT_SECRET (separate contexts, CA-01.04)',
      });
    }
    if (env.NODE_ENV !== 'production') {
      return;
    }
    const required = [
      'AUTH_PANEL_JWT_SECRET',
      'AUTH_ADMIN_JWT_SECRET',
      'EMAIL_PAYLOAD_SECRET',
      'SMTP_USER',
      'SMTP_PASSWORD',
    ] as const;
    for (const key of required) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'is required in production' });
      }
    }
    for (const key of ['PANEL_URL', 'ADMIN_URL'] as const) {
      if (!env[key].startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'must use https in production' });
      }
    }
  })
  .transform((env) => ({
    ...env,
    AUTH_PANEL_JWT_SECRET: env.AUTH_PANEL_JWT_SECRET ?? randomSecret(),
    AUTH_ADMIN_JWT_SECRET: env.AUTH_ADMIN_JWT_SECRET ?? randomSecret(),
    EMAIL_PAYLOAD_SECRET: env.EMAIL_PAYLOAD_SECRET ?? randomSecret(),
    SMTP_SECURE: env.SMTP_SECURE ?? false,
  }));

function randomSecret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

export type Env = z.infer<typeof envSchema>;

export class InvalidEnvError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'InvalidEnvError';
  }
}

/** Validates the environment; throws {@link InvalidEnvError} listing every problem. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new InvalidEnvError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}
