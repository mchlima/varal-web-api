import { requireOrganizationId } from '../context/request-context.js';
import { Prisma } from '../generated/prisma/client.js';
import type { TenantDb } from '../prisma/prisma.service.js';

/** Tables of the operation locked before a change (`SELECT … FOR UPDATE`). */
export type LockableTable = 'units' | 'shifts' | 'tabs' | 'order_items';

/**
 * Locks one row until the end of the transaction, so concurrent changes of the same shift, tab or
 * item run one after the other (CA-04.02, CA-04.05). Returns false when the row does not exist in
 * the organization.
 *
 * Raw SQL is not filtered by the tenant scope: the organization of the context is added by hand
 * (spec 01, section 6). The table name comes only from {@link LockableTable}.
 */
export async function lockRow(db: TenantDb, table: LockableTable, id: string): Promise<boolean> {
  const organizationId = requireOrganizationId();
  const rows = await db.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM ${Prisma.raw(`"${table}"`)}
      WHERE id = ${id}::uuid AND organization_id = ${organizationId}::uuid
      FOR UPDATE`,
  );
  return rows.length > 0;
}
