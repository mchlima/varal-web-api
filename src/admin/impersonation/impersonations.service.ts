import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service.js';
import {
  IMPERSONATION_HANDOFF_TTL_MS,
  IMPERSONATION_TTL_MS,
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

/** Ended, or past its 60 minutes even before the job marks it (CA-02.08). */
function toImpersonation(row: ImpersonationRow, now: Date): ImpersonationResponse {
  const expired = row.endedAt === null && row.expiresAt <= now;
  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationName: row.organization.name,
    platformAdminId: row.platformAdminId,
    adminName: row.platformAdmin.name,
    ownerId: row.ownerId,
    reason: row.reason,
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    endedAt: (row.endedAt ?? (expired ? row.expiresAt : null))?.toISOString() ?? null,
    endedBy: row.endedBy ?? (expired ? 'expired' : null),
    active: row.endedAt === null && !expired,
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

  /** RN-02.17: organization and reason; 60 minutes; returns the one-time link to the panel. */
  async start(
    adminId: string,
    input: { organizationId: string; reason: string },
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
          reason: input.reason,
          startedAt: now,
          expiresAt: new Date(now.getTime() + IMPERSONATION_TTL_MS),
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
          expiresAt: created.expiresAt.toISOString(),
        },
        metadata: { reason: input.reason },
      });
      return created;
    });
    return {
      impersonation: toImpersonation(row, now),
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
    now = new Date(),
  ): Promise<Page<ImpersonationResponse>> {
    const args = pageArgs(query, 'desc');
    const active = flagOf(query.active);
    const activeWhere: Prisma.ImpersonationSessionWhereInput = {
      endedAt: null,
      expiresAt: { gt: now },
    };
    const filters: Prisma.ImpersonationSessionWhereInput = {
      ...(query.organizationId === undefined ? {} : { organizationId: query.organizationId }),
      ...(flagOf(query.mine) === true ? { platformAdminId: adminId } : {}),
      ...(active === undefined ? {} : active ? activeWhere : { NOT: activeWhere }),
    };
    const rows = await this.platform.impersonationSession.findMany({
      ...args,
      where: { AND: [filters, args.where] },
      include: impersonationInclude,
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map((row) => toImpersonation(row, now)), nextCursor: page.nextCursor };
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
      if (current.endedAt !== null || current.expiresAt <= now) {
        throw adminError('IMPERSONATION_NOT_ACTIVE');
      }
      return this.impersonation.end(tx, id, 'admin', now);
    });
    result.notify();
    const row = await this.platform.impersonationSession.findUniqueOrThrow({
      where: { id },
      include: impersonationInclude,
    });
    return toImpersonation(row, now);
  }

  /** Job: marks the impersonations past their 60 minutes as `expired` (their sessions already stopped). */
  async endExpired(now = new Date()): Promise<number> {
    const due = await this.platform.impersonationSession.findMany({
      where: { endedAt: null, expiresAt: { lte: now } },
      select: { id: true },
      take: 100,
    });
    let count = 0;
    for (const { id } of due) {
      const result = await this.platform.$transaction((tx) =>
        this.impersonation.end(tx, id, 'expired', now),
      );
      if (result.ended) {
        result.notify();
        count++;
      }
    }
    return count;
  }
}
