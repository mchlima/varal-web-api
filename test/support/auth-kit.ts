/**
 * Real authentication in tests (phase 1b): logins through the HTTP routes and the session cookies
 * they set. Use with `createTestApp({ auth: 'real' })`.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { AUTH_COOKIES, type AuthArea } from '../../src/auth/auth-area.js';
import { hashPassword } from '../../src/auth/password-hasher.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import type { Tenant } from './isolation-kit.js';

export const TEST_PASSWORD = 'senha-de-teste-123';

/** One parsed `Set-Cookie`. */
export interface SetCookie {
  name: string;
  value: string;
  attributes: Record<string, string | true>;
}

export function parseSetCookies(response: { headers: Record<string, unknown> }): SetCookie[] {
  const raw = response.headers['set-cookie'];
  const lines = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  return lines.map((line) => {
    const [pair = '', ...rest] = line.split(';').map((part) => part.trim());
    const eq = pair.indexOf('=');
    const attributes: Record<string, string | true> = {};
    for (const attribute of rest) {
      const at = attribute.indexOf('=');
      if (at === -1) {
        attributes[attribute.toLowerCase()] = true;
      } else {
        attributes[attribute.slice(0, at).toLowerCase()] = attribute.slice(at + 1);
      }
    }
    return { name: pair.slice(0, eq), value: decodeURIComponent(pair.slice(eq + 1)), attributes };
  });
}

/** Session cookies of one area, as a browser would keep them. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  constructor(readonly area: AuthArea) {}

  /** Applies the `Set-Cookie` headers of a response (expired cookies are removed). */
  store(response: { headers: Record<string, unknown> }): this {
    for (const cookie of parseSetCookies(response)) {
      const expires = cookie.attributes.expires;
      const removed =
        cookie.value === '' ||
        cookie.attributes['max-age'] === '0' ||
        (typeof expires === 'string' && new Date(expires).getTime() <= Date.now());
      if (removed) {
        this.cookies.delete(cookie.name);
      } else {
        this.cookies.set(cookie.name, cookie.value);
      }
    }
    return this;
  }

  get access(): string | undefined {
    return this.cookies.get(AUTH_COOKIES[this.area].access);
  }

  get refresh(): string | undefined {
    return this.cookies.get(AUTH_COOKIES[this.area].refresh);
  }

  /** `Cookie` header with every stored cookie. */
  header(): string {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join('; ');
  }

  clone(): CookieJar {
    const copy = new CookieJar(this.area);
    for (const [name, value] of this.cookies) {
      copy.cookies.set(name, value);
    }
    return copy;
  }
}

export function newDeviceId(): string {
  return crypto.randomUUID();
}

/** Defines the password of a subject directly in the database (as the seed or the owner would). */
export async function setPassword(
  platform: PrismaClient,
  subject: { owner?: string; staff?: string; admin?: string },
  password = TEST_PASSWORD,
): Promise<void> {
  const passwordHash = await hashPassword(password);
  if (subject.owner) {
    await platform.user.update({ where: { id: subject.owner }, data: { passwordHash } });
  }
  if (subject.staff) {
    await platform.staffMember.update({ where: { id: subject.staff }, data: { passwordHash } });
  }
  if (subject.admin) {
    await platform.platformAdmin.update({ where: { id: subject.admin }, data: { passwordHash } });
  }
}

/** Creates an active platform admin with a password. */
export async function createPlatformAdmin(
  platform: PrismaClient,
  password = TEST_PASSWORD,
): Promise<{ id: string; email: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const admin = await platform.platformAdmin.create({
    data: {
      name: `Admin ${suffix}`,
      email: `admin.${suffix}@teste.local`,
      passwordHash: await hashPassword(password),
    },
  });
  return { id: admin.id, email: admin.email };
}

export interface LoggedIn {
  jar: CookieJar;
  deviceId: string;
  body: unknown;
}

export async function loginOwner(
  app: NestExpressApplication,
  email: string,
  password = TEST_PASSWORD,
  deviceId = newDeviceId(),
): Promise<LoggedIn> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/auth/owner/login')
    .set('X-Device-Id', deviceId)
    .send({ email, password })
    .expect(200);
  return { jar: new CookieJar('panel').store(response), deviceId, body: response.body };
}

export async function loginStaff(
  app: NestExpressApplication,
  credentials: { accessCode: string; username: string },
  password = TEST_PASSWORD,
  deviceId = newDeviceId(),
): Promise<LoggedIn> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/auth/staff/login')
    .set('X-Device-Id', deviceId)
    .send({ ...credentials, password })
    .expect(200);
  return { jar: new CookieJar('panel').store(response), deviceId, body: response.body };
}

export async function loginAdmin(
  app: NestExpressApplication,
  email: string,
  password = TEST_PASSWORD,
  deviceId = newDeviceId(),
): Promise<LoggedIn> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/admin/auth/login')
    .set('X-Device-Id', deviceId)
    .send({ email, password })
    .expect(200);
  return { jar: new CookieJar('admin').store(response), deviceId, body: response.body };
}

/** Access code and username of the staff member of a tenant created by `createTenant`. */
export async function credentialsOf(
  platform: PrismaClient,
  tenant: Tenant,
): Promise<{ accessCode: string; username: string; email: string }> {
  const staff = await platform.staffMember.findUniqueOrThrow({
    where: { id: tenant.staffMemberId },
    include: { organization: { select: { accessCode: true } } },
  });
  const owner = await platform.user.findUniqueOrThrow({ where: { id: tenant.ownerId } });
  return {
    accessCode: staff.organization.accessCode,
    username: staff.username,
    email: owner.email,
  };
}
