import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import type { z } from 'zod';

import { contractSchemas } from './contract-schemas.js';
import { toComponentSchemas, zodOpenApiConverter } from './zod-openapi.converter.js';

export const OPENAPI_VERSION = '3.1.0';

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

/**
 * Merges named zod schemas into `components.schemas` (RN-01.10). Fails on two different
 * definitions with the same name, so a contract is never silently replaced.
 */
export function mergeContractSchemas(
  document: OpenAPIObject,
  schemas: readonly z.ZodType[],
): OpenAPIObject {
  const components = (document.components ??= {});
  const target = (components.schemas ??= {}) as Record<string, unknown>;
  for (const schema of schemas) {
    for (const [id, definition] of Object.entries(toComponentSchemas(schema))) {
      if (id in target && !isDeepStrictEqual(target[id], definition)) {
        throw new Error(`OpenAPI schema "${id}" is defined twice with different shapes`);
      }
      target[id] = definition;
    }
  }
  return document;
}

/** Recursively sorts object keys so the generated file is deterministic. Arrays keep their order. */
export function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => sortKeysDeep(item)) as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
    ) as T;
  }
  return value;
}

/** Builds the OpenAPI 3.1 document of an app already configured with `configureApp`. */
export function buildOpenApiDocument(
  app: INestApplication,
  extraSchemas: readonly z.ZodType[] = contractSchemas,
): OpenAPIObject {
  const config = new DocumentBuilder()
    .setOpenAPIVersion(OPENAPI_VERSION)
    .setTitle('Varal API')
    .setDescription(
      'REST API do Varal (`/api/v1`). Contrato consumido pelos apps (spec 01, seção 3.1).',
    )
    // Kept in sync with package.json; release-please bumps both (release-please-config.json).
    .setVersion(packageVersion())
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    standardSchemaConverter: zodOpenApiConverter,
  });
  return sortKeysDeep(mergeContractSchemas(document, extraSchemas));
}

export function serializeOpenApiDocument(document: OpenAPIObject): string {
  return `${JSON.stringify(sortKeysDeep(document), null, 2)}\n`;
}
