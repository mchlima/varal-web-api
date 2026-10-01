import { setTimeout as sleep } from 'node:timers/promises';

import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { RateLimiter } from '../../src/auth/rate-limit.js';
import { ACCESS_CODE_PATTERN } from '../../src/common/access-code.js';
import { PgBossService } from '../../src/jobs/pg-boss.service.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { type AdminClient, adminClient, uniqueEmail } from '../support/admin-kit.js';
import { loginOwner, newDeviceId, setPassword } from '../support/auth-kit.js';
import { errorOf } from '../support/http.js';
import { createTestApp } from '../support/test-app.js';

const databaseUrl = inject('databaseUrl');
const API = '/api/v1';
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';

async function mailpitReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${MAILPIT_URL}/api/v1/info`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const mailpitUp = databaseUrl ? await mailpitReachable() : false;

interface OrganizationBody {
  id: string;
  name: string;
  accessCode: string;
  subscriptionStatus: string;
  suspendedReason: string | null;
  owner: { id: string; email: string; inviteStatus: string } | null;
  units: { id: string; name: string }[];
}

function newOrganization(label = 'Barraca') {
  const suffix = crypto.randomUUID().slice(0, 6);
  return {
    name: `${label} ${suffix}`,
    unitName: `Feira ${suffix}`,
    owner: { name: `Dono ${suffix}`, email: uniqueEmail(`dono.${suffix}`) },
  };
}

describe.skipIf(!databaseUrl)('organizations and subscription (spec 02, section 4)', () => {
  let app: NestExpressApplication;
  let platform: PlatformPrismaService;
  let admin: AdminClient;

  beforeAll(async () => {
    app = await createTestApp({ auth: 'real', databaseUrl: databaseUrl ?? '' });
    platform = app.get(PlatformPrismaService);
    admin = await adminClient(app, platform);
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  async function create(input = newOrganization()): Promise<OrganizationBody> {
    const response = await admin.call('post', `${API}/admin/organizations`, input).expect(201);
    return response.body as OrganizationBody;
  }

  describe('creation (RN-02.09, RN-02.10; CA-02.04)', () => {
    it('creates organization, unit, owner without password and the invite in one transaction', async () => {
      const input = newOrganization('Espetinho');
      const body = await create({
        ...input,
        owner: { ...input.owner, email: `  ${input.owner.email.toUpperCase()} ` },
      });
      expect(body).toMatchObject({
        name: input.name,
        subscriptionStatus: 'active',
        owner: { email: input.owner.email, inviteStatus: 'pending' },
        units: [{ name: input.unitName }],
      });
      expect(body.accessCode).toMatch(ACCESS_CODE_PATTERN);

      const owner = await platform.user.findUniqueOrThrow({ where: { email: input.owner.email } });
      expect(owner).toMatchObject({ organizationId: body.id, passwordHash: null, active: true });
      await expect(
        platform.passwordToken.count({
          where: { subjectId: owner.id, purpose: 'invite', usedAt: null },
        }),
      ).resolves.toBe(1);
      await expect(
        platform.emailLog.findFirst({ where: { to: input.owner.email, type: 'owner_invite' } }),
      ).resolves.toMatchObject({ organizationId: body.id, status: expect.any(String) as string });
      const actions = await platform.auditLog.findMany({
        where: { organizationId: body.id },
        select: { action: true, actorType: true, actorId: true },
      });
      expect(actions.map((row) => row.action).sort()).toEqual([
        'auth.password_link_issued',
        'organization.created',
        'unit.created',
        'unit.template_applied',
        'user.created',
      ]);
      expect(
        actions.every((row) => row.actorType === 'platform_admin' && row.actorId === admin.id),
      ).toBe(true);
    });

    it('CA-02.04: the first unit is born with the default template (Balcão, Cozinha, Balcão de entrega; 4 stages)', async () => {
      const body = await create(newOrganization('Template'));
      const unitId = body.units[0]?.id ?? '';
      const stations = await platform.station.findMany({
        where: { unitId },
        orderBy: { sortOrder: 'asc' },
        select: { name: true, kind: true, organizationId: true },
      });
      expect(stations).toEqual([
        { name: 'Balcão', kind: 'counter', organizationId: body.id },
        { name: 'Cozinha', kind: 'queue', organizationId: body.id },
        { name: 'Balcão de entrega', kind: 'queue', organizationId: body.id },
      ]);
      const stages = await platform.workflowStage.findMany({
        where: { unitId },
        orderBy: { sortOrder: 'asc' },
        select: { name: true, target: true, isFinal: true },
      });
      expect(stages.map((stage) => stage.name)).toEqual([
        'Recebido',
        'Preparando',
        'Pronto',
        'Entregue',
      ]);
      expect(stages.at(-1)).toMatchObject({ target: 'none', isFinal: true });
      // Same transaction and same actor as the creation (spec 01, section 8).
      await expect(
        platform.auditLog.findFirst({
          where: { action: 'unit.template_applied', entityId: unitId },
        }),
      ).resolves.toMatchObject({ organizationId: body.id, actorId: admin.id });
    });

    it('RN-02.10: refuses an owner e-mail that already exists, creating nothing', async () => {
      const first = newOrganization();
      await create(first);
      const second = { ...newOrganization(), owner: { name: 'Outro', email: first.owner.email } };
      const response = await admin.call('post', `${API}/admin/organizations`, second).expect(409);
      expect(errorOf(response).code).toBe('OWNER_EMAIL_TAKEN');
      await expect(platform.organization.count({ where: { name: second.name } })).resolves.toBe(0);
    });

    it('validates the body (VALIDATION_FAILED in pt-BR)', async () => {
      const response = await admin
        .call('post', `${API}/admin/organizations`, { name: 'X', owner: { email: 'nao-e-email' } })
        .expect(400);
      const paths = (errorOf(response).details.fields as { path: string }[]).map((f) => f.path);
      expect(paths).toEqual(
        expect.arrayContaining(['name', 'unitName', 'owner.name', 'owner.email']),
      );
    });

    it.skipIf(!mailpitUp)(
      'CA-02.04: the owner receives the invite, defines the password by the link and enters the panel',
      async () => {
        await app.get(PgBossService).whenReady(15_000);
        const input = newOrganization('Convite');
        const body = await create(input);
        let link: string | undefined;
        for (let attempt = 0; attempt < 40 && link === undefined; attempt++) {
          const search = (await (
            await fetch(
              `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${input.owner.email}`)}`,
            )
          ).json()) as { messages: { ID: string }[] };
          const id = search.messages[0]?.ID;
          if (id) {
            const message = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${id}`)).json()) as {
              Text: string;
            };
            link = /https?:\/\/\S+definir-senha#token=[\w-]+&tipo=convite/.exec(message.Text)?.[0];
          }
          if (link === undefined) {
            await sleep(250);
          }
        }
        expect(link).toBeDefined();
        const token = /token=([\w-]+)/.exec(new URL(link ?? '').hash)?.[1];
        app.get(RateLimiter).reset();
        await request(app.getHttpServer())
          .post(`${API}/auth/password/reset`)
          .send({ token, password: 'senha-do-dono-123' })
          .expect(204);
        const { body: me } = await loginOwner(app, input.owner.email, 'senha-do-dono-123');
        expect(me).toMatchObject({
          subject: { type: 'owner' },
          organization: { id: body.id, accessCode: body.accessCode },
          units: [{ name: input.unitName }],
        });
        const detail = await admin.call('get', `${API}/admin/organizations/${body.id}`).expect(200);
        expect(detail.body).toMatchObject({ owner: { inviteStatus: 'accepted' } });
        expect((detail.body as { lastAccessAt: string | null }).lastAccessAt).not.toBeNull();
      },
    );
  });

  describe('list and detail', () => {
    it('searches by name, access code or owner e-mail and filters by situation', async () => {
      const body = await create(newOrganization('Tapioca Busca'));
      const search = async (query: string) =>
        (
          (await admin.call('get', `${API}/admin/organizations?${query}`).expect(200)).body as {
            data: { id: string }[];
          }
        ).data.map((item) => item.id);
      await expect(
        search(`search=${encodeURIComponent(body.name.toLowerCase())}`),
      ).resolves.toEqual([body.id]);
      await expect(search(`search=${body.accessCode.toLowerCase()}`)).resolves.toEqual([body.id]);
      await expect(
        search(`search=${encodeURIComponent(body.owner?.email ?? '')}`),
      ).resolves.toEqual([body.id]);
      await expect(search(`status=active&limit=100`)).resolves.toContain(body.id);
      await expect(search(`status=canceled&limit=100`)).resolves.not.toContain(body.id);
    });

    it('paginates newest first', async () => {
      const a = await create();
      const b = await create();
      const page = (await admin.call('get', `${API}/admin/organizations?limit=1`).expect(200))
        .body as { data: { id: string }[]; nextCursor: string };
      expect(page.data[0]?.id).toBe(b.id);
      const next = (
        await admin
          .call('get', `${API}/admin/organizations?limit=1&cursor=${page.nextCursor}`)
          .expect(200)
      ).body as { data: { id: string }[] };
      expect(next.data[0]?.id).toBe(a.id);
    });

    it('detail has units, active staff, shifts (spec 04), last access and unread announcements', async () => {
      const body = await create();
      const detail = await admin.call('get', `${API}/admin/organizations/${body.id}`).expect(200);
      expect(detail.body).toMatchObject({
        id: body.id,
        units: [{ id: body.units[0]?.id }],
        activeStaffCount: 0,
        recentShifts: [],
        lastAccessAt: null,
        unreadAnnouncements: expect.any(Number) as number,
      });
      await admin.call('get', `${API}/admin/organizations/${crypto.randomUUID()}`).expect(404);
      await admin.call('get', `${API}/admin/organizations/nao-e-uuid`).expect(400);
    });
  });

  describe('changes', () => {
    it('renames and changes the owner e-mail; a pending invite goes to the new address', async () => {
      const body = await create();
      const email = uniqueEmail('novo.dono');
      const updated = await admin
        .call('patch', `${API}/admin/organizations/${body.id}`, {
          name: 'Nome Novo',
          owner: { email },
        })
        .expect(200);
      expect(updated.body).toMatchObject({
        name: 'Nome Novo',
        owner: { email, inviteStatus: 'pending' },
      });
      await expect(
        platform.emailLog.count({ where: { to: email, type: 'owner_invite' } }),
      ).resolves.toBe(1);
      const other = await create();
      const taken = await admin
        .call('patch', `${API}/admin/organizations/${body.id}`, {
          owner: { email: other.owner?.email },
        })
        .expect(409);
      expect(errorOf(taken).code).toBe('OWNER_EMAIL_TAKEN');
      await expect(
        platform.auditLog.count({
          where: {
            organizationId: body.id,
            action: { in: ['organization.updated', 'user.updated'] },
          },
        }),
      ).resolves.toBe(2);
    });

    it('resends the owner invite (previous link stops); refuses when the owner already has a password', async () => {
      const body = await create();
      const ownerId = body.owner?.id ?? '';
      await admin.call('post', `${API}/admin/organizations/${body.id}/owner-invite`).expect(202);
      await expect(
        platform.passwordToken.count({
          where: {
            subjectId: ownerId,
            purpose: 'invite',
            usedAt: null,
            expiresAt: { gt: new Date() },
          },
        }),
      ).resolves.toBe(1);
      await platform.user.update({ where: { id: ownerId }, data: { passwordHash: 'x' } });
      const response = await admin
        .call('post', `${API}/admin/organizations/${body.id}/owner-invite`)
        .expect(409);
      expect(errorOf(response).code).toBe('OWNER_ALREADY_ACTIVE');
    });

    it('RN-02.11/RN-02.12: suspend and reactivate with a reason, shown in the owner banner (CA-02.05)', async () => {
      const input = newOrganization('Suspensa');
      const body = await create(input);
      const suspended = await admin
        .call('post', `${API}/admin/organizations/${body.id}/suspend`, {
          reason: 'Mensalidade em atraso',
        })
        .expect(200);
      expect(suspended.body).toMatchObject({
        subscriptionStatus: 'suspended',
        suspendedReason: 'Mensalidade em atraso',
      });
      const again = await admin
        .call('post', `${API}/admin/organizations/${body.id}/suspend`, { reason: 'De novo' })
        .expect(409);
      expect(errorOf(again).code).toBe('INVALID_STATUS_TRANSITION');
      await admin.call('post', `${API}/admin/organizations/${body.id}/suspend`, {}).expect(400);

      // The owner still logs in and sees the situation and the reason (banner, RN-02.12).
      await setPassword(platform, { owner: body.owner?.id ?? '' }, 'senha-123456');
      app.get(RateLimiter).reset();
      const { body: me } = await loginOwner(app, input.owner.email, 'senha-123456', newDeviceId());
      expect(me).toMatchObject({
        organization: { subscriptionStatus: 'suspended', suspendedReason: 'Mensalidade em atraso' },
      });

      const reactivated = await admin
        .call('post', `${API}/admin/organizations/${body.id}/reactivate`, {
          reason: 'Pagamento confirmado',
          status: 'pilot',
        })
        .expect(200);
      expect(reactivated.body).toMatchObject({
        subscriptionStatus: 'pilot',
        suspendedReason: null,
      });
      const audit = await platform.auditLog.findFirstOrThrow({
        where: { organizationId: body.id, action: 'organization.suspended' },
      });
      expect(audit.changes).toMatchObject({
        before: { subscriptionStatus: 'active' },
        after: { subscriptionStatus: 'suspended' },
        metadata: { reason: 'Mensalidade em atraso' },
      });
    });

    it('PUT subscription-status changes to any other situation with a reason (RN-02.11)', async () => {
      const body = await create();
      const canceled = await admin
        .call('put', `${API}/admin/organizations/${body.id}/subscription-status`, {
          status: 'canceled',
          reason: 'Encerrou a barraca',
        })
        .expect(200);
      expect(canceled.body).toMatchObject({
        subscriptionStatus: 'canceled',
        suspendedReason: 'Encerrou a barraca',
      });
      await admin
        .call('put', `${API}/admin/organizations/${body.id}/subscription-status`, {
          status: 'canceled',
          reason: 'De novo',
        })
        .expect(409);
      await admin
        .call('post', `${API}/admin/organizations/${body.id}/suspend`, { reason: 'Não dá' })
        .expect(409);
      await expect(
        platform.auditLog.count({
          where: { organizationId: body.id, action: 'organization.subscription_status_changed' },
        }),
      ).resolves.toBe(1);
    });
  });
});
