import type { SubjectType } from '../generated/prisma/enums.js';

/**
 * The two authentication contexts (spec 01, section 7.2; CA-01.04): the customers' app
 * (`varal-panel-web`: owners and staff) and the platform admin (`varal-admin-web`). Each has its own
 * cookies, signing secret and token audience, and a token of one is never accepted by the other.
 */
export type AuthArea = 'panel' | 'admin';

/** Access token (JWT) lifetime: 15 minutes (spec 01, section 7.2). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** Refresh token lifetime: 30 days, renewed on every rotation (spec 01, section 7.2). */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AreaCookies {
  /** Access token. `__Host-` prefix: Secure, Path=/ and no Domain, so a sibling subdomain of
   * kratinho.com.br cannot set or overwrite it (cookie tossing). */
  access: string;
  /** Refresh token, sent only to the auth routes of its area. */
  refresh: string;
  refreshPath: string;
}

export const AUTH_COOKIES: Record<AuthArea, AreaCookies> = {
  panel: {
    access: '__Host-varal_at',
    refresh: '__Secure-varal_rt',
    refreshPath: '/api/v1/auth',
  },
  admin: {
    access: '__Host-varal_admin_at',
    refresh: '__Secure-varal_admin_rt',
    refreshPath: '/api/v1/admin/auth',
  },
};

/** Subject types that may sign in to each area. */
export const AREA_SUBJECTS: Record<AuthArea, readonly SubjectType[]> = {
  panel: ['owner', 'staff'],
  admin: ['platform_admin'],
};

export function areaOfSubject(subjectType: SubjectType): AuthArea {
  return subjectType === 'platform_admin' ? 'admin' : 'panel';
}

const ADMIN_PATH = /^\/+api\/+v1\/+admin(\/|$)/i;

/**
 * True for paths under `/api/v1/admin`. Case-insensitive and tolerant to repeated slashes, because
 * Express routes `/API/V1/ADMIN/...` to the same handlers.
 */
export function isAdminPath(path: string): boolean {
  return ADMIN_PATH.test(path);
}
