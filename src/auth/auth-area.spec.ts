import { describe, expect, it } from 'vitest';

import { AUTH_COOKIES, isAdminPath } from './auth-area.js';

describe('auth areas (CA-01.04)', () => {
  it.each([
    ['/api/v1/admin', true],
    ['/api/v1/admin/auth/me', true],
    ['/API/V1/ADMIN/auth/me', true],
    ['//api/v1//admin/emails/usage', true],
    ['/api/v1/administrator', false],
    ['/api/v1/auth/me', false],
    ['/api/v1/test/admin', false],
  ])('%s is an admin path: %s', (path, expected) => {
    expect(isAdminPath(path)).toBe(expected);
  });

  it('gives each area its own cookie names; access cookies use the __Host- prefix', () => {
    const names = [
      AUTH_COOKIES.panel.access,
      AUTH_COOKIES.panel.refresh,
      AUTH_COOKIES.admin.access,
      AUTH_COOKIES.admin.refresh,
    ];
    expect(new Set(names).size).toBe(4);
    expect(AUTH_COOKIES.panel.access.startsWith('__Host-')).toBe(true);
    expect(AUTH_COOKIES.admin.access.startsWith('__Host-')).toBe(true);
  });
});
