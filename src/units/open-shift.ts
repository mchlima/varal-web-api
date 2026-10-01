import { Injectable } from '@nestjs/common';

import { requireOrganizationId } from '../context/request-context.js';
import type { TenantDb } from '../prisma/prisma.service.js';
import { setupError } from './setup-errors.js';

/**
 * Whether a unit has an open shift (RN-03.02, RN-03.07; CA-03.03), from `shifts` (spec 04).
 */
@Injectable()
export class OpenShiftChecker {
  async hasOpenShift(db: TenantDb, unitId: string): Promise<boolean> {
    return (await db.shift.count({ where: { unitId, status: 'open' } })) > 0;
  }

  /**
   * Throws `SHIFT_OPEN` (409) when the unit has an open shift. Call it in the transaction of the
   * change: it locks the unit row first, the same lock opening a shift takes (spec 04,
   * `ShiftsService.open`), so a shift never opens in the middle of a setup change.
   */
  async assertNoOpenShift(db: TenantDb, unitId: string): Promise<void> {
    // Raw SQL is not filtered by the tenant scope: the organization is added by hand.
    await db.$queryRaw`
      SELECT id FROM units WHERE id = ${unitId}::uuid AND organization_id = ${requireOrganizationId()}::uuid
      FOR UPDATE`;
    if (await this.hasOpenShift(db, unitId)) {
      throw setupError('SHIFT_OPEN');
    }
  }
}
