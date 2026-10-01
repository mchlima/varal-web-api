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

export const envSchema = z.object({
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
});

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
