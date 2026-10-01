import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service.js';
import {
  IMPERSONATION_HANDOFF_TTL_MS,
  ImpersonationService,
} from '../../auth/impersonation.service.js';
import { hashToken, randomToken } from '../../auth/secure-token.js';
import { pageArgs, type Page, type PaginationQuery, toPage } from '../../common/pagination.js';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PlatformPrismaService } from '../../prisma/platform-prisma.service.js';
import { adminError } from '../admin-errors.js';
import { flagOf } from '../admin-schemas.js';
import type { ImpersonationResponse } from './impersonations.schemas.js';

const impersonationInclude = {
  organization: { select: { name: true } },
  platformAdmin: { select: { name: true } },
} as const satisfies Prisma.ImpersonationSessionInclude;

type ImpersonationRow = Prisma.ImpersonationSessionGetPayload<{
  include: typeof impersonationInclude;
}>;

/** An "entrar como" is active until the admin ends it (RN-02.17, CA-02.08). */
function toImpersonation(row: ImpersonationRow): ImpersonationResponse {
  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationName: row.organization.name,
    platformAdminId: row.platformAdminId,
    adminName: row.platformAdmin.name,
    ownerId: row.ownerId,
    reason: row.reason,
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    endedBy: row.endedBy,
    active: row.endedAt === null,
  };
}

/**
 * Admin side of the "entrar como" (spec 02, section 7): start, list and end. The panel side
 * (exchange of the one-time link for the panel session, banner, logout) is `ImpersonationService`
 * in src/auth, which also documents the whole flow.
 *
 * Decision of the project owner for the MVP: full access (RN-02.18), with `impersonation:use`, always
 * audited (`impersonation.*`) and listed to the owner (RN-02.22).
 */
@Injectable()
export class ImpersonationsService {
  constructor(
    @Inject(APP_ENV) private readonly env: Env,
    private readonly platform: PlatformPrismaService,
    private readonly impersonation: ImpersonationService,
    private readonly audit: AuditService,
  ) {}

  /**
   * RN-02.17: only the organization (the reason is optional, kept for compatibility); no deadline,
   * it lasts until the admin ends it. Returns the one-time link to the panel (2 minutes, RN-02.21).
   */
  async start(
    adminId: string,
    input: { organizationId: string; reason?: string | undefined },
    now = new Date(),
  ): Promise<{
    impersonation: ImpersonationResponse;
    handoffUrl: string;
    handoffExpiresAt: string;
  }> {
    const token = randomToken();
    const handoffExpiresAt = new Date(now.getTime() + IMPERSONATION_HANDOFF_TTL_MS);
    const row = await this.platform.$transaction(async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: input.organizationId },
        include: { users: { orderBy: { id: 'asc' }, take: 1 } },
      });
      if (!organization) {
        throw AppError.of('NOT_FOUND');
      }
      const owner = organization.users[0];
      if (!owner?.active) {
        throw adminError('ORGANIZATION_WITHOUT_OWNER');
      }
      const created = await tx.impersonationSession.create({
        data: {
          organizationId: organization.id,
          platformAdminId: adminId,
          ownerId: owner.id,
          reason: input.reason ?? null,
          startedAt: now,
          handoffTokenHash: hashToken(token),
          handoffExpiresAt,
        },
        include: impersonationInclude,
      });
      await this.audit.record(tx, {
        action: 'impersonation.started',
        entityType: 'impersonation_session',
        entityId: created.id,
        organizationId: organization.id,
        after: {
          ownerId: owner.id,
          startedAt: created.startedAt.toISOString(),
        },
        metadata: input.reason === undefined ? {} : { reason: input.reason },
      });
      return created;
    });
    return {
      impersonation: toImpersonation(row),
      handoffUrl: `${this.env.PANEL_URL}/entrar-como#token=${token}`,
      handoffExpiresAt: handoffExpiresAt.toISOString(),
    };
  }

  async list(
    adminId: string,
    query: PaginationQuery & {
      organizationId?: string | undefined;
      active?: 'true' | 'false' | undefined;
      mine?: 'true' | 'false' | undefined;
    },
  ): Promise<Page<ImpersonationResponse>> {
    const args = pageArgs(query, 'desc');
    const active = flagOf(query.active);
    const filters: Prisma.ImpersonationSessionWhereInput = {
      ...(query.organizationId === undefined ? {} : { organizationId: query.organizationId }),
      ...(flagOf(query.mine) === true ? { platformAdminId: adminId } : {}),
      ...(active === undefined ? {} : { endedAt: active ? null : { not: null } }),
    };
    const rows = await this.platform.impersonationSession.findMany({
      ...args,
      where: { AND: [filters, args.where] },
      include: impersonationInclude,
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toImpersonation), nextCursor: page.nextCursor };
  }

  /** Only the admin of the session ends it (spec 02, section 10); its panel sessions stop at once. */
  async end(adminId: string, id: string, now = new Date()): Promise<ImpersonationResponse> {
    const result = await this.platform.$transaction(async (tx) => {
      const current = await tx.impersonationSession.findUnique({ where: { id } });
      if (!current) {
        throw AppError.of('NOT_FOUND');
      }
      if (current.platformAdminId !== adminId) {
        throw AppError.of('FORBIDDEN', {
          message: 'Só o admin que abriu este acesso de suporte pode encerrá-lo.',
        });
      }
      if (current.endedAt !== null) {
        throw adminError('IMPERSONATION_NOT_ACTIVE');
      }
      return this.impersonation.end(tx, id, now);
    });
    result.notify();
    const row = await this.platform.impersonationSession.findUniqueOrThrow({
      where: { id },
      include: impersonationInclude,
    });
    return toImpersonation(row);
  }
}
