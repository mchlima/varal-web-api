import { Injectable } from '@nestjs/common';

import { getRequestContext } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import type { Session } from '../generated/prisma/client.js';
import { PlatformPrismaService } from '../prisma/platform-prisma.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { activeStationsOf, permittedStations } from '../units/permitted-stations.js';
import type { AdminMe, PanelMe } from './auth.schemas.js';
import { sessionInfoOf } from './session-cookies.js';

/**
 * `GET /auth/me` and `GET /admin/auth/me`. The panel profile reads through the tenant client
 * ({@link PrismaService}), so it can only ever see the organization of the token (CA-01.02).
 */
@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platform: PlatformPrismaService,
  ) {}

  async panelMe(session: Session, accessTokenExpiresAt: Date): Promise<PanelMe> {
    const auth = getRequestContext()?.auth;
    const organizationId = auth?.organizationId;
    if (!auth?.actor.id || !organizationId) {
      throw AppError.of('UNAUTHENTICATED');
    }
    const db = this.prisma.db;
    const organization = await db.organization.findUnique({ where: { id: organizationId } });
    if (!organization) {
      throw AppError.of('UNAUTHENTICATED');
    }
    const sessionInfo = sessionInfoOf({ session, accessTokenExpiresAt });
    const organizationInfo = {
      id: organization.id,
      name: organization.name,
      accessCode: organization.accessCode,
      subscriptionStatus: organization.subscriptionStatus,
    };

    if (auth.actor.type === 'owner') {
      const owner = await db.user.findUnique({ where: { id: auth.actor.id } });
      if (!owner?.active) {
        throw AppError.of('UNAUTHENTICATED');
      }
      const units = await db.unit.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
      const stations = await db.station.findMany({
        where: { unitId: { in: units.map((unit) => unit.id) }, active: true },
      });
      return {
        subject: {
          type: 'owner',
          id: owner.id,
          name: owner.name,
          email: owner.email,
          username: null,
        },
        organization: organizationInfo,
        // The owner opens any station and operates the cash of every unit.
        units: units.map((unit) => ({
          id: unit.id,
          name: unit.name,
          allStations: true,
          stationIds: [],
          stations: activeStationsOf(unit.id, stations),
          canOperateCash: true,
          lateAfterMinutes: unit.lateAfterMinutes,
        })),
        session: sessionInfo,
      };
    }

    if (auth.actor.type !== 'staff') {
      throw AppError.of('UNAUTHENTICATED');
    }
    const staff = await db.staffMember.findUnique({ where: { id: auth.actor.id } });
    if (!staff?.active) {
      throw AppError.of('UNAUTHENTICATED');
    }
    const permissions = await db.staffUnitPermission.findMany({
      where: { staffMemberId: staff.id, unit: { active: true } },
      include: { unit: { select: { id: true, name: true, lateAfterMinutes: true } } },
      orderBy: { unit: { name: 'asc' } },
    });
    const stations = await db.station.findMany({
      where: { id: { in: permissions.flatMap((permission) => permission.stationIds) } },
    });
    return {
      subject: {
        type: 'staff',
        id: staff.id,
        name: staff.name,
        email: staff.email,
        username: staff.username,
      },
      organization: organizationInfo,
      units: permissions.map((permission) => {
        const allowed = permittedStations(permission.unitId, permission.stationIds, stations);
        return {
          id: permission.unit.id,
          name: permission.unit.name,
          allStations: false,
          stationIds: allowed.map((station) => station.id),
          stations: allowed,
          canOperateCash: permission.canOperateCash,
          lateAfterMinutes: permission.unit.lateAfterMinutes,
        };
      }),
      session: sessionInfo,
    };
  }

  async adminMe(session: Session, accessTokenExpiresAt: Date): Promise<AdminMe> {
    const admin = await this.platform.platformAdmin.findUnique({
      where: { id: session.subjectId },
    });
    if (!admin?.active) {
      throw AppError.of('UNAUTHENTICATED');
    }
    return {
      admin: { id: admin.id, name: admin.name, email: admin.email },
      session: sessionInfoOf({ session, accessTokenExpiresAt }),
    };
  }

  /** `GET /auth/access-code/{code}`: name shown on the staff login screen, or 404 (spec 01, section 13). */
  async organizationNameByAccessCode(code: string): Promise<string> {
    const organization = await this.platform.organization.findUnique({
      where: { accessCode: code.trim().toUpperCase() },
      select: { name: true },
    });
    if (!organization) {
      throw AppError.of('NOT_FOUND', { message: 'Código do estabelecimento não encontrado.' });
    }
    return organization.name;
  }
}
