import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES } from '../../src/errors/error-codes.js';
import { ErrorResponseSchema } from '../../src/errors/error-response.schema.js';
import { errorOf } from '../support/http.js';
import { authHeaders } from '../support/stub-auth.js';
import { createTestApp } from '../support/test-app.js';
import { InfrastructureTestModule } from '../support/test-routes.js';

const ORG = '01922f2c-7a3b-7c00-8000-00000000000a';
const STAFF = '01922f2c-7a3b-7c00-8000-0000000000aa';
const ADMIN = '01922f2c-7a3b-7c00-8000-0000000000ff';

describe('error format (spec 01, section 5)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp({ imports: [InfrastructureTestModule] });
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('sends module errors as { error: { code, message, details } }', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/test/errors/app').expect(409);
    expect(response.body).toEqual({
      error: {
        code: 'TAB_ALREADY_CLOSED',
        message: 'Esta comanda já foi fechada.',
        details: { tabId: 'x' },
      },
    });
  });

  it.each([
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [429, 'RATE_LIMITED'],
  ] as const)('standardizes %i as %s with the pt-BR message', async (status, code) => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/test/errors/http/${status}`)
      .expect(status);
    expect(response.body).toEqual({
      error: { code, message: ERROR_CODES[code].message, details: {} },
    });
  });

  it('answers unknown routes with NOT_FOUND in the same format', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/nao-existe').expect(404);
    expect(errorOf(response).code).toBe('NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toContain('Cannot GET');
  });

  it('turns zod failures into VALIDATION_FAILED with pt-BR messages per field', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/test/errors/validate')
      .send({ name: 'x', quantity: -1 })
      .expect(400);
    expect(errorOf(response).code).toBe('VALIDATION_FAILED');
    const fields = errorOf(response).details.fields as { path: string; message: string }[];
    expect(fields.map((field) => field.path).sort()).toEqual(['name', 'quantity']);
    expect(fields.find((field) => field.path === 'name')?.message).toMatch(/pequeno|caracteres/i);
  });

  it('answers malformed JSON with 400 in the same format', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/test/errors/validate')
      .set('Content-Type', 'application/json')
      .send('{"name":')
      .expect(400);
    expect(ErrorResponseSchema.safeParse(response.body).success).toBe(true);
    expect(errorOf(response).code).toBe('BAD_REQUEST');
  });

  it('shows the internal message outside production, never the stack', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/test/errors/crash')
      .expect(500);
    expect(errorOf(response).code).toBe('INTERNAL_ERROR');
    expect(errorOf(response).details).toMatchObject({
      debug: { message: expect.stringContaining('internal secret') as string },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/\n\s+at /);
  });
});

describe('error format in production', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp({ imports: [InfrastructureTestModule], nodeEnv: 'production' });
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('never leaks internal messages or stacks', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/test/errors/crash')
      .expect(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: ERROR_CODES.INTERNAL_ERROR.message, details: {} },
    });
  });
});

describe('request context (spec 01, section 6)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp({ imports: [InfrastructureTestModule] });
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('generates a request id and returns it in X-Request-Id', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/test/context').expect(200);
    const requestId = response.headers['x-request-id'];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body).toMatchObject({ requestId, deviceId: null, auth: null });
  });

  it('reuses a sane incoming X-Request-Id and replaces an unsafe one', async () => {
    const kept = await request(app.getHttpServer())
      .get('/api/v1/test/context')
      .set('X-Request-Id', 'nginx-abc123');
    expect(kept.headers['x-request-id']).toBe('nginx-abc123');
    const replaced = await request(app.getHttpServer())
      .get('/api/v1/test/context')
      .set('X-Request-Id', 'bad id\twith spaces');
    expect(replaced.headers['x-request-id']).not.toContain(' ');
  });

  it('also returns X-Request-Id on errors', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/nao-existe');
    expect(response.headers['x-request-id']).toBeDefined();
  });

  it('carries the device id, the IP and the actor set by authentication', async () => {
    const deviceId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const response = await request(app.getHttpServer())
      .get('/api/v1/test/context')
      .set('X-Device-Id', deviceId.toUpperCase())
      .set(
        authHeaders({
          organizationId: ORG,
          actor: { type: 'owner', id: STAFF },
          impersonatorId: ADMIN,
        }),
      )
      .expect(200);
    expect(response.body).toMatchObject({
      deviceId,
      ip: expect.stringMatching(/127\.0\.0\.1|::1/) as string,
      auth: { organizationId: ORG, actor: { type: 'owner', id: STAFF }, impersonatorId: ADMIN },
    });
  });

  it('trusts X-Forwarded-For only from a private proxy (RN-01.19)', async () => {
    // supertest connects from loopback, which counts as the proxy.
    const response = await request(app.getHttpServer())
      .get('/api/v1/test/context')
      .set('X-Forwarded-For', '200.150.10.1');
    expect((response.body as { ip: string }).ip).toBe('200.150.10.1');
  });

  it('rejects an X-Device-Id that is not a UUID', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/test/context')
      .set('X-Device-Id', 'meu-celular')
      .expect(400);
    expect(errorOf(response)).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: [{ path: 'X-Device-Id' }] },
    });
  });
});
