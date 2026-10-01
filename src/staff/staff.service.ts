import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import type { AuthDb } from '../auth/auth-db.js';
import type { SessionRevocationReason } from '../auth/auth-events.js';
import { AuthService } from '../auth/auth.service.js';
import { PasswordLinkService } from '../auth/password-link.service.js';
import { hashPassword } from '../auth/password-hasher.js';
import { type Page, type PaginationQuery, pageArgs, toPage } from '../common/pagination.js';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { requireOrganizationId } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';
import type { StaffMember } from '../generated/prisma/client.js';
import { PrismaService, type TenantDb } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { permittedStations } from '../units/permitted-stations.js';
import { setupError } from '../units/setup-errors.js';
import type { StaffMemberDto, StaffPasswordResetResponse } from './staff.schemas.js';

export interface PermissionInput {
  unitId: string;
  stationIds: string[];
  canOperateCash: boolean;
}

export interface CreateStaffInput {
  name: string;
  username: string;
  password: string;
  email?: string | null | undefined;
  permissions: PermissionInput[];
}

export interface UpdateStaffInput {
  name?: string | undefined;
  username?: string | undefined;
  email?: string | null | undefined;
  active?: boolean | undefined;
}

/**
 * Staff members of the organization (spec 03, section 6). Owner only.
 *
 * - CA-03.07: usernames are unique in the organization ignoring case (another organization may
 *   use the same one).
 * - RN-03.16: permissions per unit (stations and cash). `station_ids` accepts only active stations
 *   of that unit. Changing permissions makes the staff member's sockets reconnect with the new
 *   rooms at once (spec 01, section 10); removing every unit ends the sessions (no unit, no login).
 * - RN-03.17: deactivating ends every session at once (HTTP and WebSocket).
 * - RN-03.18 / RN-03.19: reset link (copy, WhatsApp, optional e-mail) or a password set directly.
 */
@Injectable()
export class StaffService {
  constructor(
    @Inject(APP_ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly links: PasswordLinkService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(query: PaginationQuery): Promise<Page<StaffMemberDto>> {
    const db = this.prisma.db;
    const rows = await db.staffMember.findMany(pageArgs(query));
    const page = toPage(rows, query.limit);
    return { data: await this.toDtos(db, page.data), nextCursor: page.nextCursor };
  }

  /** RN-03.15: name, username, initial password and optional e-mail. */
  async create(input: CreateStaffInput): Promise<StaffMemberDto> {
    const passwordHash = await hashPassword(input.password);
    return this.prisma.transaction(async (db) => {
      await this.assertUsernameFree(db, input.username, null);
      const staff = await db.staffMember.create({
        data: {
          organizationId: requireOrganizationId(),
          name: input.name,
          username: input.username,
          email: input.email ?? null,
          passwordHash,
        },
      });
      const permissions = await this.replacePermissions(db, staff.id, input.permissions);
      await this.audit.record(db, {
        action: 'staff_member.created',
        entityType: 'staff_member',
        entityId: staff.id,
        after: { ...audited(staff), passwordHash: staff.passwordHash, permissions },
      });
      return this.toDto(db, staff);
    });
  }

  async update(staffId: string, input: UpdateStaffInput): Promise<StaffMemberDto> {
    return this.prisma.transaction(async (db) => {
      const current = await this.find(db, staffId);
      if (
        input.username !== undefined &&
        input.username.toLowerCase() !== current.username.toLowerCase()
      ) {
        await this.assertUsernameFree(db, input.username, staffId);
      }
      const staff = await db.staffMember.update({
        where: { id: staffId },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.username === undefined ? {} : { username: input.username }),
          ...(input.email === undefined ? {} : { email: input.email }),
          ...(input.active === undefined ? {} : { active: input.active }),
        },
      });
      await this.audit.record(db, {
        action: 'staff_member.updated',
        entityType: 'staff_member',
        entityId: staffId,
        before: audited(current),
        after: audited(staff),
      });
      if (current.active && !staff.active) {
        // RN-03.17 (spec 01, section 7.2): every session ends now, the sockets get session.revoked.
        await this.revokeSessions(db, staffId, 'staff_deactivated');
      }
      return this.toDto(db, staff);
    });
  }

