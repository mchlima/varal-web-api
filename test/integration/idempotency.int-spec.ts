import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { AuthContext } from '../../src/context/request-context.js';
import { IDEMPOTENCY_LOCK_TIMEOUT_MS } from '../../src/idempotency/idempotency.constants.js';
import { IdempotencyService } from '../../src/idempotency/idempotency.service.js';
import { hashRequest } from '../../src/idempotency/request-hash.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { IdempotencyTestModule } from '../support/idempotency-test-routes.js';
import { createTenant, type Tenant } from '../support/isolation-kit.js';
import { errorOf } from '../support/http.js';
import { authHeaders } from '../support/stub-auth.js';
import { createTestApp } from '../support/test-app.js';

const databaseUrl = inject('databaseUrl');
const PATH = '/api/v1/test/units';

describe.skipIf(!databaseUrl)('Idempotency-Key (spec 01, section 5)', () => {
  let app: NestExpressApplication;
  let platform: PlatformPrismaService;
  let tenant: Tenant;

  beforeAll(async () => {
    app = await createTestApp({ imports: [IdempotencyTestModule], databaseUrl: databaseUrl ?? '' });
    platform = app.get(PlatformPrismaService);
    tenant = await createTenant(platform, 'Idempotência');
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  function post(body: object, key?: string, auth: AuthContext = tenant.auth) {
    const call = request(app.getHttpServer()).post(PATH).set(authHeaders(auth));
    return (key === undefined ? call : call.set('Idempotency-Key', key)).send(body);
  }

  function uniqueName(): string {
    return `Unidade ${crypto.randomUUID()}`;
  }

  async function unitsNamed(name: string): Promise<number> {
    return platform.unit.count({ where: { organizationId: tenant.organizationId, name } });
  }

  it('CA-01.06: repeating a creation with the same key creates once and returns the same response', async () => {
    const key = crypto.randomUUID();
    const body = { name: uniqueName() };

    const first = await post(body, key).expect(201);
    const second = await post(body, key).expect(201);

    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(await unitsNamed(body.name)).toBe(1);
    // The audit row was written once, in the same transaction (CA-01.08).
    const unitId = (first.body as { id: string }).id;
    expect(await platform.auditLog.count({ where: { entityId: unitId } })).toBe(1);
  });

  it('runs the route normally without the header', async () => {
    const body = { name: uniqueName() };
    await post(body).expect(201);
    await post(body).expect(409); // unique (organization, name): the route really ran twice
    expect(await unitsNamed(body.name)).toBe(1);
  });

  it('answers 409 IDEMPOTENCY_KEY_REUSED when the same key comes with another body', async () => {
    const key = crypto.randomUUID();
    await post({ name: uniqueName() }, key).expect(201);
    const otherName = uniqueName();
    const response = await post({ name: otherName }, key).expect(409);
    expect(errorOf(response).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await unitsNamed(otherName)).toBe(0);
  });

  it('answers 409 IDEMPOTENCY_REQUEST_IN_PROGRESS while the first request with the key runs', async () => {
    const key = crypto.randomUUID();
    const body = { name: uniqueName(), delayMs: 1_000 };
    const slow = post(body, key).then((response) => response);
    // Waits until the first request has claimed the key (it then holds it for delayMs).
    await vi.waitFor(
      async () => {
        expect(await platform.idempotencyKey.count({ where: { key, status: 'in_progress' } })).toBe(
          1,
        );
      },
      { timeout: 2_000, interval: 20 },
    );

    const concurrent = await post(body, key).expect(409);
    expect(errorOf(concurrent).code).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS');

    expect((await slow).status).toBe(201);
    const replay = await post(body, key).expect(201);
    expect(replay.body).toEqual((await slow).body);
    expect(await unitsNamed(body.name)).toBe(1);
  });

  it('rolls the action back on a 4xx and replays the same error', async () => {
    const key = crypto.randomUUID();
    const body = { name: uniqueName(), fail: 'client' };
    const first = await post(body, key).expect(422);
    expect(errorOf(first).code).toBe('UNIT_REJECTED');
    const second = await post(body, key).expect(422);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await unitsNamed(body.name)).toBe(0);
  });

  it('releases the key on a 5xx, so a retry runs the action again', async () => {
    const key = crypto.randomUUID();
    const body = { name: uniqueName(), fail: 'server' };
    await post(body, key).expect(500);
    expect(await platform.idempotencyKey.count({ where: { key } })).toBe(0);
    const retry = await post(body, key).expect(500);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(await unitsNamed(body.name)).toBe(0);
  });

  it('keeps keys per subject: the same key from another user is independent', async () => {
    const key = crypto.randomUUID();
    await post({ name: uniqueName() }, key, tenant.auth).expect(201);
    const response = await post({ name: uniqueName() }, key, tenant.ownerAuth).expect(201);
    expect(response.headers['idempotent-replayed']).toBeUndefined();
  });

  it('rejects a key that is not a UUID', async () => {
    const response = await post({ name: uniqueName() }, 'abc').expect(400);
    expect(errorOf(response)).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: [{ path: 'Idempotency-Key' }] },
    });
  });

  it('requires an authenticated subject to use a key', async () => {
    const response = await request(app.getHttpServer())
      .post(PATH)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ name: uniqueName() })
      .expect(401);
    expect(errorOf(response).code).toBe('UNAUTHENTICATED');
  });

  it('treats a key past its 24 h as new', async () => {
    const key = crypto.randomUUID();
    await post({ name: uniqueName() }, key).expect(201);
    await platform.idempotencyKey.updateMany({
      where: { key },
      data: { expiresAt: new Date(Date.now() - 60 * 60_000) },
    });
    const name = uniqueName();
    const response = await post({ name }, key).expect(201);
    expect(response.headers['idempotent-replayed']).toBeUndefined();
    expect(await unitsNamed(name)).toBe(1);
  });

  it('takes over an abandoned in-progress attempt of the same request (crashed process)', async () => {
    const key = crypto.randomUUID();
    const body = { name: uniqueName() };
    await platform.idempotencyKey.create({
      data: {
        key,
        subjectId: tenant.staffMemberId,
        organizationId: tenant.organizationId,
        requestHash: hashRequest('POST', PATH, body),
        lockedAt: new Date(Date.now() - IDEMPOTENCY_LOCK_TIMEOUT_MS - 1000),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await post(body, key).expect(201);
    expect(await unitsNamed(body.name)).toBe(1);
  });

  it('purges expired keys (to be scheduled by a job)', async () => {
    const key = crypto.randomUUID();
    await post({ name: uniqueName() }, key).expect(201);
    await platform.idempotencyKey.updateMany({
      where: { key },
      data: { expiresAt: new Date(Date.now() - 60 * 60_000) },
    });
    const purged = await app.get(IdempotencyService).purgeExpired();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await platform.idempotencyKey.count({ where: { key } })).toBe(0);
  });
});
