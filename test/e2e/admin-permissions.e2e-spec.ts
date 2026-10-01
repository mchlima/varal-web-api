import type { NestExpressApplication } from '@nestjs/platform-express';
import type { OpenAPIObject } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PERMISSIONS_EXTENSION } from '../../src/admin/rbac/require-permission.js';
import { PERMISSIONS } from '../../src/admin/rbac/permissions.js';
import { buildOpenApiDocument } from '../../src/openapi/openapi.js';
import { createTestApp } from '../support/test-app.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

/** Admin operations of the document, with their `x-permissions`. */
function adminOperations(document: OpenAPIObject) {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const operation = item[method] as
        (Record<string, unknown> & { responses: object }) | undefined;
      return operation && path.startsWith('/api/v1/admin/')
        ? [{ method, path, operation, permissions: operation[PERMISSIONS_EXTENSION] }]
        : [];
    }),
  );
}

describe('RBAC on every admin route (RN-02.01)', () => {
  let app: NestExpressApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    app = await createTestApp();
    document = buildOpenApiDocument(app);
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('every route under /api/v1/admin (except the admin login and session) declares its permission', () => {
    const operations = adminOperations(document);
    expect(operations.length).toBeGreaterThan(30);
    const missing = operations
      .filter(({ path }) => !path.startsWith('/api/v1/admin/auth/'))
      .filter(({ permissions }) => !Array.isArray(permissions))
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`);
    expect(missing).toEqual([]);
  });

  it('declares only permissions of the catalog, and documents the 403', () => {
    for (const { permissions, operation } of adminOperations(document)) {
      if (!Array.isArray(permissions)) {
        continue;
      }
      for (const permission of permissions) {
        expect(PERMISSIONS).toContain(permission);
      }
      expect(Object.keys(operation.responses)).toContain('403');
    }
  });

  it('publishes the catalog as the Permission enum (RN-02.03)', () => {
    expect(document.components?.schemas?.Permission).toMatchObject({ enum: [...PERMISSIONS] });
  });

  it('keeps the permissions of spec 02, section 10 on the existing routes', () => {
    const byRoute = Object.fromEntries(
      adminOperations(document).map(({ method, path, permissions }) => [
        `${method.toUpperCase()} ${path}`,
        permissions,
      ]),
    );
    expect(byRoute).toMatchObject({
      'GET /api/v1/admin/emails/usage': ['emails:read'],
      'GET /api/v1/admin/emails': ['emails:read'],
      'GET /api/v1/admin/audit-logs': ['audit:read'],
      'GET /api/v1/admin/users': ['admin.users:manage'],
      'GET /api/v1/admin/roles': ['admin.roles:manage', 'admin.users:manage'],
      'GET /api/v1/admin/permissions': [],
      'POST /api/v1/admin/organizations': ['organizations:create'],
      'POST /api/v1/admin/organizations/{id}/suspend': ['organizations:suspend'],
      'PUT /api/v1/admin/organizations/{id}/subscription-status': ['subscriptions:update'],
      'POST /api/v1/admin/impersonations': ['impersonation:use'],
      'POST /api/v1/admin/impersonations/{id}/end': [],
      'GET /api/v1/admin/metrics/overview': ['metrics:read'],
    });
  });
});
