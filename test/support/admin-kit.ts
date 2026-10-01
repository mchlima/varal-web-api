/**
 * Platform admin in tests (spec 02): an admin with roles and extra permissions, logged in through
 * the real authentication (`createTestApp({ auth: 'real' })`).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { RateLimiter } from '../../src/auth/rate-limit.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import {
  createPlatformAdmin,
  type CookieJar,
  loginAdmin,
  type TestAdminAccess,
} from './auth-kit.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface AdminClient {
  id: string;
  email: string;
  name: string;
  jar: CookieJar;
  deviceId: string;
  /** A request with the admin cookies and device. */
  call(method: HttpMethod, path: string, body?: object): request.Test;
}

/** Creates an admin (default: Super admin) and logs in. */
export async function adminClient(
  app: NestExpressApplication,
  platform: PrismaClient,
  access: TestAdminAccess = {},
): Promise<AdminClient> {
  const admin = await createPlatformAdmin(platform, undefined, access);
  // Many logins from 127.0.0.1 in a suite: the per-IP limit (in memory) is not what is tested here.
  app.get(RateLimiter).reset();
  const { jar, deviceId } = await loginAdmin(app, admin.email);
  return {
    ...admin,
    jar,
    deviceId,
    call(method, path, body) {
      const call = request(app.getHttpServer())
        [method](path)
        .set('Cookie', jar.header())
        .set('X-Device-Id', deviceId);
      return body === undefined ? call : call.send(body);
    },
  };
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}.${crypto.randomUUID().slice(0, 12)}@teste.local`;
}
