import { StandardSchemaValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

import { APP_ENV } from './config/config.module.js';
import type { Env } from './config/env.js';

export const API_PREFIX = 'api/v1';

/**
 * Global HTTP setup shared by `main.ts`, the e2e tests and the OpenAPI generator,
 * so all of them see the same routes and behaviour.
 */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  const env = app.get<Env>(APP_ENV);

  app.setGlobalPrefix(API_PREFIX);
  app.use(cookieParser());
  // RN-01.20: credentials allowed only for the exact origins listed in CORS_ORIGINS, never `*`.
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  // Validates params declared with `schema` (zod 4 via Standard Schema).
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.enableShutdownHooks();

  return app;
}
