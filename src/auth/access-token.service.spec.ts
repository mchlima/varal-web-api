import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import type { Env } from '../config/env.js';
import { type AccessTokenClaims, AccessTokenService } from './access-token.service.js';

const env = {
  AUTH_PANEL_JWT_SECRET: 'p'.repeat(40),
  AUTH_ADMIN_JWT_SECRET: 'a'.repeat(40),
} as Env;

const owner: AccessTokenClaims = {
  subjectId: '01922f2c-7a3b-7c00-8000-0000000000aa',
  subjectType: 'owner',
  sessionId: '01922f2c-7a3b-7c00-8000-0000000000bb',
  organizationId: '01922f2c-7a3b-7c00-8000-0000000000cc',
};
const admin: AccessTokenClaims = { ...owner, subjectType: 'platform_admin', organizationId: null };

describe('AccessTokenService (spec 01, section 7.2)', () => {
  const service = new AccessTokenService(env);

  it('issues 15-minute tokens that verify in their own area', async () => {
    const now = new Date();
    const { token, expiresAt } = await service.issue('panel', owner, now);
    expect(expiresAt.getTime() - now.getTime()).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(expiresAt.getTime() - now.getTime()).toBeGreaterThan(14 * 60 * 1000);
    await expect(service.verify('panel', token)).resolves.toMatchObject(owner);
  });

  it('CA-01.04: a panel token is refused by the admin and an admin token by the panel', async () => {
    const panel = await service.issue('panel', owner);
    const adminToken = await service.issue('admin', admin);
    await expect(service.verify('admin', panel.token)).resolves.toBeNull();
    await expect(service.verify('panel', adminToken.token)).resolves.toBeNull();
    await expect(service.verify('admin', adminToken.token)).resolves.toMatchObject(admin);
  });

  it('CA-01.04: refuses a token signed with the right secret but the other audience', async () => {
    // Even if both secrets leaked into one area, the audience and subject type still separate them.
    const forged = await new SignJWT({
      typ: 'owner',
      sid: owner.sessionId,
      org: owner.organizationId,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(owner.subjectId)
      .setIssuer('varal-api')
      .setAudience('varal-panel')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(env.AUTH_ADMIN_JWT_SECRET));
    await expect(service.verify('admin', forged)).resolves.toBeNull();
  });

  it('refuses expired, tampered and unsigned tokens', async () => {
    const old = await service.issue('panel', owner, new Date(Date.now() - 16 * 60 * 1000));
    await expect(service.verify('panel', old.token)).resolves.toBeNull();

    const { token } = await service.issue('panel', owner);
    const [header, payload, signature] = token.split('.');
    const changed = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()),
        org: 'x',
      }),
    ).toString('base64url');
    await expect(service.verify('panel', `${header}.${changed}.${signature}`)).resolves.toBeNull();

    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${payload}.`;
    await expect(service.verify('panel', none)).resolves.toBeNull();
    await expect(service.verify('panel', 'lixo')).resolves.toBeNull();
  });

  it('never issues a token of one area to a subject of the other', async () => {
    await expect(service.issue('admin', owner)).rejects.toThrow();
    await expect(service.issue('panel', admin)).rejects.toThrow();
  });
});
