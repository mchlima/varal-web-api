import { Injectable } from '@nestjs/common';

import { getRequestContext } from '../context/request-context.js';
import type { Prisma } from '../generated/prisma/client.js';
import { diffChanges } from './changes.js';

type Row = Record<string, unknown>;

export interface AuditEntry {
  /** `<entity>.<verb>` in English, e.g. `tab.discount_applied`, `order_item.canceled`. */
  action: string;
  /** snake_case entity name, e.g. `tab`, `staff_member`. */
  entityType: string;
  entityId?: string | null;
  /** State before the action (`null`/omitted on creation). Only changed fields are stored. */
  before?: Row | null;
  /** State after the action (`null`/omitted on removal). Only changed fields are stored. */
  after?: Row | null;
  /** Extra facts of the action that are not entity fields, e.g. the reason of a cancellation. */
  metadata?: Row;
  /**
   * Organization of the action. Defaults to the organization of the context. Platform admins set it
   * when acting on an organization; it must match the context when the context has one.
   */
  organizationId?: string | null;
}

/** Anything that can insert into `audit_logs`: a transaction of the tenant or of the platform client. */
export interface AuditWriter {
  auditLog: {
    create(args: { data: Prisma.AuditLogUncheckedCreateInput }): PromiseLike<unknown>;
  };
}

export class AuditError extends Error {
  override name = 'AuditError';
}

/**
 * Writes the audit log (spec 01, section 8; CA-01.08).
 *
 * - Always called with the transaction of the action (`tx`), so the action and its audit row commit
 *   or roll back together.
 * - Actor, "entrar como" admin (`impersonator_id`, RN-02.20), device, IP and request id come from the
 *   request context; outside a request the actor is `system`.
 * - Insert-only: there is no method to change or remove entries, and a database trigger rejects
 *   UPDATE and DELETE on `audit_logs`.
 */
@Injectable()
export class AuditService {
  async record(tx: AuditWriter, entry: AuditEntry): Promise<void> {
    const context = getRequestContext();
    const auth = context?.auth ?? null;
    const contextOrganizationId = auth?.organizationId ?? null;
    if (
      entry.organizationId !== undefined &&
      contextOrganizationId !== null &&
      entry.organizationId !== contextOrganizationId
    ) {
      throw new AuditError('Audit entry for another organization than the request context');
    }

    const { before, after } = diffChanges(entry.before ?? null, entry.after ?? null);
    const changes: Prisma.InputJsonObject = {
      before: before as Prisma.InputJsonObject | null,
      after: after as Prisma.InputJsonObject | null,
      ...(entry.metadata ? { metadata: entry.metadata as Prisma.InputJsonObject } : {}),
    };

    await tx.auditLog.create({
      data: {
        organizationId: entry.organizationId ?? contextOrganizationId,
        actorType: auth?.actor.type ?? 'system',
        actorId: auth?.actor.id ?? null,
        impersonatorId: auth?.impersonatorId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        changes,
        deviceId: context?.deviceId ?? null,
        ip: context?.ip ?? null,
        requestId: context?.requestId ?? null,
      },
    });
  }
}
