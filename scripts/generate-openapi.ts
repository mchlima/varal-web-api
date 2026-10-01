/**
 * Writes `openapi.json` at the repository root (RN-01.09) without starting the HTTP server
 * and without connecting to the database. Run with `pnpm openapi`.
 */
import 'reflect-metadata';

import { writeFileSync } from 'node:fs';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { buildOpenApiDocument, serializeOpenApiDocument } from '../src/openapi/openapi.js';

// The document does not depend on these values; placeholders let it run anywhere (CI, no .env).
process.env.DATABASE_URL = 'postgresql://openapi:openapi@127.0.0.1:1/openapi';
process.env.CORS_ORIGINS = 'http://localhost';

const output = new URL('../openapi.json', import.meta.url);

const app = configureApp(
  await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn'],
    abortOnError: false,
  }),
);
try {
  writeFileSync(output, serializeOpenApiDocument(buildOpenApiDocument(app)));
  console.log(`OpenAPI written to ${output.pathname}`);
} finally {
  await app.close();
}
