import { Inject, Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';

import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import type { SubjectType } from '../generated/prisma/enums.js';
import { ACCESS_TOKEN_TTL_SECONDS, AREA_SUBJECTS, type AuthArea } from './auth-area.js';

const ISSUER = 'varal-api';
const AUDIENCE: Record<AuthArea, string> = { panel: 'varal-panel', admin: 'varal-admin' };
const ALGORITHM = 'HS256';
const SUBJECT_TYPES = new Set<string>(['owner', 'staff', 'platform_admin']);

export interface AccessTokenClaims {
  /** Subject (owner, staff member or platform admin) id. */
  subjectId: string;
  subjectType: SubjectType;
  sessionId: string;
  /** Null for platform admins. */
  organizationId: string | null;
}

export interface IssuedAccessToken {
  token: string;
  expiresAt: Date;
}

/**
 * JWT access tokens (spec 01, section 7.2): HS256, 15 minutes, signed with the secret of the area
 * and bound to its audience, so a panel token never verifies in the admin and vice versa (CA-01.04).
 */
@Injectable()
export class AccessTokenService {
  private readonly keys: Record<AuthArea, Uint8Array>;

  constructor(@Inject(APP_ENV) env: Env) {
    const encoder = new TextEncoder();
    this.keys = {
      panel: encoder.encode(env.AUTH_PANEL_JWT_SECRET),
      admin: encoder.encode(env.AUTH_ADMIN_JWT_SECRET),
    };
  }

  async issue(
    area: AuthArea,
    claims: AccessTokenClaims,
    now = new Date(),
  ): Promise<IssuedAccessToken> {
    if (!AREA_SUBJECTS[area].includes(claims.subjectType)) {
      throw new Error(`A ${claims.subjectType} cannot get a token of the ${area} area`);
    }
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAt = issuedAt + ACCESS_TOKEN_TTL_SECONDS;
    const token = await new SignJWT({
      typ: claims.subjectType,
      sid: claims.sessionId,
      org: claims.organizationId,
    })
      .setProtectedHeader({ alg: ALGORITHM })
      .setSubject(claims.subjectId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE[area])
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.keys[area]);
    return { token, expiresAt: new Date(expiresAt * 1000) };
  }

  /** Claims of a valid token of `area`, or null (bad signature, other area, expired, malformed). */
  async verify(
    area: AuthArea,
    token: string,
  ): Promise<(AccessTokenClaims & { expiresAt: Date }) | null> {
    try {
      const { payload } = await jwtVerify(token, this.keys[area], {
        issuer: ISSUER,
        audience: AUDIENCE[area],
        algorithms: [ALGORITHM],
      });
      const { sub, typ, sid, org, exp } = payload;
      if (
        typeof sub !== 'string' ||
        typeof typ !== 'string' ||
        !SUBJECT_TYPES.has(typ) ||
        !AREA_SUBJECTS[area].includes(typ as SubjectType) ||
        typeof sid !== 'string' ||
        !(typeof org === 'string' || org === null) ||
        typeof exp !== 'number'
      ) {
        return null;
      }
      if ((typ === 'platform_admin') !== (org === null)) {
        return null;
      }
      return {
        subjectId: sub,
        subjectType: typ as SubjectType,
        sessionId: sid,
        organizationId: org,
        expiresAt: new Date(exp * 1000),
      };
    } catch {
      return null;
    }
  }
}
