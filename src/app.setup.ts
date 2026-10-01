import { StandardSchemaValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

import { APP_ENV } from './config/config.module.js';
import type { Env } from './config/env.js';
import { REQUEST_ID_HEADER } from './context/request-context.middleware.js';
import { configureZodLocale, validationError } from './errors/validation.js';

export const API_PREFIX = 'api/v1';

/**
 * RN-01.19: `X-Forwarded-For` is trusted only from the proxy. In production the NGINX container
 * reaches the API through a private Docker network, so only private and loopback addresses count
 * as proxies; a client cannot forge its IP by sending the header itself.
 */
export const TRUSTED_PROXIES = ['loopback', 'linklocal', 'uniquelocal'];

/**
 * Global HTTP setup shared by `main.ts`, the tests and the OpenAPI generator,
 * so all of them see the same routes and behaviour.
 */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  const env = app.get<Env>(APP_ENV);

  configureZodLocale();
  app.set('trust proxy', TRUSTED_PROXIES);
  app.setGlobalPrefix(API_PREFIX);
  app.use(cookieParser());
  // RN-01.20: credentials allowed only for the exact origins listed in CORS_ORIGINS, never `*`.
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    exposedHeaders: [REQUEST_ID_HEADER],
  });
  // Validates params declared with `schema` (zod 4 via Standard Schema); failures become
  // VALIDATION_FAILED with one entry per field (spec 01, section 5).
  app.useGlobalPipes(new StandardSchemaValidationPipe({ exceptionFactory: validationError }));
  app.enableShutdownHooks();

  return app;
}