  /** `PUT /staff/{id}/permissions`: replaces every unit permission (RN-03.16). */
  async setPermissions(staffId: string, units: PermissionInput[]): Promise<StaffMemberDto> {
    return this.prisma.transaction(async (db) => {
      const staff = await this.find(db, staffId);
      const before = await this.permissionsOf(db, staffId);
      const after = await this.replacePermissions(db, staffId, units);
      await this.audit.record(db, {
        action: 'staff_member.permissions_updated',
        entityType: 'staff_member',
        entityId: staffId,
        before: { permissions: before },
        after: { permissions: after },
      });
      if (after.length === 0) {
        await this.revokeSessions(db, staffId, 'staff_access_removed');
      } else {
        // Spec 01, section 10: the new rooms apply at once (the session stays valid).
        this.realtime.refreshAccess(
          { subjects: [{ type: 'staff', id: staffId }] },
          'permissions_changed',
        );
      }
      return this.toDto(db, staff);
    });
  }

  /**
   * RN-03.18: a one-hour, single-use reset link (CA-03.08) to copy or send by WhatsApp, also
   * e-mailed when asked and the staff member has an address. RN-01.02: at most 3 per hour.
   */
  async issuePasswordReset(
    staffId: string,
    options: { sendEmail: boolean },
  ): Promise<StaffPasswordResetResponse> {
    const staff = await this.find(this.prisma.db, staffId);
    const issued = await this.links.issueStaffPasswordReset(staffId, options);
    const message =
      `Olá, ${staff.name}! Use este link para definir sua nova senha no Varal ` +
      `(vale por 1 hora e funciona uma vez): ${issued.link}`;
    return {
      link: issued.link,
      expiresAt: issued.expiresAt.toISOString(),
      emailSent: issued.emailLogId !== null,
      whatsappUrl: `https://wa.me/?text=${encodeURIComponent(message)}`,
    };
  }

  /** RN-03.19: the owner sets the password directly; every session of the staff member ends. */
  async setPassword(staffId: string, password: string): Promise<void> {
    const passwordHash = await hashPassword(password);
    await this.prisma.transaction(async (db) => {
      const current = await this.find(db, staffId);
      await db.staffMember.update({ where: { id: staffId }, data: { passwordHash } });
      await this.audit.record(db, {
        action: 'staff_member.password_set',
        entityType: 'staff_member',
        entityId: staffId,
        before: { passwordHash: current.passwordHash },
        after: { passwordHash },
      });
      await this.revokeSessions(db, staffId, 'password_reset');
    });
  }

