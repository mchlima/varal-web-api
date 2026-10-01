import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { OpenAPIObject } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { API_PREFIX } from '../../src/app.setup.js';
import { buildOpenApiDocument } from '../../src/openapi/openapi.js';
import { createTestApp } from '../support/test-app.js';

interface RouteArg {
  index: number;
  data?: unknown;
  schema?: unknown;
}

interface QueryRoute {
  route: string;
  /** Query fields the route accepts, or `null` when it reads the raw query without a schema. */
  fields: string[] | null;
}

function joinPath(...parts: unknown[]): string {
  const segments = parts
    .filter((part): part is string => typeof part === 'string')
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment.length > 0)
    .map((segment) => (segment.startsWith(':') ? `{${segment.slice(1)}}` : segment));
  return `/${segments.join('/')}`;
}

/** Fields of a zod query schema, as the request sees them (input shape). */
function queryFields(schema: unknown): string[] {
  if (!(schema instanceof z.ZodType)) {
    throw new Error('Query schemas must be zod schemas');
  }
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as {
    properties?: Record<string, unknown>;
  };
  return Object.keys(json.properties ?? {});
}

/** Every controller method that reads the query string, with the fields it accepts. */
function queryRoutes(app: NestExpressApplication): QueryRoute[] {
  const routes: QueryRoute[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (!controller) {
        continue;
      }
      const controllerPath: unknown = Reflect.getMetadata(PATH_METADATA, controller);
      const prototype = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name];
        if (name === 'constructor' || typeof handler !== 'function') {
          continue;
        }
        const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
        if (typeof method !== 'number') {
          continue;
        }
        const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ?? {}) as Record<
          string,
          RouteArg
        >;
        const queryArgs = Object.entries(args)
          .filter(([key]) => key.startsWith(`${RouteParamtypes.QUERY}:`))
          .map(([, arg]) => arg);
        if (queryArgs.length === 0) {
          continue;
        }
        const route = `${RequestMethod[method]} ${joinPath(API_PREFIX, controllerPath, Reflect.getMetadata(PATH_METADATA, handler))}`;
        const fields: string[] = [];
        let raw = false;
        for (const arg of queryArgs) {
          if (typeof arg.data === 'string') {
            fields.push(arg.data);
          } else if (arg.schema === undefined) {
            raw = true;
          } else {
            fields.push(...queryFields(arg.schema));
          }
        }
        routes.push({ route, fields: raw ? null : fields });
      }
    }
  }
  return routes;
}

function documentedQuery(document: OpenAPIObject, route: string): string[] {
  const [method = '', path = ''] = route.split(' ');
  const operation = document.paths[path]?.[method.toLowerCase() as 'get'];
  return (operation?.parameters ?? [])
    .filter((parameter) => 'in' in parameter && parameter.in === 'query')
    .map((parameter) => ('name' in parameter ? parameter.name : ''));
}

describe('query parameters in the OpenAPI document (RN-01.09; spec 01, section 5)', () => {
  let app: NestExpressApplication;
  let document: OpenAPIObject;
  let routes: QueryRoute[];

  beforeAll(async () => {
    app = await createTestApp();
    document = buildOpenApiDocument(app);
    routes = queryRoutes(app);
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('finds the routes that read the query string', () => {
    expect(routes.map(({ route }) => route)).toEqual(
      expect.arrayContaining([
        'GET /api/v1/units',
        'GET /api/v1/staff',
        'GET /api/v1/admin/emails/usage',
        'GET /api/v1/admin/organizations',
      ]),
    );
  });

  it('every query a route accepts is declared with a schema and published as a parameter', () => {
    const problems = routes.flatMap(({ route, fields }) => {
      if (fields === null) {
        return [`${route}: reads the query without a schema`];
      }
      const documented = documentedQuery(document, route);
      return fields
        .filter((field) => !documented.includes(field))
        .map((field) => `${route}: ?${field} missing from openapi.json`);
    });
    expect(problems).toEqual([]);
  });

  it('every paginated list publishes limit and cursor', () => {
    for (const path of ['/api/v1/units', '/api/v1/staff', '/api/v1/admin/organizations']) {
      expect(documentedQuery(document, `GET ${path}`)).toEqual(
        expect.arrayContaining(['limit', 'cursor']),
      );
    }
    expect(documentedQuery(document, 'GET /api/v1/admin/emails/usage')).toEqual(['month']);
  });
});
