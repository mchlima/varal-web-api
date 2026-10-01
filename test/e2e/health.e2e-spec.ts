import 'reflect-metadata';

import { Body, Controller, Module, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

const SampleBody = z.object({ name: z.string().min(1) });

@Controller('sample')
class SampleController {
  @Post()
  create(
    @Body({ schema: SampleBody }) body: z.infer<typeof SampleBody>,
  ): z.infer<typeof SampleBody> {
    return body;
  }
}

@Module({ controllers: [SampleController] })
class SampleModule {}

async function createApp(prismaOverride?: Partial<PrismaService>): Promise<NestExpressApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule, SampleModule] });
  if (prismaOverride) {
    builder = builder.overrideProvider(PrismaService).useValue(prismaOverride);
  }
  const moduleRef = await builder.compile();
  const app = configureApp(
    moduleRef.createNestApplication<NestExpressApplication>({ logger: false }),
  );
  await app.init();
  return app;
}

describe('GET /api/v1/health', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    // No reachable database: port 1 refuses connections immediately.
    vi.stubEnv('DATABASE_URL', 'postgresql://varal:varal@127.0.0.1:1/varal_unreachable');
    vi.stubEnv('CORS_ORIGINS', 'http://localhost:3100,http://localhost:3200');
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('answers 200 with db unavailable when the database is down', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(response.body).toEqual({ status: 'ok', db: 'unavailable' });
  });

  it('allows CORS with credentials only for the configured origins (RN-01.20)', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'http://localhost:3100');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3100');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('validates bodies with zod through the global StandardSchemaValidationPipe', async () => {
    await request(app.getHttpServer()).post('/api/v1/sample').send({ name: '' }).expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/sample')
      .send({ name: 'espeto', extra: true })
      .expect(201, { name: 'espeto' });
  });
});

describe('GET /api/v1/health with the database up', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://varal:varal@127.0.0.1:1/varal_unused');
    vi.stubEnv('CORS_ORIGINS', 'http://localhost:3100');
    app = await createApp({ $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]) as never });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('reports db ok', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200, { status: 'ok', db: 'ok' });
  });
});