  /** `GET /organization/access`: code, link `/e/{code}` (spec 01, section 7.1). */
  async organizationAccess(): Promise<{ accessCode: string; link: string }> {
    const organization = await this.prisma.db.organization.findUnique({
      where: { id: requireOrganizationId() },
      select: { accessCode: true },
    });
    if (!organization) {
      throw AppError.of('NOT_FOUND');
    }
    return {
      accessCode: organization.accessCode,
      link: `${this.env.PANEL_URL}/e/${organization.accessCode}`,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------------------------

  private async find(db: TenantDb, staffId: string): Promise<StaffMember> {
    const staff = await db.staffMember.findUnique({ where: { id: staffId } });
    if (!staff) {
      throw AppError.of('NOT_FOUND');
    }
    return staff;
  }

  /** Revokes in the transaction; sockets get `session.revoked` once it commits. */
  private async revokeSessions(
    db: TenantDb,
    staffId: string,
    reason: SessionRevocationReason,
  ): Promise<void> {
    // `sessions` is not a tenant table: the tenant transaction reaches it unfiltered, and
    // `revokeSessionsInTransaction` filters by subject and organization by hand.
    const { notify } = await this.auth.revokeSessionsInTransaction(
      db as unknown as AuthDb,
      { subjectType: 'staff', subjectId: staffId, organizationId: requireOrganizationId() },
      reason,
    );
    this.prisma.afterCommit(notify);
  }

  private async assertUsernameFree(
    db: TenantDb,
    username: string,
    exceptId: string | null,
  ): Promise<void> {
    // Unique by (organization_id, lower(username)) (CA-03.07); the tenant scope adds the organization.
    const taken = await db.staffMember.count({
      where: {
        username: { equals: username, mode: 'insensitive' },
        ...(exceptId === null ? {} : { id: { not: exceptId } }),
      },
    });
    if (taken > 0) {
      throw setupError('USERNAME_TAKEN');
    }
  }

  /**
   * Validates and writes the permissions of a staff member: units of the organization, each once,
   * with active stations of that same unit. Returns them as stored (for the audit).
   */
  private async replacePermissions(
    db: TenantDb,
    staffId: string,
    units: PermissionInput[],
  ): Promise<PermissionInput[]> {
    const normalized = units.map((unit) => ({
      unitId: unit.unitId.toLowerCase(),
      stationIds: [...new Set(unit.stationIds.map((id) => id.toLowerCase()))],
      canOperateCash: unit.canOperateCash,
    }));
    const unitIds = normalized.map((unit) => unit.unitId);
    if (new Set(unitIds).size !== unitIds.length) {
      throw setupError('INVALID_REFERENCE', { reason: 'duplicate_unit' });
    }
    const found = await db.unit.count({ where: { id: { in: unitIds } } });
    if (found !== unitIds.length) {
      throw setupError('INVALID_REFERENCE', { reason: 'unit_not_found' });
    }
    const stationIds = normalized.flatMap((unit) => unit.stationIds);
    const stations = await db.station.findMany({
      where: { id: { in: stationIds }, active: true },
      select: { id: true, unitId: true },
    });
    const stationUnit = new Map(stations.map((station) => [station.id, station.unitId]));
    for (const unit of normalized) {
      const invalid = unit.stationIds.filter((id) => stationUnit.get(id) !== unit.unitId);
      if (invalid.length > 0) {
        throw setupError('INVALID_REFERENCE', {
          reason: 'station_not_in_unit',
          unitId: unit.unitId,
          stationIds: invalid,
        });
      }
    }

    await db.staffUnitPermission.deleteMany({
      where: { staffMemberId: staffId, unitId: { notIn: unitIds } },
    });
    for (const unit of normalized) {
      await db.staffUnitPermission.upsert({
        where: { staffMemberId_unitId: { staffMemberId: staffId, unitId: unit.unitId } },
        create: {
          organizationId: requireOrganizationId(),
          staffMemberId: staffId,
          unitId: unit.unitId,
          stationIds: unit.stationIds,
          canOperateCash: unit.canOperateCash,
        },
        update: { stationIds: unit.stationIds, canOperateCash: unit.canOperateCash },
      });
    }
    return normalized;
  }

  private async permissionsOf(db: TenantDb, staffId: string): Promise<PermissionInput[]> {
    const rows = await db.staffUnitPermission.findMany({
      where: { staffMemberId: staffId },
      orderBy: { unitId: 'asc' },
    });
    return rows.map((row) => ({
      unitId: row.unitId,
      stationIds: row.stationIds,
      canOperateCash: row.canOperateCash,
    }));
  }

  private async toDto(db: TenantDb, staff: StaffMember): Promise<StaffMemberDto> {
    const [dto] = await this.toDtos(db, [staff]);
    if (!dto) {
      throw AppError.of('NOT_FOUND');
    }
    return dto;
  }

  private async toDtos(db: TenantDb, staff: StaffMember[]): Promise<StaffMemberDto[]> {
    const permissions = await db.staffUnitPermission.findMany({
      where: { staffMemberId: { in: staff.map((member) => member.id) } },
      include: { unit: { select: { name: true } } },
      orderBy: { unit: { name: 'asc' } },
    });
    const stations = await db.station.findMany({
      where: { unitId: { in: [...new Set(permissions.map((p) => p.unitId))] } },
    });
    return staff.map((member) => ({
      id: member.id,
      name: member.name,
      username: member.username,
      email: member.email,
      active: member.active,
      hasPassword: member.passwordHash !== null,
      permissions: permissions
        .filter((permission) => permission.staffMemberId === member.id)
        .map((permission) => {
          const summaries = permittedStations(permission.unitId, permission.stationIds, stations);
          return {
            unitId: permission.unitId,
            unitName: permission.unit.name,
            stationIds: summaries.map((station) => station.id),
            stations: summaries,
            canOperateCash: permission.canOperateCash,
          };
        }),
    }));
  }
}

function audited(staff: StaffMember): Record<string, unknown> {
  return {
    name: staff.name,
    username: staff.username,
    email: staff.email,
    active: staff.active,
  };
}
