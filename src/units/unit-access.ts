import {
  applyDecorators,
  type CanActivate,
  Injectable,
  type PipeTransform,
  UseGuards,
} from '@nestjs/common';
import { ApiForbiddenResponse, ApiNotFoundResponse } from '@nestjs/swagger';
import { z } from 'zod';

import { PanelAuth } from '../auth/auth.decorators.js';
import { type Actor, getRequestContext } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import { ErrorResponseSchema } from '../errors/error-response.schema.js';
import type { StaffUnitPermission, Unit } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** The logged-in owner or staff member of the request (panel routes). */
export function panelActor(): Actor & { type: 'owner' | 'staff'; id: string } {
  const actor = getRequestContext()?.auth?.actor;
  if (!actor?.id || (actor.type !== 'owner' && actor.type !== 'staff')) {
    throw AppError.of('UNAUTHENTICATED');
  }
  return { type: actor.type, id: actor.id };
}

/** Spec 03, section 8: "Todas exigem perfil dono, exceto onde indicado". */
@Injectable()
export class OwnerGuard implements CanActivate {
  canActivate(): boolean {
    if (panelActor().type !== 'owner') {
      throw AppError.of('FORBIDDEN', { message: 'Só o dono da barraca pode fazer isso.' });
    }
    return true;
  }
}

/** Route of the owner's panel: panel session of an owner; staff get 403 `FORBIDDEN`. */
export function OwnerOnly(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    PanelAuth(),
    UseGuards(OwnerGuard),
    ApiForbiddenResponse({
      description: '`FORBIDDEN`: só o dono pode usar esta rota.',
      standardSchema: ErrorResponseSchema,
    }),
  );
}

/** Documents the 404 of a route with an id (missing or of another organization, CA-01.02). */
export function NotFoundResponse(): MethodDecorator {
  return ApiNotFoundResponse({
    description: '`NOT_FOUND`: não existe ou é de outra organização.',
    standardSchema: ErrorResponseSchema,
  });
}

const uuidSchema = z.uuid();

/**
 * Path id: a UUID, lowercased. Anything else is a 404, the same answer as a missing id (the
 * database would otherwise reject the value with a 500).
 */
@Injectable()
export class IdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const parsed = uuidSchema.safeParse(value);
    if (!parsed.success) {
      throw AppError.of('NOT_FOUND');
    }
    return parsed.data.toLowerCase();
  }
}

export interface UnitAccess {
  unit: Unit;
  actor: { type: 'owner' | 'staff'; id: string };
  /** The staff member's permission in the unit; null for the owner. */
  permission: StaffUnitPermission | null;
}

/**
 * Who may read or operate a unit (spec 03; RN-03.11, RN-03.16). Reads go through the tenant client:
 * a unit of another organization is a 404 (CA-01.02); a unit of the organization without access is
 * a 403.
 */
@Injectable()
export class UnitAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The unit for its staff members and the owner (`GET /units/{id}/menu`): owners any unit of the
   * organization; staff only an active unit of their permissions.
   */
  async forMember(unitId: string): Promise<UnitAccess> {
    const actor = panelActor();
    const unit = await this.prisma.db.unit.findUnique({ where: { id: unitId } });
    if (!unit) {
      throw AppError.of('NOT_FOUND');
    }
    if (actor.type === 'owner') {
      return { unit, actor, permission: null };
    }
    const permission = await this.prisma.db.staffUnitPermission.findUnique({
      where: { staffMemberId_unitId: { staffMemberId: actor.id, unitId } },
    });
    if (!permission || !unit.active) {
      throw AppError.of('FORBIDDEN', { message: 'Você não tem acesso a esta unidade.' });
    }
    return { unit, actor, permission };
  }

  /**
   * RN-03.11: marking sold out is for the owner and for staff with access to at least one active
   * station of the unit.
   */
  async forStationMember(unitId: string): Promise<UnitAccess> {
    const access = await this.forMember(unitId);
    if (access.permission === null) {
      return access;
    }
    const stations = await this.prisma.db.station.count({
      where: { unitId, active: true, id: { in: access.permission.stationIds } },
    });
    if (stations === 0) {
      throw AppError.of('FORBIDDEN', {
        message: 'Você precisa ter acesso a uma estação desta unidade.',
      });
    }
    return access;
  }
}
