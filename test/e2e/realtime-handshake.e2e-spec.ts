import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AccessTokenService } from '../../src/auth/access-token.service.js';
import { AUTH_COOKIES } from '../../src/auth/auth-area.js';
import { connectFailure, TEST_ORIGIN } from '../support/socket-kit.js';
import { createTestApp } from '../support/test-app.js';

/**
 * Handshake refusals that need no database (spec 01, section 10). The connections that pass the
 * token check are covered by test/integration/realtime.int-spec.ts.
 */
describe('real-time handshake (spec 01, section 10)', () => {
  let app: NestExpressApplication;
  let url: string;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp({ auth: 'real' });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    url = `http://127.0.0.1:${address.port}`;
    const issued = await app.get(AccessTokenService).issue('admin', {
      subjectId: crypto.randomUUID(),
      subjectType: 'platform_admin',
      sessionId: crypto.randomUUID(),
      organizationId: null,
    });
    adminToken = issued.token;
  });

  afterAll(async () => {
    await app.close();
  });

  const deviceId = crypto.randomUUID();

  it('refuses a connection without the session cookie (UNAUTHENTICATED)', async () => {
    const failure = await connectFailure(url, { deviceId });
    expect(failure.data?.error?.code).toBe('UNAUTHENTICATED');
    expect(failure.data?.error?.message).toBe('Sua sessão expirou. Entre novamente.');
  });

  it('refuses a malformed or forged token', async () => {
    const failure = await connectFailure(url, {
      deviceId,
      cookie: `${AUTH_COOKIES.panel.access}=nao-e-um-jwt`,
    });
    expect(failure.data?.error?.code).toBe('UNAUTHENTICATED');
  });

  it('never accepts the admin token, under either cookie name (CA-01.04)', async () => {
    for (const name of [AUTH_COOKIES.admin.access, AUTH_COOKIES.panel.access]) {
      const failure = await connectFailure(url, { deviceId, cookie: `${name}=${adminToken}` });
      expect(failure.data?.error?.code).toBe('UNAUTHENTICATED');
    }
  });

  it('requires the device id in auth.deviceId (DEVICE_ID_REQUIRED)', async () => {
    const cookie = `${AUTH_COOKIES.panel.access}=qualquer`;
    for (const options of [{ deviceId: null }, { deviceId: 'nao-e-uuid' }]) {
      const failure = await connectFailure(url, { cookie, ...options });
      expect(failure.data?.error?.code).toBe('DEVICE_ID_REQUIRED');
    }
  });

  it('refuses origins outside CORS_ORIGINS and handshakes without Origin (RN-01.20)', async () => {
    for (const origin of ['http://evil.example', 'http://localhost:3100.evil.example', null]) {
      const failure = await connectFailure(url, { deviceId, origin });
      // Refused at the upgrade, before Socket.IO: no error body, only the transport error.
      expect(failure.data?.error).toBeUndefined();
      expect(failure.message).toMatch(/websocket error/i);
    }
    // The same request from the allowed origin reaches the authentication.
    const allowed = await connectFailure(url, { deviceId, origin: TEST_ORIGIN });
    expect(allowed.data?.error?.code).toBe('UNAUTHENTICATED');
  });

  it('serves only the WebSocket transport at /ws (no long-polling)', async () => {
    const response = await fetch(`${url}/ws/?EIO=4&transport=polling`, {
      headers: { origin: TEST_ORIGIN },
    });
    expect(response.status).toBe(400);
  });
});
