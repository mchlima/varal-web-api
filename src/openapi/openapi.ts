import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import type { z } from 'zod';

import { AUTH_COOKIES } from '../auth/auth-area.js';
import { ADMIN_SECURITY_SCHEME, PANEL_SECURITY_SCHEME } from '../auth/auth.decorators.js';
import { ErrorResponseSchema } from '../errors/error-response.schema.js';
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
 * `@nestjs/swagger` rewrites `examples: [x]` of route schemas as `example: x`; contract schemas keep
 * the JSON Schema form. Both describe the same schema, so they are compared in one form.
 */
function withSingleExample(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withSingleExample);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const entries = Object.entries(value).map(([key, item]): [string, unknown] =>
    key === 'examples' && Array.isArray(item)
      ? ['example', item[0]]
      : [key, withSingleExample(item)],
  );
  return Object.fromEntries(entries);
}

/**
 * Merges named zod schemas into `components.schemas` (RN-01.10). Fails on two different
 * definitions with the same name, so a contract is never silently replaced. A schema already
 * published by a route is kept as the route rendered it.
 */
export function mergeContractSchemas(
  document: OpenAPIObject,
  schemas: readonly z.ZodType[],
): OpenAPIObject {
  const components = (document.components ??= {});
  const target = (components.schemas ??= {}) as Record<string, unknown>;
  for (const schema of schemas) {
    for (const [id, definition] of Object.entries(toComponentSchemas(schema))) {
      if (id in target) {
        if (!isDeepStrictEqual(withSingleExample(target[id]), withSingleExample(definition))) {
          throw new Error(`OpenAPI schema "${id}" is defined twice with different shapes`);
        }
        continue;
      }
      target[id] = definition;
    }
  }
  return document;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/**
 * Every operation documents the error envelope of spec 01, section 5 as its `default` response,
 * so the apps get a typed `error` for any non-success status.
 */
export function addDefaultErrorResponses(document: OpenAPIObject): OpenAPIObject {
  for (const pathItem of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation && !('default' in operation.responses)) {
        operation.responses.default = {
          description: 'Erro no formato `ErrorResponse` (spec 01, seção 5).',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        };
      }
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
    // Session cookies (spec 01, section 7.2): one per context, never accepted by the other (CA-01.04).
    .addCookieAuth(
      AUTH_COOKIES.panel.access,
      {
        type: 'apiKey',
        in: 'cookie',
        description: 'Sessão do app dos clientes (dono e colaborador), definida pelo login.',
      },
      PANEL_SECURITY_SCHEME,
    )
    .addCookieAuth(
      AUTH_COOKIES.admin.access,
      {
        type: 'apiKey',
        in: 'cookie',
        description: 'Sessão do admin da plataforma, definida pelo login do admin.',
      },
      ADMIN_SECURITY_SCHEME,
    )
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    standardSchemaConverter: zodOpenApiConverter,
  });
  // ErrorResponse always ships: every operation references it (addDefaultErrorResponses).
  const schemas = [ErrorResponseSchema, ...extraSchemas];
  return sortKeysDeep(addDefaultErrorResponses(mergeContractSchemas(document, schemas)));
}

export function serializeOpenApiDocument(document: OpenAPIObject): string {
  return `${JSON.stringify(sortKeysDeep(document), null, 2)}\n`;
}
